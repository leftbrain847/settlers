import { hostConfig } from './config';
import { meter, OBJECT_URL, PLAYER_HEADER, type Env } from './env';
import type { SoloStartResponse } from './protocol';
import { gameById } from './registry';
import { displayName, mergeScore, type ScoreEntry } from './scoresCore';
import { applySolo, startSolo, type SoloRecord } from './soloCore';
import { UsageTally } from './usageCore';

const randomSeed = (): number => crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;

/**
 * One solo run. The server picks the seed; each submitted segment is replayed
 * here (Durable Objects get far more CPU per request than the Worker's 10 ms),
 * and a finished run's server-computed score goes to the game's scoreboard.
 * Unfinished runs are deleted after `solo.runTtlMs`.
 */
export class SoloRun implements DurableObject {
  private readonly usage = new UsageTally(hostConfig().usageFlushMs);

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    this.usage.add({ objectRequests: 1 });
    const path = new URL(request.url).pathname;
    const player = request.headers.get(PLAYER_HEADER);
    if (!player || request.method !== 'POST') return new Response(null, { status: 404 });
    const res = path === '/start' ? await this.start(player, await request.text()) : path === '/segment' ? await this.segment(player, await request.text()) : new Response(null, { status: 404 });
    this.flushUsage(false);
    return res;
  }

  private async start(player: string, gameId: string): Promise<Response> {
    const game = gameById(gameId);
    if (!game || (await this.ctx.storage.get('run'))) return new Response(null, { status: 409 });
    const seed = randomSeed();
    const record = startSolo(game, player, seed, Date.now());
    if (!record) return new Response(null, { status: 404 });
    await this.ctx.storage.put('run', record);
    this.usage.add({ rowsWritten: 1 });
    await this.ctx.storage.setAlarm(Date.now() + hostConfig().solo.runTtlMs);
    return Response.json({ runId: this.ctx.id.toString(), seed } satisfies SoloStartResponse);
  }

  private async segment(player: string, body: string): Promise<Response> {
    const record = await this.ctx.storage.get<SoloRecord>('run');
    const game = record ? gameById(record.gameId) : null;
    if (!record || !game) return Response.json({ ok: false, code: 'not_found' }, { status: 404 });
    const out = applySolo(game, record, player, body);
    if (out.record === null || out.finished) {
      await this.ctx.storage.deleteAll();
      this.usage.add({ rowsWritten: 1 });
    } else if (out.record !== record) {
      await this.ctx.storage.put('run', out.record);
      this.usage.add({ rowsWritten: 1 });
    }
    if (out.finished && out.response.ok) {
      const entry: ScoreEntry = { player: displayName(record.owner), score: out.response.score, atMs: Date.now() };
      const board = this.env.SCORES.get(this.env.SCORES.idFromName(record.gameId));
      this.ctx.waitUntil(board.fetch(`${OBJECT_URL}/add`, { method: 'POST', body: JSON.stringify(entry) }).then(() => undefined, () => undefined));
      this.flushUsage(true);
    }
    return Response.json(out.response, { status: out.response.ok ? 200 : 400 });
  }

  private flushUsage(force: boolean): void {
    const delta = this.usage.due(Date.now(), force);
    if (delta) this.ctx.waitUntil(meter(this.env).fetch(`${OBJECT_URL}/add`, { method: 'POST', body: JSON.stringify(delta) }).then(() => undefined, () => undefined));
  }

  async alarm(): Promise<void> {
    this.flushUsage(true);
    await this.ctx.storage.deleteAll();
  }
}

const isEntry = (v: unknown): v is ScoreEntry => {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.player === 'string' && e.player.length <= 64 && typeof e.score === 'number' && Number.isFinite(e.score) && typeof e.atMs === 'number';
};

/** One game's scoreboard: each player's best, highest first. Written only by `SoloRun`. */
export class Scores implements DurableObject {
  constructor(private readonly ctx: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const list = (await this.ctx.storage.get<ScoreEntry[]>('scores')) ?? [];
    if (request.method === 'POST' && path === '/add') {
      const entry: unknown = await request.json().catch(() => null);
      if (!isEntry(entry)) return new Response(null, { status: 400 });
      const next = mergeScore(list, entry, hostConfig().solo.scoresKept);
      if (next !== list) await this.ctx.storage.put('scores', next);
      return new Response(null, { status: 204 });
    }
    if (request.method === 'GET' && path === '/list') return Response.json({ scores: list });
    return new Response(null, { status: 404 });
  }
}
