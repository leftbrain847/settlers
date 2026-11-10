// The room: seats, join approval, hidden-info fan-out, bots, timers. Pure logic over injected storage, clock and
// services, so it runs unchanged in a Durable Object and in Node tests. It never touches a raw socket.
import { turnConfig } from './config.ts';
import type { HostConfig } from './config.ts';
import { newToken, randomHex, safeEqual, sanitizeName, sha256Hex } from './crypto.ts';
import { parseC2S } from './protocol.ts';
import type { C2S, HostCmd, PendingPublic, S2C, SeatPublic } from './protocol.ts';
import type { ErasedGame, GameInstance } from './game.ts';
import type { ProfileService, Store, UsageService } from './services.ts';

type SeatBot = SeatPublic['bot'];
export interface Seat { id: string; name: string; tokenHash: string; isHost: boolean; profileId: string | null; bot: SeatBot }
interface Pending { id: string; name: string; tokenHash: string; at: number; profileId: string | null }
interface Meta {
  v: 1; roomId: string; createdAt: number; lastActivity: number; phase: 'lobby' | 'playing' | 'finished';
  seats: Seat[]; pending: Pending[]; inviteHash: string; inviteExpiresAt: number; locked: boolean;
  settings: unknown; numBots: number; turnTimerS: number; botSpeed: number; finishedAt: number | null;
  waitKey: string; waitDeadline: number | null; nextPendingId: number; botAt: number | null; botFailures: number; closing: boolean; startedAt: number | null;
}

export interface RoomDeps { store: Store; game: ErasedGame; profiles: ProfileService; usage: UsageService; host?: HostConfig }
export interface ConnAttachment { seatId: string | null; pendingId: string | null }

interface Conn { id: string; seatId: string | null; pendingId: string | null; windowStart: number; count: number; strikes: number; sentCfg: boolean; at: number }

export class Out {
  sends: { to: string; msg: S2C }[] = [];
  closes: { to: string; code: number; reason: string }[] = [];
  send(to: string, msg: S2C): void { this.sends.push({ to, msg }); }
  error(to: string, code: string, message: string): void { this.send(to, { t: 'error', code, message }); }
  close(to: string, code: number, reason: string): void { this.closes.push({ to, code, reason }); }
}

const byteLength = (s: string): number => new TextEncoder().encode(s).length;
const fmtRecovery = (id: string, secret: string): string => `${id}${secret}`.replace(/(.{4})(?=.)/g, '$1-');

export class RoomCore {
  private deps: RoomDeps;
  private cfg: HostConfig;
  meta: Meta;
  private state: unknown = null;
  private instance: GameInstance<unknown, unknown, unknown, unknown> | null = null;
  private clock = 0;
  private conns = new Map<string, Conn>();
  private counters = { inbound: 0, connects: 0, lastFlush: 0 };
  private usageFraction = 0;
  private thinking: string | null = null;

  private constructor(deps: RoomDeps, meta: Meta) {
    this.deps = deps;
    this.cfg = deps.host ?? turnConfig();
    this.meta = meta;
  }

  /** First-time setup. The Worker has already authenticated the host key; tokens arrive as hashes only. */
  static async create(deps: RoomDeps, init: { roomId: string; now: number; hostName: string; hostTokenHash: string; inviteHash: string }): Promise<RoomCore> {
    const cfg = deps.host ?? turnConfig();
    const meta: Meta = {
      v: 1, roomId: init.roomId, createdAt: init.now, lastActivity: init.now, phase: 'lobby',
      seats: [{ id: 'p1', name: sanitizeName(init.hostName, cfg.nameMaxLen, 'Host'), tokenHash: init.hostTokenHash, isHost: true, profileId: null, bot: 'none' }],
      pending: [], inviteHash: init.inviteHash, inviteExpiresAt: init.now + cfg.inviteTtlMs, locked: false,
      settings: deps.game.defaultSettings(), numBots: 1, turnTimerS: 0, botSpeed: 1, finishedAt: null, waitKey: '', waitDeadline: null,
      nextPendingId: 1, botAt: null, botFailures: 0, closing: false, startedAt: null,
    };
    const core = new RoomCore(deps, meta);
    core.save();
    return core;
  }

