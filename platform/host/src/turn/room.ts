import { DurableObject } from 'cloudflare:workers';
import { turnConfig } from './config.ts';
import { randomHex } from './crypto.ts';
import type { TurnEnv } from './env.ts';
import { sharedMeter } from './meter.ts';
import { defaultTurnGame, turnGame } from './registry.ts';
import { RoomCore, type Out, type RoomDeps } from './room_core.ts';
import type { ProfileService, Store } from './services.ts';

export function kvStore(ctx: DurableObjectState): Store {
  return {
    get: <T>(k: string) => ctx.storage.kv.get(k) as T | undefined,
    put: (k, v) => ctx.storage.kv.put(k, v),
    delete: (k) => {
      ctx.storage.kv.delete(k);
    },
    deleteAll: () => {
      throw new Error('use ctx.storage.deleteAll()');
    },
  };
}

/**
 * One turn-based room (one match). A thin shell over `RoomCore`: sockets,
 * storage and alarms. No timers in memory, so it hibernates between moves and
 * bills nothing while idle; bot moves and turn deadlines run on the DO alarm.
 * Reachable only through the Worker, after the room capability checks out.
 */
export class TurnRoom extends DurableObject<TurnEnv> {
  private core: RoomCore | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  /** Serialize everything that touches the core: awaits on other objects must not interleave with new messages. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private deps(): RoomDeps | null {
    const gameId = this.ctx.storage.kv.get('gameId');
    const game = turnGame(gameId);
    if (!game) return null;
    const p = this.env.PROFILES.get(this.env.PROFILES.idFromName('global'));
    const profiles: ProfileService = {
      create: (n) => p.create(n),
      verify: (i, s) => p.verify(i, s),
      stats: (i) => p.stats(i),
      remove: (i, s) => p.remove(i, s),
      record: (g, e) => p.record(g, e),
    };
    return { store: kvStore(this.ctx), game, profiles, usage: sharedMeter(this.env.USAGE), host: turnConfig() };
  }

  private getCore(): RoomCore | null {
    if (this.core) return this.core;
    const deps = this.deps();
    const core = deps ? RoomCore.load(deps, Date.now()) : null;
    if (!core) return null;
    // After hibernation the sockets survive; re-register them with the freshly loaded room.
    for (const ws of this.ctx.getWebSockets()) {
      const connId = this.ctx.getTags(ws)[0];
      if (connId) core.connect(connId, ws.deserializeAttachment() ?? undefined);
    }
    this.core = core;
    return core;
  }

  /** RPC from the Worker, which has already checked the host key. */
  async init(args: { roomId: string; hostName: string; hostTokenHash: string; inviteHash: string; game: string }): Promise<void> {
    return this.serial(async () => {
      if (this.ctx.storage.kv.get('meta')) throw new Error('room exists');
      this.ctx.storage.kv.put('gameId', turnGame(args.game) ? args.game : defaultTurnGame());
      const deps = this.deps();
      if (!deps) throw new Error('no game registered');
      this.core = await RoomCore.create(deps, { ...args, now: Date.now() });
      await this.reschedule();
    });
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response(null, { status: 404 });
    const core = this.getCore();
    if (!core) return new Response(null, { status: 404 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const connId = randomHex(8);
    this.ctx.acceptWebSocket(server, [connId]);
    server.serializeAttachment({ seatId: null, pendingId: null });
    if (!core.connect(connId, undefined, Date.now())) {
      server.close(1013, 'room busy');
      return new Response(null, { status: 101, webSocket: client });
    }
    // Wake up to drop this socket if it never authenticates.
    await this.reschedule();
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') {
      ws.close(1003, 'text only');
      return;
    }
    const connId = this.ctx.getTags(ws)[0];
    if (!connId) return;
    return this.serial(async () => {
      const core = this.getCore();
      if (!core) {
        ws.close(1011, 'room missing');
        return;
      }
      this.flush(await core.message(connId, message, Date.now()), core);
      await this.reschedule();
    });
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const connId = this.ctx.getTags(ws)[0];
    if (!connId) return;
    return this.serial(async () => {
      const core = this.getCore();
      if (!core) return;
      this.flush(await core.close(connId, Date.now()), core);
      await this.reschedule();
    });
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    return this.webSocketClose(ws);
  }

  override async alarm(): Promise<void> {
    return this.serial(async () => {
      const core = this.getCore();
      if (!core) {
        await this.ctx.storage.deleteAll();
        return;
      }
      const { out, dead } = await core.alarm(Date.now());
      this.flush(out, core);
      if (dead) {
        for (const ws of this.ctx.getWebSockets()) {
          try {
            ws.close(1000, 'room closed');
          } catch {
            /* already closed */
          }
        }
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
        this.core = null;
        return;
      }
      await this.reschedule();
    });
  }

  private flush(out: Out, core: RoomCore): void {
    const socketFor = (id: string): WebSocket | undefined => this.ctx.getWebSockets(id)[0];
    for (const s of out.sends) {
      try {
        socketFor(s.to)?.send(JSON.stringify(s.msg));
      } catch {
        /* peer went away */
      }
    }
    for (const c of out.closes) {
      try {
        socketFor(c.to)?.close(c.code, c.reason);
      } catch {
        /* already closed */
      }
    }
    for (const ws of this.ctx.getWebSockets()) {
      const id = this.ctx.getTags(ws)[0];
      if (!id) continue;
      try {
        ws.serializeAttachment(core.attachment(id));
      } catch {
        /* closed */
      }
    }
  }

  private async reschedule(): Promise<void> {
    const next = this.core?.nextAlarm(Date.now()) ?? null;
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }
}
