// Online transport for turn-based rooms: speaks the room protocol over a WebSocket. Implements the same Transport the local game uses,
// so the game screen never knows the difference. Reconnects with the seat token; never stores anything itself.
import type { ProfileAuth, S2C, HostCmd } from '@app-builder/host/turn/protocol';
import type { Snapshot, Transport } from './transport.ts';

export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: { code: number }) => void) | null;
  onerror: (() => void) | null;
}

export type LobbyMsg = Extract<S2C, { t: 'lobby' }>;
export type ProfileMsg = Extract<S2C, { t: 'profile' }>;
export type RoomStatus = 'connecting' | 'pending' | 'joined' | 'rejected' | 'kicked' | 'closed' | 'failed';

export interface RoomInfo {
  status: RoomStatus; seat: string | null; host: boolean; position: number;
  lobby: LobbyMsg | null; invite: { secret: string; expiresAt: number } | null; profile: ProfileMsg | null;
  error: string | null; started: boolean; turnDeadline: number | null; serverNow: number; reconnecting: boolean;
}

export interface WsOptions {
  url: string;
  token: string;
  /** Present only for a brand-new visitor arriving from an invite link. */
  join?: { invite: string; name: string };
  profile?: ProfileAuth;
  makeSocket?: (url: string) => SocketLike;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

const FATAL_CODES = new Set([1000, 1008, 1013, 4000]);
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];

export class WsTransport<View = unknown, Event = unknown, Cfg = unknown, ActionType extends string = string> implements Transport<View, Event, Cfg, ActionType> {
  private o: WsOptions;
  private socket: SocketLike | null = null;
  private snapListeners = new Set<(s: Snapshot<View, Event, Cfg>) => void>();
  private roomListeners = new Set<(r: RoomInfo) => void>();
  private cfg: Cfg | null = null;
  private lastSnap: Snapshot<View, Event, Cfg> | null = null;
  private joinPending: boolean;
  private attempts = 0;
  private retry: unknown = null;
  private destroyed = false;
  room: RoomInfo = {
    status: 'connecting', seat: null, host: false, position: 0, lobby: null, invite: null, profile: null,
    error: null, started: false, turnDeadline: null, serverNow: 0, reconnecting: false,
  };

  constructor(o: WsOptions) {
    this.o = o;
    this.joinPending = !!o.join;
  }

  subscribe(fn: (s: Snapshot<View, Event, Cfg>) => void): () => void {
    this.snapListeners.add(fn);
    if (this.lastSnap) fn(this.lastSnap);
    return () => this.snapListeners.delete(fn);
  }

  onRoom(fn: (r: RoomInfo) => void): () => void {
    this.roomListeners.add(fn);
    fn(this.room);
    return () => this.roomListeners.delete(fn);
  }

  start(): void { this.open(); }