  static load(deps: RoomDeps, now: number): RoomCore | null {
    const meta = deps.store.get<Meta>('meta');
    if (!meta) return null;
    const core = new RoomCore(deps, meta);
    const g = deps.store.get<{ state: unknown }>('game');
    if (g) { core.state = g.state; core.ensureInstance(); core.instance!.timers.sync(core.state, now); }
    return core;
  }

  // ------------------------------------------------------------ connections
  /** A new socket. `false` = the room is at its connection cap (the caller closes it). Unauthenticated sockets time out. */
  connect(connId: string, attachment?: ConnAttachment, now: number = this.clock): boolean {
    if (!attachment && this.conns.size >= this.cfg.maxConnections) return false;
    this.conns.set(connId, { id: connId, seatId: attachment?.seatId ?? null, pendingId: attachment?.pendingId ?? null, windowStart: 0, count: 0, strikes: 0, sentCfg: false, at: now });
    this.counters.connects++;
    return true;
  }


  attachment(connId: string): ConnAttachment { const c = this.conns.get(connId); return { seatId: c?.seatId ?? null, pendingId: c?.pendingId ?? null }; }

  async close(connId: string, now: number): Promise<Out> {
    const out = new Out();
    this.clock = now;
    const c = this.conns.get(connId);
    this.conns.delete(connId);
    if (c?.seatId) this.broadcastLobby(out);
    this.meta.lastActivity = now;
    return out;
  }

  // ------------------------------------------------------------ inbound
  async message(connId: string, raw: string, now: number): Promise<Out> {
    const out = new Out();
    this.clock = now;
    const conn = this.conns.get(connId);
    if (!conn || this.meta.closing) return out;
    this.counters.inbound++;
    if (byteLength(raw) > this.cfg.maxMsgBytes) { out.close(connId, 1009, 'message too large'); return out; }
    if (now - conn.windowStart >= 1000) { conn.windowStart = now; conn.count = 0; }
    if (++conn.count > this.cfg.maxMsgsPerSec) {
      if (++conn.strikes >= this.cfg.abuseStrikesBeforeClose) out.close(connId, 1008, 'rate limit');
      else out.error(connId, 'rate_limited', 'Slow down.');
      return out;
    }
    const msg = parseC2S(raw);
    if (!msg) { out.error(connId, 'bad_message', 'Unrecognized message.'); return out; }

    if (!conn.seatId) {
      if (conn.pendingId) { if (msg.t === 'resume') await this.onResume(conn, msg, out, now); return out; }
      if (msg.t === 'join') await this.onJoin(conn, msg, out, now);
      else if (msg.t === 'resume') await this.onResume(conn, msg, out, now);
      else out.close(connId, 1008, 'unauthenticated');
      await this.afterChange(out, now, false);
      return out;
    }

    const seat = this.meta.seats.find((s) => s.id === conn.seatId);
    if (!seat) { out.close(connId, 1008, 'seat gone'); return out; }
    switch (msg.t) {
      case 'action': await this.onAction(conn, seat, msg, out, now); break;
      case 'autopilot': this.setBot(seat, msg.on ? 'self' : 'none'); this.broadcastLobby(out); await this.afterChange(out, now, true); break;
      case 'profile_create': await this.onProfileCreate(conn, seat, out); break;
      case 'profile_link': await this.onProfileLink(conn, seat, msg.profile, out); break;
      case 'profile_delete': await this.onProfileDelete(conn, seat, msg.profile, out); break;
      case 'profile_stats': await this.sendProfile(conn.id, seat, out); break;
      case 'host':
        if (!seat.isHost) out.error(conn.id, 'forbidden', 'Only the host can do that.');
        else await this.onHost(conn, msg.cmd, out, now);
        break;
      default: out.error(conn.id, 'bad_message', 'Already joined.');
    }
    return out;
  }

