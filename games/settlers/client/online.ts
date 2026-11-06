// Online play: create/join a room, wait for approval, host controls, profiles. Renders into the app root until the game
// starts, then hands the WebSocket transport to the normal game screen.
import { h, mount, inputOf, selectOf } from './dom.ts';
import { defaults, toSettings } from './settings.ts';
import { settingsFields } from './settings-form.ts';
import { WsTransport as TurnWs } from '@app-builder/client-sdk/turn/ws';
import type { ActionType, GameConfig, GameEvent, GameView } from '../engine/types.ts';
import type { RoomInfo, SocketLike } from '@app-builder/client-sdk/turn/ws';
import type { KeyValueStore, Transport } from './transport.ts';
import type { HostCmd } from '@app-builder/host/turn/protocol';
import type { SettingValue } from './settings.ts';

/** The platform's room socket, typed with this game's shapes. */
class WsTransport extends TurnWs<GameView, GameEvent, GameConfig, ActionType> {}

const ROOMS_KEY = 'settlers.rooms.v1';
const PROFILE_KEY = 'settlers.profile.v1';
const HOSTKEY_KEY = 'settlers.hostkey.v1';

interface Session { token: string; name: string; host: boolean; invite?: { secret: string; expiresAt: number } }
interface StoredProfile { id: string; secret: string; name: string }

export interface OnlineEnv {
  origin: string;
  /** The app's path on the host (`/settlers`); '' when served from the root. */
  base?: string;
  path: string;
  hash: string;
  fetch: typeof fetch;
  makeSocket?: (url: string) => SocketLike;
  replaceUrl: (path: string) => void;
  copy: (text: string) => Promise<boolean>;
}

export interface AppLike {
  root: HTMLElement;
  storage: KeyValueStore | null;
  prefs: { name: string; values: Record<string, SettingValue> };
  savePrefs(): void;
  attach(t: Transport): void;
  showLobby(): void;
  toast(text: string, bad?: boolean): void;
  refresh(): void;
}

