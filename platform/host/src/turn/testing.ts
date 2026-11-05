/**
 * A fake network around `RoomCore` for tests: connections, delivery and a
 * controllable clock, all in memory. Apps use it to test their game in a real
 * room (joins, approvals, bots, timers, hidden information) without Cloudflare.
 */
import type { HostConfig } from './config.ts';
import { newToken, sha256Hex } from './crypto.ts';
import type { ErasedGame } from './game.ts';
import { ProfilesCore } from './profiles_core.ts';
import type { S2C } from './protocol.ts';
import { RoomCore, Out } from './room_core.ts';
import { MemoryStore } from './services.ts';
import { UsageCore } from './usage_core.ts';

export class Client {
  id: string;
  inbox: S2C[] = [];
  closed: { code: number; reason: string } | null = null;
  token = newToken();
  seat: string | null = null;
  push: ((m: S2C) => void) | null = null;
  onClose: ((code: number) => void) | null = null;
  net: Net;
  constructor(net: Net, id: string) { this.net = net; this.id = id; }
  async send(msg: object | string): Promise<void> { await this.net.deliver(this.id, typeof msg === 'string' ? msg : JSON.stringify(msg)); }
  last<T extends S2C['t']>(t: T): Extract<S2C, { t: T }> | undefined { return [...this.inbox].reverse().find((m): m is Extract<S2C, { t: T }> => m.t === t); }
  all<T extends S2C['t']>(t: T): Extract<S2C, { t: T }>[] { return this.inbox.filter((m): m is Extract<S2C, { t: T }> => m.t === t); }
  errors(): string[] { return this.all('error').map((e) => e.code); }
}

export class Net {
  core!: RoomCore;
  now = 1_000_000;
  clients = new Map<string, Client>();
  seq = 0;
  invite = newToken();
  hostToken = newToken();
  profiles = new ProfilesCore(new MemoryStore(), () => this.now);
  usage = new UsageCore(new MemoryStore(), () => this.now);
  everySent: string[] = [];

  static async make(game: ErasedGame, host?: HostConfig, profiles?: ProfilesCore): Promise<Net> {
    const net = new Net();
    if (profiles) net.profiles = profiles;
    net.core = await RoomCore.create(
      { store: new MemoryStore(), game, profiles: net.profiles, usage: net.usage, ...(host ? { host } : {}) },
      { roomId: 'a'.repeat(32), now: net.now, hostName: 'Hosty', hostTokenHash: await sha256Hex(net.hostToken), inviteHash: await sha256Hex(net.invite) },
    );
    return net;
  }

  connect(): Client {
    const id = `c${++this.seq}`;
    const c = new Client(this, id);
    this.clients.set(id, c);
    this.core.connect(id, undefined, this.now);
    return c;
  }

  async deliver(id: string, raw: string): Promise<void> { this.flush(await this.core.message(id, raw, this.now)); }

  flush(out: Out): void {
    for (const s of out.sends) { this.everySent.push(JSON.stringify(s.msg)); const cl = this.clients.get(s.to); cl?.inbox.push(s.msg); cl?.push?.(s.msg); }
    for (const c of out.closes) {
      const cl = this.clients.get(c.to);
      if (cl && !cl.closed) { cl.closed = { code: c.code, reason: c.reason }; void this.core.close(c.to, this.now); cl.onClose?.(c.code); }
    }
  }

  async host(): Promise<Client> {
    const c = this.connect();
    c.token = this.hostToken;
    await c.send({ t: 'resume', token: c.token });
    c.seat = c.last('joined')!.seat;
    return c;
  }

  /** Friend opens the shared link, asks to join, host approves. */
  async friend(host: Client, name: string): Promise<Client> {
    const c = this.connect();
    await c.send({ t: 'join', name, invite: this.invite, token: c.token });
    const req = host.last('lobby')!.pending!.find((p) => p.name === name || p.id === c.last('pending') as unknown as string)!;
    await host.send({ t: 'host', cmd: { c: 'approve', request: req.id } });
    c.seat = c.last('joined')!.seat;
    return c;
  }

  async alarm(): Promise<boolean> {
    const next = this.core.nextAlarm(this.now);
    if (next === null) return false;
    this.now = Math.max(this.now, next);
    const { out, dead } = await this.core.alarm(this.now);
    this.flush(out);
    return !dead;
  }
}

/** A WebSocket-shaped object wired straight into the in-memory room (what WsTransport talks to in tests). */
export class LoopbackSocket {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  client: Client;
  constructor(net: Net) {
    this.client = net.connect();
    this.client.push = (m) => { setTimeout(() => this.onmessage?.({ data: JSON.stringify(m) }), 0); };
    this.client.onClose = (code) => { setTimeout(() => this.onclose?.({ code }), 0); };
    setTimeout(() => this.onopen?.(), 0);
  }
  send(data: string): void { void this.client.send(data); }
  close(code = 1000): void { if (!this.client.closed) { this.client.closed = { code, reason: 'client' }; void this.client.net.core.close(this.client.id, this.client.net.now); setTimeout(() => this.onclose?.({ code }), 0); } }
}