  // ------------------------------------------------------------ joining
  private async onJoin(conn: Conn, msg: Extract<C2S, { t: 'join' }>, out: Out, now: number): Promise<void> {
    const m = this.meta;
    const tokenHash = await sha256Hex(msg.token);
    if (m.seats.some((s) => s.tokenHash === tokenHash) || m.pending.some((p) => p.tokenHash === tokenHash)) return this.onResume(conn, { t: 'resume', token: msg.token }, out, now);
    const inviteOk = (await safeEqual(await sha256Hex(msg.invite), m.inviteHash)) && now < m.inviteExpiresAt && !m.locked && m.phase !== 'finished';
    if (!inviteOk) { out.error(conn.id, 'invite_invalid', 'This invite link is not valid any more.'); out.close(conn.id, 1008, 'invite'); return; }
    if (m.pending.length >= this.cfg.maxPendingJoins) { out.error(conn.id, 'busy', 'Too many requests. Try again later.'); out.close(conn.id, 1013, 'busy'); return; }
    const name = sanitizeName(msg.name, this.cfg.nameMaxLen);
    let profileId: string | null = null;
    if (msg.profile && (await this.deps.profiles.verify(msg.profile.id, msg.profile.secret))) profileId = msg.profile.id;
    const p: Pending = { id: `r${m.nextPendingId++}`, name, tokenHash, at: now, profileId };
    m.pending.push(p);
    conn.pendingId = p.id;
    out.send(conn.id, { t: 'pending', position: m.pending.length });
    this.broadcastLobby(out);
  }

  private async onResume(conn: Conn, msg: Extract<C2S, { t: 'resume' }>, out: Out, now: number): Promise<void> {
    const m = this.meta;
    const tokenHash = await sha256Hex(msg.token);
    const seat = m.seats.find((s) => s.tokenHash === tokenHash);
    if (seat) {
      for (const other of this.conns.values()) if (other.id !== conn.id && other.seatId === seat.id) { out.send(other.id, { t: 'replaced' }); out.close(other.id, 4000, 'replaced'); other.seatId = null; this.conns.delete(other.id); }
      conn.seatId = seat.id; conn.pendingId = null;
      if (seat.bot === 'afk') this.setBot(seat, 'none');
      if (msg.profile && !seat.profileId && (await this.deps.profiles.verify(msg.profile.id, msg.profile.secret))) seat.profileId = msg.profile.id;
      this.usageFraction = await this.deps.usage.fraction();
      out.send(conn.id, { t: 'joined', seat: seat.id, host: seat.isHost });
      this.broadcastLobby(out);
      if (this.state) this.sendState(out, [], conn.id);
      await this.afterChange(out, now, false);
      return;
    }
    const pend = m.pending.find((p) => p.tokenHash === tokenHash);
    if (pend) { conn.pendingId = pend.id; out.send(conn.id, { t: 'pending', position: m.pending.indexOf(pend) + 1 }); return; }
    out.error(conn.id, 'unknown_token', 'This seat is no longer available.');
    out.close(conn.id, 1008, 'unknown token');
  }