const randHex = (bytes: number): string => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
const read = <T,>(st: KeyValueStore | null, k: string): T | null => { try { return JSON.parse(st?.getItem(k) ?? 'null') as T | null; } catch { return null; } };
const write = (st: KeyValueStore | null, k: string, v: unknown): void => { try { st?.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };

declare const __BASE__: string | undefined;

export function defaultEnv(): OnlineEnv {
  return {
    origin: window.location.origin, base: typeof __BASE__ === 'string' ? __BASE__ : '', path: window.location.pathname, hash: window.location.hash,
    fetch: (...a) => window.fetch(...a),
    replaceUrl: (p) => { try { window.history.replaceState(null, '', p); } catch { /* sandboxed */ } },
    copy: async (text) => { try { await navigator.clipboard.writeText(text); return true; } catch { return false; } },
  };
}

const TIMER_CHOICES: [number, string][] = [[0, 'Off'], [30, '30 seconds'], [60, '1 minute'], [90, '90 seconds'], [120, '2 minutes'], [180, '3 minutes'], [300, '5 minutes']];
const SPEED_CHOICES: [number, string][] = [[0.5, '0.5x'], [1, '1x'], [2, '2x'], [4, '4x'], [0, 'Max']];

export class OnlineController {
  private app: AppLike;
  private env: OnlineEnv;
  private get base(): string { return this.env.base ?? ''; }
  t: WsTransport | null = null;
  cap: string | null = null;
  private attached = false;
  private hostBots = 1;
  private message = '';
  private wasReconnecting = false;

  constructor(app: AppLike, env: OnlineEnv) { this.app = app; this.env = env; }

  get isHost(): boolean { return !!this.t?.room.host; }
  get inRoom(): boolean { return !!this.t; }

  // ---------------------------------------------------------------- storage
  private sessions(): Record<string, Session> { return read<Record<string, Session>>(this.app.storage, ROOMS_KEY) ?? {}; }
  private saveSession(cap: string, s: Session): void { write(this.app.storage, ROOMS_KEY, { ...this.sessions(), [cap]: s }); }
  private forgetSession(cap: string): void { const all = this.sessions(); delete all[cap]; write(this.app.storage, ROOMS_KEY, all); }
  private profile(): StoredProfile | null { return read<StoredProfile>(this.app.storage, PROFILE_KEY); }
  /** The invite secret only ever reaches the host's device at creation or rotation, so it is kept in storage. */
  private currentInvite(r: RoomInfo): { secret: string; expiresAt: number } | null {
    return r.invite ?? (this.cap ? this.sessions()[this.cap]?.invite ?? null : null);
  }

  private inviteLink(cap: string, secret: string): string { return `${this.env.origin}${this.base}/r/${cap}#k=${secret}`; }

  // ---------------------------------------------------------------- entry points
  /** Home-screen card. */
  card(): HTMLElement {
    const sessions = Object.entries(this.sessions());
    const key = h('input#hostkey', { type: 'password', autocomplete: 'off', placeholder: 'Host key', value: (this.app.storage?.getItem(HOSTKEY_KEY) ?? '') });
    const error = h('p.err.small');
    return h('div.card.form',
      h('h3', 'Play with friends'),
      h('p.dim.small', 'To join a game, open the link your host sent you. To host, enter your host key.'),
      ...sessions.map(([cap, s]) => h('button.btn.rejoin', { onclick: () => this.rejoin(cap) }, s.host ? 'Return to your room' : `Rejoin as ${s.name}`)),
      h('details.settings', h('summary', 'Host a game'),
        h('label.field', h('span', 'Host key'), key),
        h('button.btn.primary#create-room', { onclick: () => { void this.createRoom((key as HTMLInputElement).value, error); } }, 'Create room'),
        error));
  }

  /** If the page was opened from an invite link, show the join screen. Returns true when handled. */
  openFromUrl(): boolean {
    const path = this.base && this.env.path.startsWith(`${this.base}/`) ? this.env.path.slice(this.base.length) : this.env.path;
    const m = /^\/r\/([0-9a-f]{32}\.[A-Za-z0-9_-]{22})\/?$/.exec(path);
    if (!m) return false;
    const cap = m[1]!;
    const k = /^#k=([0-9a-f]{32})$/.exec(this.env.hash)?.[1];
    if (this.sessions()[cap]) { this.rejoin(cap); return true; }
    if (!k) { this.screen('This link is missing its invite. Ask your host for a fresh link.'); return true; }
    this.joinScreen(cap, k);
    return true;
  }

  private async createRoom(hostKey: string, errorEl: HTMLElement): Promise<void> {
    errorEl.textContent = '';
    const key = hostKey.trim();
    if (!key) { errorEl.textContent = 'Enter your host key.'; return; }
    try {
      const r = await this.env.fetch(`${this.base}/api/rooms`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: this.app.prefs.name }) });
      if (r.status === 403) { errorEl.textContent = 'That host key was not accepted.'; return; }
      if (r.status === 503) { errorEl.textContent = 'The server is out of free capacity for today. Try again after 8 pm Eastern.'; return; }
      if (!r.ok) { errorEl.textContent = 'Could not create the room.'; return; }
      const room = (await r.json()) as { cap: string; invite: string; hostToken: string };
      try { this.app.storage?.setItem(HOSTKEY_KEY, key); } catch { /* optional */ }
      this.saveSession(room.cap, { token: room.hostToken, name: this.app.prefs.name, host: true, invite: { secret: room.invite, expiresAt: Date.now() + 24 * 3600_000 } });
      this.env.replaceUrl(`${this.base}/r/${room.cap}`);
      this.rejoin(room.cap);
    } catch { errorEl.textContent = 'Could not reach the server.'; }
  }

  private joinScreen(cap: string, invite: string): void {
    const name = h('input#join-name', { type: 'text', maxlength: 16, value: this.app.prefs.name === 'You' ? '' : this.app.prefs.name, placeholder: 'Your name' });
    mount(this.app.root, h('div.lobby', h('h1', 'Settlers'),
      h('div.card.form',
        h('p', 'You have been invited to a game.'),
        h('label.field', h('span', 'Your name'), name),
        h('button.btn.primary.big#ask-join', { onclick: () => {
          const n = (name as HTMLInputElement).value.trim() || 'Player';
          this.app.prefs.name = n; this.app.savePrefs();
          const token = randHex(16);
          this.saveSession(cap, { token, name: n, host: false });
          this.env.replaceUrl(`${this.base}/r/${cap}`); // the invite secret does not stay in the address bar
          this.connect(cap, token, { invite, name: n });
        } }, 'Ask to join'),
        h('p.dim.small', 'The host will let you in. You can use any name; stats are tied to a profile, not a name.'))));
  }

  rejoin(cap: string): void {
    const s = this.sessions()[cap];
    if (!s) { this.screen('That room is no longer available.'); return; }
    this.connect(cap, s.token);
  }

  private connect(cap: string, token: string, join?: { invite: string; name: string }): void {
    this.reset();
    this.cap = cap;
    const prof = this.profile();
    const t = new WsTransport({
      url: `${this.env.origin.replace(/^http/, 'ws')}${this.base}/ws/${cap}`, token, ...(join ? { join } : {}),
      ...(prof ? { profile: { id: prof.id, secret: prof.secret } } : {}),
      ...(this.env.makeSocket ? { makeSocket: this.env.makeSocket } : {}),
    });
    this.t = t;
    this.attached = false;
    t.onRoom((r) => this.onRoom(cap, r));
    t.subscribe(() => {
      if (!this.attached) { this.attached = true; this.app.attach(t); }
    });
    t.start();
  }

  reset(): void {
    this.t?.destroy();
    this.t = null; this.cap = null; this.attached = false;
  }

  // ---------------------------------------------------------------- room updates
  private onRoom(cap: string, r: RoomInfo): void {
    const prev = this.sessions()[cap];
    if (prev && r.status === 'joined') {
      const invite = r.invite ?? prev.invite;
      this.saveSession(cap, { ...prev, host: r.host, ...(invite ? { invite } : {}) });
    }
    if (r.profile?.secret) {
      const stored: StoredProfile = { id: r.profile.id, secret: r.profile.secret, name: r.profile.name };
      write(this.app.storage, PROFILE_KEY, stored);
    }
    if (['rejected', 'kicked', 'failed'].includes(r.status)) this.forgetSession(cap);
    if (r.reconnecting && !this.wasReconnecting) this.app.toast('Reconnecting…');
    this.wasReconnecting = r.reconnecting;
    if (this.attached) {
      if (['rejected', 'kicked', 'closed', 'failed'].includes(r.status)) this.terminal(r);
      else this.app.refresh();
      return;
    }
    this.renderPre(r);
  }

  private terminal(r: RoomInfo): void {
    const text = r.status === 'kicked' ? 'The host removed you from this room.' : r.status === 'closed' ? (r.error ?? 'The room was closed.') : 'You were disconnected.';
    this.screen(text);
  }

  private screen(text: string): void {
    this.reset();
    mount(this.app.root, h('div.lobby', h('h1', 'Settlers'), h('div.card.form', h('p#room-message', text), h('button.btn.primary.big#home', { onclick: () => { this.env.replaceUrl(`${this.base}/`); this.app.showLobby(); } }, 'Back to start'))));
  }

  // ---------------------------------------------------------------- pre-game screens
  private renderPre(r: RoomInfo): void {
    switch (r.status) {
      case 'connecting': mount(this.app.root, h('div.lobby', h('h1', 'Settlers'), h('p.dim#room-status', r.reconnecting ? 'Reconnecting…' : 'Connecting…'))); return;
      case 'failed': this.screen(r.error ?? 'This link is not valid any more.'); return;
      case 'rejected': this.screen('The host did not accept your request.'); return;
      case 'kicked': this.screen('The host removed you from this room.'); return;
      case 'closed': this.screen(r.error ?? 'The room was closed.'); return;
      case 'pending':
        mount(this.app.root, h('div.lobby', h('h1', 'Settlers'), h('div.card.form', h('p#room-status', 'Waiting for the host to let you in…'), h('p.dim.small', 'Keep this page open. You will join automatically.'),
          h('button.btn', { onclick: () => { if (this.cap) this.forgetSession(this.cap); this.env.replaceUrl(`${this.base}/`); this.app.showLobby(); } }, 'Cancel'))));
        return;
      case 'joined': this.roomLobby(r); return;
    }
  }

  private seatList(r: RoomInfo): HTMLElement {
    return h('div.list', (r.lobby?.seats ?? []).map((s) => h('div.row', h('div.row-main',
      h('strong', s.name + (s.id === r.seat ? ' (you)' : '')),
      h('span.dim.small', [s.isHost ? 'Host' : '', s.bot !== 'none' ? (s.bot === 'ai' ? 'Bot' : 'Bot playing for them') : s.connected ? 'Here' : 'Away', s.hasProfile ? 'Saving stats' : ''].filter(Boolean).join(' · '))))));
  }

  private roomLobby(r: RoomInfo): void {
    const t = this.t!;
    const lobby = r.lobby;
    const values = this.app.prefs.values;
    const copyBtn = (text: string, label: string): HTMLElement => h('button.btn.small', { onclick: () => { void this.env.copy(text).then((ok) => this.app.toast(ok ? 'Copied' : 'Select the link and copy it')); } }, label);
    const inv = this.currentInvite(r);
    const link = inv && this.cap ? this.inviteLink(this.cap, inv.secret) : null;
    const pending = lobby?.pending ?? [];

    const hostPart = r.host ? [
      h('div.card.form',
        h('h3', 'Invite friends'),
        link ? [h('code.link#invite-link', link), h('div.btnrow', copyBtn(link, 'Copy link'), h('button.btn.small', { onclick: () => t.hostCmd({ c: 'rotate_invite' }) }, 'New link'))]
          : h('button.btn', { onclick: () => t.hostCmd({ c: 'rotate_invite' }) }, 'Make an invite link'),
        h('label.field.check', h('input#lock', { type: 'checkbox', checked: !!lobby?.locked, onchange: (e) => t.hostCmd({ c: 'lock', on: inputOf(e).checked }) }), h('span', 'Stop accepting new requests')),
        pending.length ? h('h4', 'Waiting to join') : null,
        ...pending.map((p) => h('div.row', h('div.row-main', h('strong', p.name), p.dupName ? h('span.warn.small', 'Another person here has this name. Check who it is before accepting.') : null),
          h('button.btn.primary.approve', { onclick: () => t.hostCmd({ c: 'approve', request: p.id }) }, 'Let in'), h('button.btn.reject', { onclick: () => t.hostCmd({ c: 'reject', request: p.id }) }, 'No')))),
      h('div.card.form',
        h('h3', 'Game'),
        h('label.field', h('span', 'Bots to add'), h('select#room-bots', { onchange: (e) => { this.hostBots = Number(selectOf(e).value); } }, [0, 1, 2, 3].map((n) => h('option', { value: n, selected: n === this.hostBots }, `${n}`)))),
        h('details.settings', h('summary', 'Game settings'), ...settingsFields(values), h('button.btn.small', { type: 'button', onclick: () => { this.app.prefs.values = defaults(); this.app.savePrefs(); this.renderPre(this.t!.room); } }, 'Reset to defaults')),
        h('button.btn.primary.big#start-room', { disabled: (lobby?.seats.length ?? 0) + this.hostBots < (lobby?.minPlayers ?? 2), onclick: () => {
          this.app.savePrefs();
          t.hostCmd({ c: 'settings', settings: toSettings(values), bots: this.hostBots });
          t.hostCmd({ c: 'start' });
        } }, 'Start game')),
    ] : [h('div.card.form', h('p#room-status', 'Waiting for the host to start the game…'))];

    mount(this.app.root, h('div.lobby', h('h1', 'Settlers'),
      ...(lobby?.usage.warn ? [h('p.warn.small', 'The free daily capacity is running low. Games may stop until 8 pm Eastern.')] : []),
      h('div.card.form', h('h3', 'Players'), this.seatList(r)),
      ...hostPart,
      this.profileCard(r)));
  }

  // ---------------------------------------------------------------- profiles
  profileCard(r: RoomInfo): HTMLElement {
    const t = this.t!;
    const prof = this.profile();
    const code = h('input#recovery-input', { type: 'text', placeholder: 'Recovery code', autocomplete: 'off' });
    if (prof) {
      const recovery = `${prof.id}${prof.secret}`.replace(/(.{4})(?=.)/g, '$1-');
      const stats = r.profile?.stats;
      return h('div.card.form', h('h3', 'Your stats'),
        stats ? h('p#stats', `${stats.games} games, ${stats.wins} wins`) : h('p.dim.small', 'No finished games yet.'),
        h('p.dim.small', 'Recovery code (keep it private; it is the only way to use this profile on another device):'),
        h('code.link#recovery', recovery),
        h('div.btnrow', h('button.btn.small', { onclick: () => { void this.env.copy(recovery).then((ok) => this.app.toast(ok ? 'Copied' : 'Select the code and copy it')); } }, 'Copy code'),
          h('button.btn.small.danger', { onclick: () => { t.profileDelete({ id: prof.id, secret: prof.secret }); try { this.app.storage?.removeItem(PROFILE_KEY); } catch { /* ignore */ } this.app.refresh(); this.renderPre(t.room); } }, 'Delete profile')));
    }
    return h('div.card.form', h('h3', 'Save your stats (optional)'),
      h('p.dim.small', 'No account or email. A profile is stored on this device with a recovery code you can keep.'),
      h('button.btn#make-profile', { onclick: () => t.profileCreate() }, 'Save my stats'),
      h('label.field', h('span', 'Already have a recovery code?'), code),
      h('button.btn.small#use-recovery', { onclick: () => {
        const raw = (code as HTMLInputElement).value.replace(/[^0-9a-f]/gi, '').toLowerCase();
        if (raw.length !== 48) { this.app.toast('That code does not look right', true); return; }
        const id = raw.slice(0, 16), secret = raw.slice(16);
        write(this.app.storage, PROFILE_KEY, { id, secret, name: this.app.prefs.name });
        t.profileLink({ id, secret });
      } }, 'Use code'));
  }

  // ---------------------------------------------------------------- in-game menu
  /** Appended to the game menu while online. */
  menuSection(): HTMLElement | null {
    const t = this.t;
    if (!t) return null;
    const r = t.room;
    const lobby = r.lobby;
    const inv = this.currentInvite(r);
    const link = inv && this.cap ? this.inviteLink(this.cap, inv.secret) : null;
    const parts: (HTMLElement | null)[] = [h('h4', 'Room'), this.seatList(r)];
    if (r.host && lobby) {
      parts.push(
        h('label.field', h('span', 'Turn timer'), h('select#turn-timer', { onchange: (e) => t.hostCmd({ c: 'turn_timer', seconds: Number(selectOf(e).value) }) },
          TIMER_CHOICES.map(([s, l]) => h('option', { value: s, selected: s === lobby.turnTimerS }, l)))),
        h('label.field', h('span', 'Bot speed'), h('select#bot-speed', { onchange: (e) => t.hostCmd({ c: 'bot_speed', x: Number(selectOf(e).value) }) },
          SPEED_CHOICES.map(([x, l]) => h('option', { value: x, selected: x === lobby.botSpeed }, l)))),
        h('h4', 'Seats'),
        ...lobby.seats.filter((s) => !s.isHost).map((s) => h('div.row', h('div.row-main', h('strong', s.name), h('span.dim.small', s.bot === 'none' ? 'Playing' : s.bot === 'ai' ? 'Bot' : 'Bot is playing')),
          s.bot === 'ai' ? null : h('button.btn.small', { onclick: () => t.hostCmd({ c: 'bot_seat', seat: s.id, on: s.bot === 'none' } as HostCmd) }, s.bot === 'none' ? 'Bot plays' : 'Give back'),
          s.bot === 'ai' ? null : h('button.btn.small.danger', { onclick: () => t.hostCmd({ c: 'kick', seat: s.id }) }, 'Remove'))),
        ...(lobby.pending ?? []).map((p) => h('div.row', h('div.row-main', h('strong', p.name), h('span.dim.small', 'Wants to join'),
          p.dupName ? h('span.warn.small', 'Duplicate name') : null),
          h('select.seat-pick', { 'aria-label': `Seat for ${p.name}` }, lobby.seats.filter((s) => !s.isHost && s.bot !== 'none').map((s) => h('option', { value: s.id }, `Take over ${s.name}`))),
          h('button.btn.small.primary', { onclick: (e: MouseEvent) => { const pick = (e.currentTarget as HTMLElement).parentElement?.querySelector('select'); t.hostCmd({ c: 'approve', request: p.id, ...(pick && pick.value ? { seat: pick.value } : {}) }); } }, 'Let in'),
          h('button.btn.small', { onclick: () => t.hostCmd({ c: 'reject', request: p.id }) }, 'No'))),
        h('div.btnrow',
          h('button.btn.small', { onclick: () => t.hostCmd({ c: 'rotate_invite' }) }, 'New invite link'),
          h('button.btn.small', { onclick: () => t.hostCmd({ c: 'lock', on: !lobby.locked }) }, lobby.locked ? 'Allow requests' : 'Stop requests')),
        link ? h('code.link', link) : null,
        link ? h('button.btn.small', { onclick: () => { void this.env.copy(link).then((ok) => this.app.toast(ok ? 'Copied' : 'Select the link and copy it')); } }, 'Copy invite link') : null,
        h('button.btn.danger', { onclick: () => t.hostCmd({ c: 'close' }) }, 'Close room for everyone'));
    } else if (lobby) {
      parts.push(h('p.dim.small', lobby.turnTimerS ? `Turn timer: ${lobby.turnTimerS} seconds. A bot plays if you run out of time.` : 'No turn timer.'));
    }
    parts.push(this.profileCard(r));
    return h('div.list', parts);
  }
}
