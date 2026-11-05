import { hostConfig } from './config';
import { meter, OBJECT_URL, PLAYER_HEADER, type Env } from './env';
import { gameById } from './registry';
import { RoomCore, type Outgoing, type RoomSnapshot } from './roomCore';
import { UsageTally } from './usageCore';

interface Attachment {
  player: string;
}

/** A random 32-bit seed: the room's dice, never chosen by a client. */
const randomSeed = (): number => crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;

/**
 * One room (one match), app-agnostic. Players connect over WebSocket with the
 * identity the Worker verified, and each gets only their own view.
 *
 * - **Real-time** (`tickHz > 0`): runs the app's fixed-step loop while anyone
 *   is connected. Match state lives in memory.
 * - **Turn-based** (`tickHz: 0`): no timers at all, so the object can hibernate
 *   between moves and bills no duration while idle. State is saved after every
 *   accepted move and restored when a message wakes the room.
 *
 * Either way the room deletes itself once it has been empty for `emptyRoomTtlMs`.
 */
export class GameRoom implements DurableObject {
  private core: RoomCore | null = null;
  private loop: ReturnType<typeof setInterval> | null = null;
  private readonly usage = new UsageTally(hostConfig().usageFlushMs);

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    this.usage.add({ objectRequests: 1 });
    if (request.method === 'POST' && path === '/init') {
      const gameId = await request.text();
      if (!gameById(gameId) || (await this.ctx.storage.get('gameId'))) return new Response(null, { status: 409 });
      await this.ctx.storage.put({ gameId, seed: randomSeed() });
      this.usage.add({ rowsWritten: 1 });
      await this.ctx.storage.setAlarm(Date.now() + hostConfig().emptyRoomTtlMs);
      return new Response(null, { status: 204 });
    }
    if (path === '/ws' && request.headers.get('Upgrade') === 'websocket') return this.join(request);
    return new Response(null, { status: 404 });
  }

  /** The room's core, rebuilt after hibernation or eviction from storage plus the sockets still attached. */
  private async ensureCore(): Promise<RoomCore | null> {
    if (this.core) return this.core;
    const gameId = await this.ctx.storage.get<string>('gameId');
    const game = gameId ? gameById(gameId) : null;
    if (!game) return null;
    const seed = (await this.ctx.storage.get<number>('seed')) ?? randomSeed();
    const snap = await this.ctx.storage.get<RoomSnapshot>('snapshot');
    const core = snap ? RoomCore.restore(game, hostConfig(), seed, snap) : new RoomCore(game, hostConfig(), seed);
    if (snap) for (const ws of this.ctx.getWebSockets()) {
      const p = this.playerOf(ws);
      if (p) core.reattach(p);
    }
    if (snap) core.markDetached(Date.now());
    this.core = core;
    return core;
  }

  private async join(request: Request): Promise<Response> {
    const player = request.headers.get(PLAYER_HEADER);
    const core = await this.ensureCore();
    if (!player || !core) return new Response(null, { status: 404 });
    const joined = core.join(player, Date.now());
    if (!joined.ok) return new Response(null, { status: 409 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ player } satisfies Attachment);
    server.send(JSON.stringify(joined.welcome));
    await this.ctx.storage.deleteAlarm();
    if (core.turnBased) {
      await this.save(core);
      this.send(core.settle(), [...this.ctx.getWebSockets(), server]);
    } else {
      this.startLoop();
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  private playerOf(ws: WebSocket): string | null {
    const a = ws.deserializeAttachment() as Attachment | null;
    return a && typeof a.player === 'string' ? a.player : null;
  }

  private send(out: Outgoing[], sockets = this.ctx.getWebSockets()): void {
    for (const { player, msg } of out) {
      const text = JSON.stringify(msg);
      for (const ws of new Set(sockets)) if (this.playerOf(ws) === player) ws.send(text);
    }
  }

  private async save(core: RoomCore): Promise<void> {
    await this.ctx.storage.put('snapshot', core.snapshot());
    this.usage.add({ rowsWritten: 1 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const player = this.playerOf(ws);
    const core = await this.ensureCore();
    if (!player || !core) {
      ws.close(1011, 'room reset');
      return;
    }
    const verdict = core.message(player, message, Date.now());
    if (verdict.kind === 'drop') ws.send(JSON.stringify(core.error(verdict.code)));
    if (verdict.kind === 'close') ws.close(1008, verdict.code);
    if (verdict.kind === 'ok' && verdict.changed && core.turnBased && core.started) {
      await this.save(core);
      this.send(core.settle());
      this.flushUsage(false);
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const player = this.playerOf(ws);
    const core = await this.ensureCore();
    if (player) core?.leave(player, Date.now());
    await this.afterDisconnect();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  private startLoop(): void {
    const core = this.core;
    if (this.loop || !core || core.turnBased) return;
    this.loop = setInterval(() => this.step(), 1000 / core.limits.tickHz);
  }

  private stopLoop(): void {
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
  }

  private step(): void {
    const core = this.core;
    if (!core) return this.stopLoop();
    this.send(core.tick());
    if (core.isOver) this.stopLoop();
    this.flushUsage(false);
  }

  private flushUsage(force: boolean): void {
    if (this.core) {
      const t = this.core.takeTally();
      this.usage.add({ inboundWs: t.inboundMessages });
    }
    const delta = this.usage.due(Date.now(), force);
    if (delta) this.ctx.waitUntil(meter(this.env).fetch(`${OBJECT_URL}/add`, { method: 'POST', body: JSON.stringify(delta) }).then(() => undefined, () => undefined));
  }

  private async afterDisconnect(): Promise<void> {
    if ((this.core?.connectedPlayers ?? 0) > 0) return;
    // Nobody left: stop ticking at once and clean up after the grace period.
    this.stopLoop();
    this.flushUsage(true);
    await this.ctx.storage.setAlarm(Date.now() + hostConfig().emptyRoomTtlMs);
  }

  async alarm(): Promise<void> {
    if (this.ctx.getWebSockets().length > 0) return;
    this.stopLoop();
    this.core = null;
    await this.ctx.storage.deleteAll();
  }
}
