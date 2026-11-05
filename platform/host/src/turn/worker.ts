/**
 * The Worker for an invite-mode app: friends play through links, with no
 * login. Every request fails closed:
 *
 * - `POST <base>/api/rooms` and `GET <base>/api/usage` need the host key
 *   (`Authorization: Bearer …`, compared in constant time). Only the owner
 *   creates rooms.
 * - `GET <base>/ws/<cap>` needs a room capability: the room id plus an HMAC
 *   under the host key, so forged or guessed ids are refused before any
 *   Durable Object is touched. The room then admits a seat only with the
 *   invite secret (from the link's #fragment, never sent in a URL) and the
 *   host's approval, or with a seat token it issued earlier.
 * - A foreign page can't drive a visitor's socket: a WebSocket `Origin` must
 *   be this site.
 * - Everything else is the static client (GET/HEAD only), with the strict
 *   security headers. Nothing is listable; there is no other route.
 * - No host key, or a short one, refuses everything (503).
 */
import { OBJECT_URL } from '../env.ts';
import { deny, json, secured } from '../headers.ts';
import { UsageTally } from '../usageCore.ts';
import { turnConfig } from './config.ts';
import { newToken, randomHex, safeEqual, sanitizeName, sha256Hex, signRoomId, verifyRoomCap } from './crypto.ts';
import type { TurnEnv } from './env.ts';
import { sharedMeter } from './meter.ts';
import { defaultTurnGame, turnBasePath, turnGame } from './registry.ts';

const CAP_PATH = /^\/ws\/([0-9a-f]{32}\.[A-Za-z0-9_-]{22})$/;

async function hostAuthorized(request: Request, env: TurnEnv): Promise<boolean> {
  const m = /^Bearer (.{1,200})$/.exec(request.headers.get('Authorization') ?? '');
  return !!m && (await safeEqual(m[1]!, env.HOST_KEY));
}

async function createRoom(request: Request, env: TurnEnv): Promise<Response> {
  if (!(await hostAuthorized(request, env))) return deny(403);
  const cfg = turnConfig();
  const fraction = await sharedMeter(env.USAGE).fraction();
  if (fraction >= cfg.quota.hardStopAtFraction) return json({ error: 'quota' }, 503);

  const raw = await request.text();
  if (raw.length > cfg.createBodyMaxBytes) return deny(413);
  let body: { name?: unknown; game?: unknown } = {};
  try {
    const v: unknown = raw ? JSON.parse(raw) : {};
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return deny(400);
    body = v as typeof body;
  } catch {
    return deny(400);
  }
  const game = turnGame(body.game) ? (body.game as string) : defaultTurnGame();
  const roomId = randomHex(16);
  const invite = newToken();
  const hostToken = newToken();
  const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
  await stub.init({ roomId, hostName: sanitizeName(body.name, cfg.nameMaxLen, 'Host'), hostTokenHash: await sha256Hex(hostToken), inviteHash: await sha256Hex(invite), game });
  return json({ cap: await signRoomId(env.HOST_KEY, roomId), invite, hostToken, usage: fraction });
}

export async function routeInvite(request: Request, env: TurnEnv): Promise<Response> {
  // Misconfiguration must never open the door.
  if (typeof env.HOST_KEY !== 'string' || env.HOST_KEY.length < turnConfig().minHostKeyLength) return deny(503);
  const url = new URL(request.url);
  const base = turnBasePath();
  let path = url.pathname;
  if (path.includes('//')) return deny(404);
  if (base) {
    if (path === base) return secured(Response.redirect(`${url.origin}${base}/${url.search}`, 308));
    if (!path.startsWith(`${base}/`)) return deny(404);
    path = path.slice(base.length);
  }

  if (path === '/api/rooms') return request.method === 'POST' ? createRoom(request, env) : deny(405);
  if (path === '/api/usage') {
    if (request.method !== 'GET') return deny(405);
    if (!(await hostAuthorized(request, env))) return deny(403);
    return json({ fraction: await sharedMeter(env.USAGE).fraction(), budget: turnConfig().quota.dailyRequestBudget });
  }
  if (path === '/api' || path.startsWith('/api/')) return deny(404);

  const ws = CAP_PATH.exec(path);
  if (path === '/ws' || path.startsWith('/ws/')) {
    if (!ws || request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return deny(ws ? 426 : 404);
    // Browsers always send Origin on WebSocket handshakes.
    const origin = request.headers.get('Origin');
    if (origin !== null && origin !== url.origin) return deny(403);
    const roomId = await verifyRoomCap(env.HOST_KEY, ws[1]!);
    if (!roomId) return deny(403);
    return env.ROOMS.get(env.ROOMS.idFromName(roomId)).fetch(new Request(request.url, { headers: { Upgrade: 'websocket' } }));
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') return deny(405);
  // The built client sits at the root of the assets folder; serve it as if the base path weren't there.
  // Invite links (`<base>/r/<cap>#k=…`) fall through to index.html (single-page-application handling).
  const assetUrl = new URL(url.origin);
  assetUrl.pathname = path;
  assetUrl.search = url.search;
  const res = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method }));
  const location = res.headers.get('Location');
  if (base && res.status >= 300 && res.status < 400 && location?.startsWith('/') && !location.startsWith('//')) {
    const out = new Response(res.body, res);
    out.headers.set('Location', `${base}${location}`);
    return secured(out);
  }
  return secured(res);
}

// Every request this Worker answers (refusals included) is billed, so it counts into the shared meter, in batches.
let tally: UsageTally | null = null;

export default {
  async fetch(request: Request, env: TurnEnv, ctx: ExecutionContext): Promise<Response> {
    tally ??= new UsageTally(turnConfig().usageFlushMs);
    tally.add({ workerRequests: 1 });
    const delta = tally.due(Date.now());
    if (delta && env.USAGE) {
      const meter = env.USAGE.get(env.USAGE.idFromName('global'));
      ctx.waitUntil(meter.fetch(`${OBJECT_URL}/add`, { method: 'POST', body: JSON.stringify(delta) }).then(() => undefined, () => undefined));
    }
    try {
      return await routeInvite(request, env);
    } catch {
      return deny(500);
    }
  },
} satisfies ExportedHandler<TurnEnv>;
