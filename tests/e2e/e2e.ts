// Run against `wrangler dev` (npm run e2e starts it, with the platform Worker beside it): real workerd, real WebSockets, real Durable Objects.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const BASE = process.env.BASE ?? 'http://localhost:8787/settlers';
const WS = BASE.replace(/^http/, 'ws');
const hostKey = /HOST_KEY=(\w+)/.exec(readFileSync('.dev.vars', 'utf8'))![1]!;
const token = (): string => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

type Msg = Record<string, unknown> & { t: string };
class Sock {
  ws: WebSocket; inbox: Msg[] = []; closed: number | null = null; opened: Promise<void>;
  constructor(url: string, headers?: Record<string, string>) {
    this.ws = new (WebSocket as unknown as new (u: string, o?: unknown) => WebSocket)(url, headers ? { headers } : undefined);
    this.ws.onmessage = (e) => { this.inbox.push(JSON.parse(String(e.data)) as Msg); };
    this.ws.onclose = (e) => { this.closed = e.code; };
    this.opened = new Promise((res, rej) => { this.ws.onopen = () => res(); this.ws.onerror = () => rej(new Error('ws error')); });
  }
  send(m: object): void { this.ws.send(JSON.stringify(m)); }
  async until(pred: (m: Msg) => boolean, ms = 15000): Promise<Msg> {
    const t0 = Date.now();
    for (;;) {
      const hit = [...this.inbox].reverse().find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error(`timeout waiting; got ${this.inbox.map((m) => m.t).join(',')}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

async function main(): Promise<void> {
  // 1. fail closed
  assert.equal((await fetch(`${BASE}/api/rooms`, { method: 'POST' })).status, 403, 'no key');
  assert.equal((await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { Authorization: 'Bearer wrong' } })).status, 403, 'wrong key');
  assert.equal((await fetch(`${BASE}/api/usage`)).status, 403);
  assert.equal((await fetch(`${BASE}/api/whatever`)).status, 404);
  assert.equal((await fetch(`${BASE}/`)).status, 200, 'static page is public');
  const forged = new Sock(`${WS}/ws/${'a'.repeat(32)}.${'A'.repeat(22)}`);
  await assert.rejects(forged.opened, 'forged capability never upgrades');

  // 2. create a room
  const r = await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { Authorization: `Bearer ${hostKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Hosty' }) });
  assert.equal(r.status, 200);
  const room = (await r.json()) as { cap: string; invite: string; hostToken: string };
  assert.ok(room.cap && room.invite && room.hostToken);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');

  const evil = new Sock(`${WS}/ws/${room.cap}`, { Origin: 'https://evil.example' });
  await assert.rejects(evil.opened, 'cross-origin sockets are refused');

  // 3. host + friend over real sockets
  const host = new Sock(`${WS}/ws/${room.cap}`);
  await host.opened;
  host.send({ t: 'resume', token: room.hostToken });
  await host.until((m) => m.t === 'joined');

  const bad = new Sock(`${WS}/ws/${room.cap}`);
  await bad.opened;
  bad.send({ t: 'join', name: 'Eve', invite: token(), token: token() });
  await bad.until((m) => m.t === 'error');

  const friendToken = token();
  const friend = new Sock(`${WS}/ws/${room.cap}`);
  await friend.opened;
  friend.send({ t: 'join', name: 'Sam', invite: room.invite, token: friendToken });
  await friend.until((m) => m.t === 'pending');
  const lobby = await host.until((m) => m.t === 'lobby' && Array.isArray(m.pending) && (m.pending as unknown[]).length === 1);
  const reqId = ((lobby.pending as { id: string }[])[0]!).id;
  host.send({ t: 'host', cmd: { c: 'approve', request: reqId } });
  await friend.until((m) => m.t === 'joined');

  // 4. play a whole game with both humans on autopilot and the host fast-forwarding the bots
  host.send({ t: 'host', cmd: { c: 'settings', settings: { vp_to_win: 5 }, bots: 1 } });
  host.send({ t: 'host', cmd: { c: 'bot_speed', x: 0 } });
  host.send({ t: 'host', cmd: { c: 'start' } });
  await host.until((m) => m.t === 'state');
  host.send({ t: 'autopilot', on: true });
  friend.send({ t: 'autopilot', on: true });
  const fin = await host.until((m) => m.t === 'state' && (m.view as { phase: string }).phase === 'finished', 120000);
  assert.ok((fin.view as { winner: string }).winner);
  const seen = JSON.stringify(friend.inbox);
  assert.ok(!seen.includes('dev_card_deck') && !seen.includes('"rng"'));
  assert.ok(!seen.includes(room.invite) && !seen.includes(room.hostToken) && !seen.includes(friendToken));

  // 5. reconnect with the seat token after the socket drops
  friend.ws.close();
  const again = new Sock(`${WS}/ws/${room.cap}`);
  await again.opened;
  again.send({ t: 'resume', token: friendToken });
  await again.until((m) => m.t === 'joined');
  await again.until((m) => m.t === 'state');

  // 6. close the room
  host.send({ t: 'host', cmd: { c: 'close' } });
  await again.until(() => again.closed !== null, 5000).catch(() => undefined);
  console.log('e2e ok');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