  // ------------------------------------------------------------ gameplay
  private async onAction(conn: Conn, seat: Seat, msg: Extract<C2S, { t: 'action' }>, out: Out, now: number): Promise<void> {
    if ((this.meta.phase !== 'playing') || !this.instance) { out.error(conn.id, 'not_playing', 'The game has not started.'); return; }
    const action = this.instance.parseAction(msg.type, msg.params, seat.id); // player_id comes from the seat, never from the client
    if (!action) { out.error(conn.id, 'bad_action', 'That move is not valid.'); return; }
    const released = seat.bot === 'afk' || seat.bot === 'self';
    if (released) this.setBot(seat, 'none');
    const r = this.instance.reduce(this.state, action);
    if (released) this.broadcastLobby(out);   // everyone's seat list shows the player back, not still on a bot
    if (!r.ok) {
      out.error(conn.id, 'illegal', r.error);
      if (released) await this.afterChange(out, now, false);   // the seat change still has to be saved and the timer reset
      return;
    }
    this.state = r.state;
    this.meta.botFailures = 0; // the game moved on: paused bots get to try again
    await this.afterChange(out, now, true, r.events);
  }

  private botSeatIds(): string[] { return this.meta.seats.filter((s) => s.bot !== 'none').map((s) => s.id); }

  private setBot(seat: Seat, bot: SeatBot): void {
    seat.bot = bot;
    if (this.instance && this.state) this.state = this.instance.setSeatBot(this.state, seat.id, bot !== 'none');
  }

  private ensureInstance(): void {
    if (this.instance) return;
    const settings = this.deps.game.parseSettings(this.meta.settings) ?? this.deps.game.defaultSettings();
    this.instance = this.deps.game.create(settings, this.cfg);
  }

  /** Runs after anything that may have changed the room: timers, bot scheduling, game end, persistence, fan-out. */
  private async afterChange(out: Out, now: number, changed: boolean, events: unknown[] = []): Promise<void> {
    const m = this.meta;
    if (changed) m.lastActivity = now;
    if (this.instance && this.state && m.phase === 'playing') {
      this.instance.timers.sync(this.state, now);
      const w = this.instance.waitingOn(this.state);
      if (w.key !== m.waitKey) { m.waitKey = w.key; m.waitDeadline = m.turnTimerS > 0 && w.seats.some((id: string) => this.isHuman(id)) ? now + m.turnTimerS * 1000 : null; }
      if (this.instance.isOver(this.state)) await this.finish(now);
      else {
        const plan = this.instance.bots.plan(this.state, this.botSeatIds());
        m.botAt = plan.length && (m.botFailures ?? 0) < this.cfg.maxBotFailures ? now + (m.botSpeed === 0 ? 0 : this.instance.bots.delayMs(plan[0]!) / m.botSpeed) : null;
        this.thinking = plan.length ? (plan[0] as { player_id?: string }).player_id ?? null : null;
      }
      if (changed) this.sendState(out, events);
    }
    this.save();
  }

  private isHuman(seatId: string): boolean { return this.meta.seats.find((s) => s.id === seatId)?.bot === 'none'; }

  private async finish(now: number): Promise<void> {
    const m = this.meta;
    if (m.phase === 'finished' || !this.instance || !this.state) return;
    m.phase = 'finished'; m.finishedAt = now; m.botAt = null; m.waitDeadline = null; this.thinking = null;
    const result = this.instance.result(this.state);
    const entries = m.seats.filter((s) => s.profileId && result.seats[s.id]).map((s) => ({ profileId: s.profileId!, result: result.seats[s.id]! }));
    if (entries.length) await this.deps.profiles.record(m.roomId, entries).catch(() => undefined);
  }

