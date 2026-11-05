import { verifyAccess, type AuthDeps, type Identity } from './auth';
import type { HostConfig } from './config';
import { meter, OBJECT_URL, PLAYER_HEADER, type Env } from './env';
import { deny, json, secured } from './headers';
import type { UsageResponse } from './protocol';
import { gameById, site } from './registry';
import { UsageTally } from './usageCore';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OBJECT_ID = /^[0-9a-f]{64}$/;

export interface RouterDeps extends AuthDeps {
  host: HostConfig;
  /** Lets work (usage flushes) outlive the response. */
  waitUntil: (p: Promise<unknown>) => void;
  /** Per-isolate tally of Worker requests, flushed to the meter in batches. */
  tally: UsageTally;
  /** The last usage report this isolate saw (for the hard stop), with when. */
  lastReport: { report: UsageResponse; atMs: number } | null;
}

/** Read at most `max` bytes of the body; `null` if it's longer (checked before anything parses it). */
async function readLimited(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** A fresh request to an object, carrying only what the Worker vouches for. */
function toObject(path: string, who: Identity, init: { method: string; body?: string; headers?: Record<string, string> } = { method: 'GET' }): Request {
  return new Request(`${OBJECT_URL}${path}`, { method: init.method, body: init.body ?? null, headers: { ...init.headers, [PLAYER_HEADER]: who.email } });
}

async function usageReport(env: Env, deps: RouterDeps, nowMs: number): Promise<UsageResponse> {
  const delta = deps.tally.due(nowMs, true);
  const res = delta ? await meter(env).fetch(`${OBJECT_URL}/add`, { method: 'POST', body: JSON.stringify(delta) }) : await meter(env).fetch(`${OBJECT_URL}/report`);
  const report = (await res.json()) as UsageResponse;
  deps.lastReport = { report, atMs: nowMs };
  return report;
}

/** Refuse new rooms and runs once the day's budget is nearly spent (uses a recent report when there is one). */
async function overBudget(env: Env, deps: RouterDeps, nowMs: number): Promise<boolean> {
  const last = deps.lastReport;
  const report = last && nowMs - last.atMs < deps.host.usageFlushMs ? last.report : await usageReport(env, deps, nowMs);
  return report.hardStop;
}

/**
 * Every request: verify Access first (fail closed), then route. Nothing,
 * not even the static client, is served to an unverified request.
 */
export async function route(request: Request, env: Env, deps: RouterDeps): Promise<Response> {
  const nowMs = deps.nowS() * 1000;
  deps.tally.add({ workerRequests: 1 });
  const who = await verifyAccess(request, env, deps);
  if (!who) return deny(403);

  const delta = deps.tally.due(nowMs);
  if (delta) deps.waitUntil(meter(env).fetch(`${OBJECT_URL}/add`, { method: 'POST', body: JSON.stringify(delta) }).then(() => undefined, () => undefined));

  const url = new URL(request.url);
  // Each app is its own Worker on its own path of the shared hostname (`/<id>/…`).
  const base = site().basePath;
  let path = url.pathname;
  if (path.includes('//')) return deny(404);
  if (base) {
    if (path === base) return secured(Response.redirect(`${url.origin}${base}/${url.search}`, 308));
    if (!path.startsWith(`${base}/`)) return deny(404);
    path = path.slice(base.length);
  }
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'api') {
    if (request.method !== 'GET' && request.method !== 'HEAD') return deny(405);
    // The built client sits at the root of the assets folder; serve it as if the base path weren't there.
    const assetUrl = new URL(url.origin);
    assetUrl.pathname = path;
    assetUrl.search = url.search;
    const res = await env.ASSETS.fetch(new Request(assetUrl, request));
    // Static assets redirect directory-style paths (e.g. /index.html → /); put the base path back
    // so the browser stays in this app instead of landing on the platform index.
    const location = res.headers.get('Location');
    if (base && res.status >= 300 && res.status < 400 && location?.startsWith('/') && !location.startsWith('//')) {
      const out = new Response(res.body, res);
      out.headers.set('Location', `${base}${location}`);
      return secured(out);
    }
    return secured(res);
  }

  const [, area, a, b, c] = parts;
  const method = request.method;

  if (area === 'usage' && parts.length === 2) {
    if (method !== 'GET') return deny(405);
    return json(await usageReport(env, deps, nowMs));
  }

  if (area === 'solo' && a) {
    const game = gameById(a);
    if (!game?.solo) return deny(404);
    if (b === 'start' && parts.length === 4) {
      if (method !== 'POST') return deny(405);
      if (await overBudget(env, deps, nowMs)) return json({ ok: false, code: 'over_budget' }, 503);
      const stub = env.RUNS.get(env.RUNS.newUniqueId());
      return secured(await stub.fetch(toObject('/start', who, { method: 'POST', body: game.id })));
    }
    if (b === 'scores' && parts.length === 4) {
      if (method !== 'GET') return deny(405);
      const board = env.SCORES.get(env.SCORES.idFromName(game.id));
      return secured(await board.fetch(toObject('/list', who)));
    }
    if (b && OBJECT_ID.test(b) && c === 'segment' && parts.length === 5) {
      if (method !== 'POST') return deny(405);
      const body = await readLimited(request, game.solo.maxSegmentBytes);
      if (body === null) return deny(413);
      const stub = env.RUNS.get(env.RUNS.idFromString(b));
      return secured(await stub.fetch(toObject('/segment', who, { method: 'POST', body })));
    }
    return deny(404);
  }

  if (area === 'rooms' && a) {
    if (parts.length === 3 && gameById(a)) {
      if (method !== 'POST') return deny(405);
      if (await overBudget(env, deps, nowMs)) return json({ ok: false, code: 'over_budget' }, 503);
      const roomId = crypto.randomUUID();
      const res = await env.ROOMS.get(env.ROOMS.idFromName(roomId)).fetch(toObject('/init', who, { method: 'POST', body: a }));
      return res.ok ? json({ roomId }) : deny(409);
    }
    if (UUID.test(a) && b === 'ws' && parts.length === 4) {
      if (method !== 'GET' || request.headers.get('Upgrade') !== 'websocket') return deny(426);
      return env.ROOMS.get(env.ROOMS.idFromName(a)).fetch(toObject('/ws', who, { method: 'GET', headers: { Upgrade: 'websocket' } }));
    }
    return deny(404);
  }

  return deny(404);
}