  private open(): void {
    if (this.destroyed) return;
    const make = this.o.makeSocket ?? ((u: string): SocketLike => new WebSocket(u) as unknown as SocketLike);
    const sock = make(this.o.url);
    this.socket = sock;
    sock.onopen = () => {
      this.attempts = 0;
      this.setRoom({ reconnecting: false });
      const profile = this.o.profile ? { profile: this.o.profile } : {};
      if (this.joinPending && this.o.join) this.raw({ t: 'join', name: this.o.join.name, invite: this.o.join.invite, token: this.o.token, ...profile });
      else this.raw({ t: 'resume', token: this.o.token, ...profile });
    };
    sock.onmessage = (e) => { if (this.socket === sock && typeof e.data === 'string') this.onMessage(e.data); };
    sock.onerror = () => undefined;
    sock.onclose = (e) => {
      if (this.socket !== sock || this.destroyed) return;
      this.socket = null;
      const terminal = ['rejected', 'kicked', 'closed', 'failed'].includes(this.room.status);
      if (terminal) return;
      if (FATAL_CODES.has(e.code)) {
        if (this.room.status === 'connecting') this.setRoom({ status: 'failed', error: this.room.error ?? 'This link is not valid any more.' });
        else if (e.code === 1000) this.setRoom({ status: 'closed' });
        return;
      }
      this.setRoom({ reconnecting: true });
      const wait = BACKOFF_MS[Math.min(this.attempts++, BACKOFF_MS.length - 1)]!;
      this.retry = (this.o.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms)))(() => this.open(), wait);
    };
  }

  private raw(msg: object): void {
    try { this.socket?.send(JSON.stringify(msg)); } catch { /* socket closing: the reconnect path resends what matters */ }
  }

  private setRoom(patch: Partial<RoomInfo>): void {
    this.room = { ...this.room, ...patch };
    for (const fn of this.roomListeners) fn(this.room);
  }

  private onMessage(data: string): void {
    let m: S2C;
    try { m = JSON.parse(data) as S2C; } catch { return; }
    switch (m.t) {
      case 'pending': this.joinPending = false; this.setRoom({ status: 'pending', position: m.position }); break;
      case 'joined': this.joinPending = false; this.setRoom({ status: 'joined', seat: m.seat, host: m.host, error: null }); break;
      case 'rejected': this.setRoom({ status: 'rejected' }); break;
      case 'kicked': this.setRoom({ status: 'kicked' }); break;
      case 'replaced': this.setRoom({ status: 'closed', error: 'This seat was opened on another device.' }); break;
      case 'lobby': this.setRoom({ lobby: m, started: m.phase !== 'lobby' }); break;
      case 'invite': this.setRoom({ invite: { secret: m.secret, expiresAt: m.expiresAt } }); break;
      case 'profile': this.setRoom({ profile: m }); break;
      case 'error':
        this.setRoom({ error: m.message });
        if (this.room.status === 'connecting' || this.room.status === 'pending') this.setRoom({ status: this.room.status === 'connecting' ? 'failed' : this.room.status });
        if (this.lastSnap && !['profile_deleted'].includes(m.code)) this.emit({ ...this.lastSnap, events: [], error: m.message });
        break;
      case 'state': {
        if (m.cfg) this.cfg = m.cfg as Cfg;
        if (!this.cfg) return;
        this.setRoom({ started: true, turnDeadline: m.turnDeadline, serverNow: m.now });
        this.emit({
          view: m.view as View, events: m.events as Event[], cfg: this.cfg, deadlines: m.deadlines, now: m.now,
          autopilot: m.autopilot, speed: this.room.lobby?.botSpeed ?? 1, thinking: m.thinking,
        });
        break;
      }
    }
  }

  private emit(s: Snapshot<View, Event, Cfg>): void {
    this.lastSnap = s;
    for (const fn of this.snapListeners) fn(s);
  }

  // ---- Transport
  send(type: ActionType, params: object = {}): void { this.raw({ t: 'action', type, params }); }
  setAutopilot(on: boolean): void { this.raw({ t: 'autopilot', on }); }
  /** Bot pacing is a room setting owned by the host. */
  setSpeed(x: number): void { if (this.room.host) this.hostCmd({ c: 'bot_speed', x: x === Infinity || x >= 1e9 ? 0 : x }); }
  destroy(): void {
    this.destroyed = true;
    if (this.retry !== null) (this.o.cancel ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.retry);
    try { this.socket?.close(1000, 'bye'); } catch { /* already closed */ }
    this.snapListeners.clear();
    this.roomListeners.clear();
  }

  // ---- room commands
  hostCmd(cmd: HostCmd): void { this.raw({ t: 'host', cmd }); }
  profileCreate(): void { this.raw({ t: 'profile_create' }); }
  profileLink(profile: ProfileAuth): void { this.raw({ t: 'profile_link', profile }); }
  profileDelete(profile: ProfileAuth): void { this.raw({ t: 'profile_delete', profile }); }
  profileStats(): void { this.raw({ t: 'profile_stats' }); }
}