  // ------------------------------------------------------------ host commands
  private async onHost(conn: Conn, cmd: HostCmd, out: Out, now: number): Promise<void> {
    const m = this.meta;
    const err = (code: string, message: string): void => out.error(conn.id, code, message);
    switch (cmd.c) {
      case 'approve': {
        const p = m.pending.find((x) => x.id === cmd.request);
        if (!p) return err('no_request', 'That request is gone.');
        let seat: Seat | undefined;
        if (m.phase === 'lobby') {
          if (m.seats.length >= this.deps.game.limits.maxPlayers) return err('full', 'The room is full.');
          seat = { id: this.nextSeatId(), name: p.name, tokenHash: p.tokenHash, isHost: false, profileId: p.profileId, bot: 'none' };
          m.seats.push(seat);
        } else if (m.phase === 'playing') {
          seat = m.seats.find((s) => s.id === cmd.seat && !s.isHost && s.bot !== 'none');
          if (!seat) return err('no_seat', 'Pick a bot-controlled seat to hand over.');
          // The seat changes hands: whoever held it (an autopilot or timed-out tab) loses it now.
          for (const c of [...this.conns.values()]) if (c.seatId === seat.id) { out.send(c.id, { t: 'replaced' }); out.close(c.id, 4000, 'replaced'); this.conns.delete(c.id); }
          seat.name = p.name; seat.tokenHash = p.tokenHash; seat.profileId = p.profileId;
          this.setBot(seat, 'none');
        } else return err('closed', 'The game is over.');
        m.pending = m.pending.filter((x) => x.id !== p.id);
        for (const c of this.conns.values()) if (c.pendingId === p.id) { c.pendingId = null; c.seatId = seat.id; out.send(c.id, { t: 'joined', seat: seat.id, host: false }); if (this.state) this.sendState(out, [], c.id); }
        if (m.phase === 'lobby' && m.seats.length >= this.deps.game.limits.maxPlayers) m.locked = true;
        this.broadcastLobby(out);
        await this.afterChange(out, now, true);
        return;
      }
      case 'reject': {
        const p = m.pending.find((x) => x.id === cmd.request);
        if (!p) return;
        m.pending = m.pending.filter((x) => x.id !== p.id);
        for (const c of [...this.conns.values()]) if (c.pendingId === p.id) { out.send(c.id, { t: 'rejected' }); out.close(c.id, 1008, 'rejected'); this.conns.delete(c.id); }
        this.broadcastLobby(out);
        break;
      }
      case 'kick': {
        const seat = m.seats.find((s) => s.id === cmd.seat);
        if (!seat || seat.isHost) return err('no_seat', 'That seat cannot be removed.');
        for (const c of [...this.conns.values()]) if (c.seatId === seat.id) { out.send(c.id, { t: 'kicked' }); out.close(c.id, 1008, 'kicked'); this.conns.delete(c.id); }
        if (m.phase === 'lobby') m.seats = m.seats.filter((s) => s.id !== seat.id);
        else { seat.tokenHash = ''; seat.profileId = null; this.setBot(seat, 'host'); }
        m.locked = m.locked && m.seats.length >= this.deps.game.limits.maxPlayers;
        this.broadcastLobby(out);
        await this.afterChange(out, now, true);
        return;
      }
      case 'settings': {
        if (m.phase !== 'lobby') return err('started', 'Settings are locked once the game starts.');
        const parsed = this.deps.game.parseSettings(cmd.settings);
        if (!parsed) return err('bad_settings', 'Those settings are not valid.');
        m.settings = parsed;
        m.numBots = Math.min(cmd.bots, this.deps.game.limits.maxPlayers - 1);
        this.instance = null;
        this.broadcastLobby(out);
        break;
      }
      case 'start': return this.startGame(conn, out, now);
      case 'rotate_invite': {
        const secret = newToken();
        m.inviteHash = await sha256Hex(secret);
        m.inviteExpiresAt = now + this.cfg.inviteTtlMs;
        out.send(conn.id, { t: 'invite', secret, expiresAt: m.inviteExpiresAt });
        this.broadcastLobby(out);
        break;
      }
      case 'lock': m.locked = cmd.on; this.broadcastLobby(out); break;
      case 'bot_speed': m.botSpeed = cmd.x; this.broadcastLobby(out); await this.afterChange(out, now, false); return;
      case 'turn_timer': {
        m.turnTimerS = cmd.seconds;
        if (this.instance && this.state && m.phase === 'playing') {
          const w = this.instance.waitingOn(this.state);
          m.waitKey = w.key;
          m.waitDeadline = cmd.seconds > 0 && w.seats.some((id: string) => this.isHuman(id)) ? now + cmd.seconds * 1000 : null;
          this.sendState(out, []);
        }
        this.broadcastLobby(out);
        break;
      }
      case 'bot_seat': {
        const seat = m.seats.find((s) => s.id === cmd.seat);
        if (!seat || seat.isHost || seat.bot === 'ai') return err('no_seat', 'That seat cannot be changed.');
        this.setBot(seat, cmd.on ? 'host' : 'none');
        this.broadcastLobby(out);
        await this.afterChange(out, now, true);
        return;
      }
      case 'close': {
        m.closing = true;
        for (const c of this.conns.values()) out.close(c.id, 1000, 'room closed');
        break;
      }
    }
    this.save();
  }

