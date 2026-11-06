import type { HostConfig } from './config';
import type { GameLimits, GameModule, PlayerId } from './gameModule';
import type { ErrorCode, ServerMessage } from './protocol';
import { admit, freshRate, type RateLimit, type RateState } from './rateLimit';

type AnyGame = GameModule<unknown, unknown, unknown, unknown>;

interface Seat {
  index: number;
  connected: number;
  /** When the last connection closed; `null` while connected. */
  leftAtMs: number | null;
  rate: RateState;
}

/** `changed`: whether the input altered the app's state. Turn-based rooms save and broadcast only then. */
export type MessageVerdict = { kind: 'ok'; changed: boolean } | { kind: 'drop'; code: ErrorCode } | { kind: 'close'; code: ErrorCode };

export interface Outgoing {
  player: PlayerId;
  msg: ServerMessage;
}

export interface RoomSnapshot {
  seats: [PlayerId, number][];
  state: unknown;
  seq: number;
  over: boolean;
  ticks: number;
}

/** Usage since the last flush: what the meter needs. */
export interface RoomTally {
  connections: number;
  inboundMessages: number;
}

/**
 * Everything a room decides, free of sockets and storage so it can be tested
 * directly. Seats are bound to the verified Access email the Worker passed
 * in, never to anything the client says. The game starts once enough players
 * have joined; then `tick` runs it and produces each player's own view.
 */
export class RoomCore {
  readonly limits: GameLimits;
  private readonly seats = new Map<PlayerId, Seat>();
  private state: unknown = null;
  private ticks = 0;
  private seq = 0;
  private over = false;
  readonly tally: RoomTally = { connections: 0, inboundMessages: 0 };

  constructor(
    readonly game: AnyGame,
    private readonly host: HostConfig,
    private readonly seed: number,
  ) {
    this.limits = { ...game.limits };
  }

  get started(): boolean {
    return this.state !== null;
  }

  get isOver(): boolean {
    return this.over;
  }

  /** `tickHz: 0` = a turn-based room: no loop, views go out after each accepted input. */
  get turnBased(): boolean {
    return this.limits.tickHz === 0;
  }

  get connectedPlayers(): number {
    let n = 0;
    for (const s of this.seats.values()) if (s.connected > 0) n++;
    return n;
  }

  private rateLimit(): RateLimit {
    return { perSec: this.limits.maxInputsPerSec, abusePerSec: this.host.abuseDropsPerSec, windowS: this.host.abuseWindowS };
  }

  private envelope<T extends ServerMessage['t']>(t: T, d: Extract<ServerMessage, { t: T }>['d']): ServerMessage {
    return { t, s: ++this.seq, d } as ServerMessage;
  }

  /** Free seats whose player has been gone longer than the grace period (before the game starts). */
  private expireSeats(nowMs: number): void {
    if (this.started) return;
    for (const [player, s] of this.seats) {
      if (s.connected === 0 && s.leftAtMs !== null && nowMs - s.leftAtMs > this.host.seatGraceMs) this.seats.delete(player);
    }
  }

  /** A verified player connects. Rejoining reclaims the same seat; a new player needs a free one. */
  join(player: PlayerId, nowMs: number): { ok: true; welcome: ServerMessage } | { ok: false; code: ErrorCode } {
    this.expireSeats(nowMs);
    let seat = this.seats.get(player);
    if (!seat) {
      if (this.started || this.seats.size >= this.limits.maxPlayers) return { ok: false, code: 'room_full' };
      seat = { index: this.seats.size, connected: 0, leftAtMs: null, rate: freshRate() };
      this.seats.set(player, seat);
    }
    seat.connected++;
    seat.leftAtMs = null;
    this.tally.connections++;
    if (!this.started && this.seats.size >= this.limits.minPlayers) {
      this.state = this.game.init(this.game.defaultConfig, [...this.seats.keys()], this.seed);
    }
    return { ok: true, welcome: this.envelope('welcome', { seat: seat.index, players: this.seats.size, gameId: this.game.id }) };
  }

  leave(player: PlayerId, nowMs: number): void {
    const seat = this.seats.get(player);
    if (!seat) return;
    seat.connected = Math.max(0, seat.connected - 1);
    if (seat.connected === 0) seat.leftAtMs = nowMs;
  }