  private nextSeatId(): string {
    for (let i = 1; i <= 16; i++) if (!this.meta.seats.some((s) => s.id === `p${i}`)) return `p${i}`;
    return `p${this.meta.seats.length + 1}`;
  }

  private async startGame(conn: Conn, out: Out, now: number): Promise<void> {
    const m = this.meta;
    if (m.phase !== 'lobby') return out.error(conn.id, 'started', 'Already started.');
    const { minPlayers, maxPlayers } = this.deps.game.limits;
    const humans = m.seats.length;
    let bots = Math.min(m.numBots, maxPlayers - humans);
    if (humans + bots < minPlayers) bots = minPlayers - humans;
    if (humans + bots > maxPlayers || bots < 0) return out.error(conn.id, 'bad_count', 'Not enough room for the players.');
    for (let i = 0; i < bots; i++) m.seats.push({ id: this.nextSeatId(), name: `Bot ${i + 1}`, tokenHash: '', isHost: false, profileId: null, bot: 'ai' });
    this.ensureInstance();
    const seed = crypto.getRandomValues(new Uint32Array(1))[0]!;
    const init = this.instance!.init(m.seats.map((s) => ({ id: s.id, name: s.name, isBot: s.bot !== 'none' })), seed);
    this.state = init.state;
    m.phase = 'playing'; m.locked = true; m.startedAt = now; m.waitKey = '';
    for (const c of this.conns.values()) c.sentCfg = false;
    // expire stale join requests: nobody new joins a running game without the host picking a seat
    this.broadcastLobby(out);
    await this.afterChange(out, now, true, init.events);
  }

  // ------------------------------------------------------------ profiles
  private async onProfileCreate(conn: Conn, seat: Seat, out: Out): Promise<void> {
    if (seat.profileId) return out.error(conn.id, 'has_profile', 'This seat already has a profile.');
    let made: { id: string; secret: string };
    try { made = await this.deps.profiles.create(seat.name); } catch { return out.error(conn.id, 'profile_unavailable', 'Profiles are full right now.'); }
    const { id, secret } = made;
    seat.profileId = id;
    out.send(conn.id, { t: 'profile', id, name: seat.name, secret, recovery: fmtRecovery(id, secret), stats: await this.deps.profiles.stats(id) });
    this.broadcastLobby(out);
    this.save();
  }

  private async onProfileLink(conn: Conn, seat: Seat, auth: { id: string; secret: string }, out: Out): Promise<void> {
    const prof = await this.deps.profiles.verify(auth.id, auth.secret);
    if (!prof) return out.error(conn.id, 'profile_invalid', 'That recovery code did not match a profile.');
    if (this.meta.seats.some((s) => s.id !== seat.id && s.profileId === auth.id)) return out.error(conn.id, 'profile_in_use', 'That profile is already in this room.');
    seat.profileId = auth.id;
    out.send(conn.id, { t: 'profile', id: auth.id, name: prof.name, stats: await this.deps.profiles.stats(auth.id) });
    this.broadcastLobby(out);
    this.save();
  }

  private async onProfileDelete(conn: Conn, seat: Seat, auth: { id: string; secret: string }, out: Out): Promise<void> {
    // Deleting needs the secret, which only the owner's device (or recovery code) holds.
    if (!(await this.deps.profiles.remove(auth.id, auth.secret))) return out.error(conn.id, 'profile_invalid', 'That recovery code did not match a profile.');
    for (const s of this.meta.seats) if (s.profileId === auth.id) s.profileId = null;
    out.send(conn.id, { t: 'error', code: 'profile_deleted', message: 'Profile deleted.' });
    this.broadcastLobby(out);
    this.save();
    void seat;
  }

  private async sendProfile(connId: string, seat: Seat, out: Out): Promise<void> {
    if (!seat.profileId) return;
    out.send(connId, { t: 'profile', id: seat.profileId, name: seat.name, stats: await this.deps.profiles.stats(seat.profileId) });
  }

  // ------------------------------------------------------------ fan-out
  private seatsPublic(): SeatPublic[] {
    const connected = new Set([...this.conns.values()].map((c) => c.seatId).filter((x): x is string => !!x));
    return this.meta.seats.map((s) => ({ id: s.id, name: s.name, isHost: s.isHost, connected: connected.has(s.id), bot: s.bot, hasProfile: !!s.profileId }));
  }

  private broadcastLobby(out: Out, now = this.clock): void {
    const m = this.meta;
    const base = {
      t: 'lobby' as const, phase: m.phase, seats: this.seatsPublic(), settings: m.settings, maxPlayers: this.deps.game.limits.maxPlayers,
      minPlayers: this.deps.game.limits.minPlayers, bots: m.numBots, locked: m.locked, inviteExpiresAt: m.inviteExpiresAt,
      turnTimerS: m.turnTimerS, botSpeed: m.botSpeed, usage: { fraction: this.usageFraction, warn: this.usageFraction >= this.cfg.quota.warnAtFraction },
    };
    const names = m.seats.map((s) => s.name.toLowerCase());
    const pending: PendingPublic[] = m.pending.map((p) => ({ id: p.id, name: p.name, dupName: names.includes(p.name.toLowerCase()) || m.pending.some((q) => q !== p && q.name.toLowerCase() === p.name.toLowerCase()), ageMs: now - p.at }));
    for (const c of this.conns.values()) {
      if (!c.seatId) continue;
      const seat = m.seats.find((s) => s.id === c.seatId);
      out.send(c.id, seat?.isHost ? { ...base, pending } : base);
    }
  }

  private sendState(out: Out, events: unknown[], only?: string): void {
    if (!this.instance || !this.state) return;
    const deadlines = this.instance.timers.deadlines();
    for (const c of this.conns.values()) {
      if (!c.seatId || (only && c.id !== only)) continue;
      const seat = this.meta.seats.find((s) => s.id === c.seatId);
      const msg: S2C = {
        t: 'state', view: this.instance.viewFor(this.state, c.seatId), events: this.instance.redactEvents(events, c.seatId),
        deadlines, now: this.clock, autopilot: seat?.bot === 'self' || seat?.bot === 'afk', thinking: this.thinking, turnDeadline: this.meta.waitDeadline,
        ...(c.sentCfg ? {} : { cfg: this.instance.clientConfig() }),
      };
      c.sentCfg = true;
      out.send(c.id, msg);
    }
  }