  /** One inbound socket message: size first, then shape, then the game's own input schema, then the rate limit. */
  message(player: PlayerId, raw: string | ArrayBuffer, nowMs: number): MessageVerdict {
    this.tally.inboundMessages++;
    const seat = this.seats.get(player);
    if (!seat) return { kind: 'close', code: 'rejected' };
    const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw).byteLength : raw.byteLength;
    if (bytes > this.limits.maxMsgBytes || typeof raw !== 'string') return { kind: 'drop', code: 'bad_message' };
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return { kind: 'drop', code: 'bad_message' };
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return { kind: 'drop', code: 'bad_message' };
    const env = msg as Record<string, unknown>;
    if (Object.keys(env).some((k) => k !== 't' && k !== 's' && k !== 'd') || typeof env.s !== 'number') return { kind: 'drop', code: 'bad_message' };
    if (env.t !== 'input' && env.t !== 'ping') return { kind: 'drop', code: 'bad_message' };
    // Pings count against the same per-player limit as inputs, so they can't be used to flood.
    const verdict = admit(seat.rate, this.rateLimit(), nowMs);
    if (verdict === 'abuse') return { kind: 'close', code: 'rate_limited' };
    if (verdict === 'drop') return { kind: 'drop', code: 'rate_limited' };
    if (env.t === 'ping') return { kind: 'ok', changed: false };
    const input = this.game.parseInput(env.d);
    if (input === null) return { kind: 'drop', code: 'bad_message' };
    if (!this.started || this.over) return { kind: 'ok', changed: false };
    // Turn-based rooms persist after each move, so they need to know whether the move did anything
    // (a move out of turn is ignored by the app and must not cost a storage write or a broadcast).
    const before = this.turnBased ? JSON.stringify(this.state) : null;
    this.game.onInput(this.state, player, input, nowMs);
    return { kind: 'ok', changed: before === null || JSON.stringify(this.state) !== before };
  }

  /** Each connected player's own view (or the final one), now. */
  views(): Outgoing[] {
    if (!this.started) return [];
    const out: Outgoing[] = [];
    for (const [player, seat] of this.seats) {
      if (seat.connected === 0) continue;
      out.push({ player, msg: this.envelope(this.over ? 'over' : 'view', this.game.viewFor(this.state, player)) });
    }
    return out;
  }

  /** Turn-based rooms: after an accepted input (or a join), check for the end and send everyone their view. */
  settle(): Outgoing[] {
    if (!this.started) return [];
    if (!this.over && this.game.isOver(this.state)) this.over = true;
    return this.views();
  }

  /** What a turn-based room stores after each move, so it survives hibernation and eviction. */
  snapshot(): RoomSnapshot {
    return { seats: [...this.seats].map(([player, s]) => [player, s.index]), state: this.state, seq: this.seq, over: this.over, ticks: this.ticks };
  }

  /** Rebuild a room from its snapshot. Nobody counts as connected until their socket is re-attached. */
  static restore(game: AnyGame, host: HostConfig, seed: number, snap: RoomSnapshot): RoomCore {
    const core = new RoomCore(game, host, seed);
    for (const [player, index] of snap.seats) core.seats.set(player, { index, connected: 0, leftAtMs: null, rate: freshRate() });
    core.state = snap.state;
    core.seq = snap.seq;
    core.over = snap.over;
    core.ticks = snap.ticks;
    return core;
  }

  /** After restore and re-attach: seats with no surviving socket start their grace period now, so ghost seats get freed. */
  markDetached(nowMs: number): void {
    for (const seat of this.seats.values()) if (seat.connected === 0 && seat.leftAtMs === null) seat.leftAtMs = nowMs;
  }

  /** A socket that survived hibernation is attached again. */
  reattach(player: PlayerId): void {
    const seat = this.seats.get(player);
    if (seat) {
      seat.connected++;
      seat.leftAtMs = null;
    }
  }

  /** One fixed step; on snapshot ticks (and at the end) each connected player gets their own view. */
  tick(): Outgoing[] {
    if (!this.started || this.over || this.turnBased) return [];
    const dt = 1000 / this.limits.tickHz;
    this.game.tick?.(this.state, dt);
    this.ticks++;
    const every = Math.max(1, Math.round(this.limits.tickHz / this.limits.snapshotHz));
    const ended = this.game.isOver(this.state);
    if (ended) this.over = true;
    if (!ended && this.ticks % every !== 0) return [];
    const out: Outgoing[] = [];
    for (const [player, seat] of this.seats) {
      if (seat.connected === 0) continue;
      out.push({ player, msg: this.envelope(ended ? 'over' : 'view', this.game.viewFor(this.state, player)) });
    }
    return out;
  }

  error(code: ErrorCode): ServerMessage {
    return this.envelope('error', { code });
  }

  /** Hand over the usage tally and start a new one. */
  takeTally(): RoomTally {
    const t = { ...this.tally };
    this.tally.connections = 0;
    this.tally.inboundMessages = 0;
    return t;
  }
}