  // ------------------------------------------------------------ alarms
  async alarm(now: number): Promise<{ out: Out; dead: boolean }> {
    const out = new Out();
    const m = this.meta;
    this.clock = now;
    if (m.closing || this.expired(now)) return { out, dead: true };

    for (const c of [...this.conns.values()]) if (!c.seatId && !c.pendingId && now - c.at >= this.cfg.authTimeoutMs) { out.close(c.id, 1008, 'unauthenticated'); this.conns.delete(c.id); }

    const before = m.pending.length;
    m.pending = m.pending.filter((p) => now - p.at < this.cfg.joinRequestTtlMs);
    if (m.pending.length !== before) {
      for (const c of [...this.conns.values()]) if (c.pendingId && !m.pending.some((p) => p.id === c.pendingId)) { out.send(c.id, { t: 'rejected' }); out.close(c.id, 1008, 'expired'); this.conns.delete(c.id); }
      this.broadcastLobby(out, now);
    }

    if (this.instance && this.state && m.phase === 'playing') {
      let changed = false;
      const events: unknown[] = [];
      for (const a of this.instance.timers.due(now)) { const r = this.instance.reduce(this.state, a); if (r.ok) { this.state = r.state; events.push(...r.events); changed = true; } }
      if (m.waitDeadline !== null && now >= m.waitDeadline) {
        const w = this.instance.waitingOn(this.state);
        for (const id of w.seats as string[]) { const seat = m.seats.find((s) => s.id === id); if (seat && seat.bot === 'none') this.setBot(seat, 'afk'); }
        m.waitDeadline = null;
        changed = true;
        this.broadcastLobby(out, now);
      }
      if (m.botAt !== null && now >= m.botAt) {
        const plan = this.instance.bots.plan(this.state, this.botSeatIds());
        let moved = false;
        for (const a of plan) { const r = this.instance.reduce(this.state, a); if (r.ok) { this.state = r.state; events.push(...r.events); changed = true; moved = true; } }
        m.botFailures = moved ? 0 : (m.botFailures ?? 0) + 1;
      }
      await this.afterChange(out, now, changed, events);
    }

    if (this.counters.inbound + this.counters.connects > 0 && now - this.counters.lastFlush >= this.cfg.usageFlushMs) {
      const reqs = Math.ceil(this.counters.inbound / this.cfg.quota.inboundWsPerRequest) + this.counters.connects;
      this.counters = { inbound: 0, connects: 0, lastFlush: now };
      await this.deps.usage.add(reqs).catch(() => undefined);
      this.usageFraction = await this.deps.usage.fraction().catch(() => this.usageFraction);
    }
    this.save();
    return { out, dead: false };
  }

  private expired(now: number): boolean {
    const m = this.meta;
    if (m.phase === 'finished') return m.finishedAt !== null && now - m.finishedAt > this.cfg.finishedRoomTtlMs;
    const idle = now - m.lastActivity;
    return this.conns.size === 0 && idle > (m.phase === 'lobby' ? this.cfg.lobbyIdleTtlMs : this.cfg.gameIdleTtlMs);
  }

  /** Earliest time the room needs to wake, or null to hibernate. */
  nextAlarm(now: number): number | null {
    const m = this.meta;
    const times: number[] = [];
    if (m.closing) return now;
    if (m.botAt !== null) times.push(m.botAt);
    if (m.waitDeadline !== null) times.push(m.waitDeadline);
    const t = this.instance && this.state ? this.instance.timers.next() : null;
    if (t !== null) times.push(t);
    for (const p of m.pending) times.push(p.at + this.cfg.joinRequestTtlMs);
    for (const c of this.conns.values()) if (!c.seatId && !c.pendingId) times.push(c.at + this.cfg.authTimeoutMs);
    if (this.counters.inbound + this.counters.connects > 0) times.push(this.counters.lastFlush + this.cfg.usageFlushMs);
    times.push(m.phase === 'finished' && m.finishedAt !== null ? m.finishedAt + this.cfg.finishedRoomTtlMs + 1 : m.lastActivity + (m.phase === 'lobby' ? this.cfg.lobbyIdleTtlMs : this.cfg.gameIdleTtlMs) + 1);
    return times.length ? Math.max(Math.min(...times), now + 1) : null;
  }

  private save(): void {
    this.deps.store.put('meta', this.meta);
    if (this.state !== null) this.deps.store.put('game', { state: this.state });
  }

  // test/inspection helpers
  get phase(): Meta['phase'] { return this.meta.phase; }
  get rawState(): unknown { return this.state; }
}

export { randomHex };
