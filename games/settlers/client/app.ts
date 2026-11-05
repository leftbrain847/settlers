import { h, sv, mount, inputOf, selectOf } from './dom.ts';
import { applyTheme, THEMES } from './theme.ts';
import { BoardView } from './board-svg.ts';
import { Board3DView, webglAvailable } from './board3d/view.ts';
import type { Look } from './board3d/view.ts';
import { PALETTE_IDS } from './board3d/style.ts';
import type { PaletteId } from './board3d/style.ts';
import type { BoardTap } from './board-svg.ts';
import { LocalTransport, SPEEDS } from './local.ts';
import { describeEvent } from './format.ts';
import { newSeed } from '../engine/index.ts';
import { defaults, toSettings } from './settings.ts';
import { settingsFields } from './settings-form.ts';
import { OnlineController, defaultEnv } from './online.ts';
import { icon, resIcon } from './icons.ts';
import { Fx } from './fx.ts';
import type { FxAnchors, Pt } from './fx.ts';
import type { OnlineEnv } from './online.ts';
import type { SettingValue } from './settings.ts';
import * as sheets from './sheets.ts';
import { handOf, isLegal } from './ui-types.ts';
import type { BoardRenderer, BoardTargets, Kind, Mode, Move, SheetCtx, SheetName, UiState } from './ui-types.ts';
import type { ActionParams, ActionType, GameConfig, GameView, LegalAction, TradeOffer } from '../engine/types.ts';
import type { KeyValueStore, SaveData, Snapshot, Transport, TransportOptions } from './transport.ts';

const SAVE_KEY = 'settlers.save.v1';
const PREF_KEY = 'settlers.prefs.v1';

type BoardLook = 'realistic' | 'civ' | 'tabletop' | 'flat';
interface Prefs {
  theme: string; look: BoardLook; name: string; bots: number; watch: boolean; speed: number;
  values: Record<string, SettingValue>;
}
type Sleep = (ms: number) => Promise<void>;
type MakeTransport = (o: TransportOptions) => Transport;
interface Dom {
  fx: HTMLElement; bank: HTMLElement; live: HTMLElement;
  status: HTMLElement; dice: HTMLElement; watch: HTMLElement; speed: HTMLElement; menu: HTMLElement;
  players: HTMLElement; banner: HTMLElement; board: HTMLElement | SVGElement; hand: HTMLElement; actions: HTMLElement;
  toasts: HTMLElement; sheetHost: HTMLElement; overlay: HTMLElement;
}
type SheetSpec =
  | { type: 'discard' | 'steal' | 'yop' | 'monopoly'; title: string; modal: true }
  | { type: 'incoming'; title: string; modal: true; offer: TradeOffer }
  | { type: 'waiting'; title: string; modal: true; offer: TradeOffer; counters: TradeOffer[] }
  | { type: SheetName; title: string; modal?: false };

/** A die face drawn as pips, so the number reads at a glance. */
function dieFace(n: number): SVGElement {
  const spots: Record<number, [number, number][]> = { 1: [[12, 12]], 2: [[7, 7], [17, 17]], 3: [[7, 7], [12, 12], [17, 17]], 4: [[7, 7], [17, 7], [7, 17], [17, 17]], 5: [[7, 7], [17, 7], [12, 12], [7, 17], [17, 17]], 6: [[7, 6.5], [17, 6.5], [7, 12], [17, 12], [7, 17.5], [17, 17.5]] };
  return sv('svg', { viewBox: '0 0 24 24', width: 24, height: 24, class: 'face' }, ...(spots[n] ?? []).map(([x, y]) => sv('circle', { cx: x, cy: y, r: 2.2 })));
}

function safeStorage(): KeyValueStore | null {
  try { const s = window.localStorage; s.setItem('__t', '1'); s.removeItem('__t'); return s; } catch { return null; }
}
// Storage holds only what this app wrote; a corrupt value just falls back to defaults at the call site.
const readJson = <T,>(st: KeyValueStore | null, k: string): T | null => { try { return JSON.parse(st?.getItem(k) ?? 'null') as T | null; } catch { return null; } };
const writeJson = (st: KeyValueStore | null, k: string, v: unknown): void => { try { st?.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable: play on */ } };

declare const __ONLINE__: boolean | undefined;
const ONLINE_BUILD = typeof __ONLINE__ === 'undefined' || __ONLINE__;

export interface BootOptions { storage?: KeyValueStore | null; makeTransport?: MakeTransport; autoSleep?: Sleep; online?: OnlineEnv | false }

export function boot(root: HTMLElement, { storage = safeStorage(), makeTransport = (o) => new LocalTransport(o), autoSleep, online }: BootOptions = {}): App {
  const env = online === false || !ONLINE_BUILD ? null : (online ?? defaultEnv());
  const app = new App(root, storage, makeTransport, autoSleep, env);
  if (!app.online?.openFromUrl()) app.showLobby();
  return app;
}

const emptyUi = (): UiState => ({ sheet: null, draft: {}, pending: null, buildMode: null, toasts: [], muteUntilTurn: 0, lastSaved: 0 });

export class App {
  root: HTMLElement;
  storage: KeyValueStore | null;
  makeTransport: MakeTransport;
  sleep: Sleep | undefined;
  prefs: Prefs;
  ui: UiState;
  snap: Snapshot | null;
  t: Transport | null;
  dom!: Dom;
  board!: BoardRenderer;
  mode: Mode | null = null;
  declining = false;
  fx: Fx | null = null;
  /** things that just appeared: animate them once, not on every redraw */
  fresh = { i: new Map<number, number>(), e: new Map<number, number>(), chips: new Map<string, number>(), badges: new Map<string, number>(), dice: 0 };
  online: OnlineController | null;

  constructor(root: HTMLElement, storage: KeyValueStore | null, makeTransport: MakeTransport, sleep: Sleep | undefined, onlineEnv: OnlineEnv | null = null) {
    this.online = onlineEnv ? new OnlineController(this, onlineEnv) : null;
    this.root = root; this.storage = storage; this.makeTransport = makeTransport; this.sleep = sleep;
    this.prefs = { theme: 'natural', look: 'realistic', name: 'You', bots: 2, watch: false, speed: 1, values: defaults(), ...(readJson<Partial<Prefs>>(storage, PREF_KEY) ?? {}) };
    applyTheme(this.prefs.theme);
    this.ui = emptyUi();
    this.snap = null;
    this.t = null;
  }

  /** The active transport; only valid while a game screen is up. */
  get tr(): Transport {
    if (!this.t) throw new Error('No game is running');
    return this.t;
  }

  /** The 3D board's look follows the color theme: the Night theme plays after dark. */
  look3d(): Look {
    const style = this.prefs.look === 'flat' ? 'realistic' : this.prefs.look;
    const palette = (PALETTE_IDS as string[]).includes(this.prefs.theme) ? (this.prefs.theme as PaletteId) : 'natural';
    return { style, palette, light: this.prefs.theme === 'night' ? 'night' : 'day' };
  }

  lookField(onChange: (v: BoardLook) => void, id?: string): HTMLElement {
    const opts: [BoardLook, string][] = [['realistic', '3D Realistic'], ['civ', '3D Civ'], ['tabletop', '3D Tabletop'], ['flat', 'Flat (lightweight)']];
    return h('label.field', h('span', 'Board view'), h(id ? `select#${id}` : 'select', { onchange: (e) => onChange(selectOf(e).value as BoardLook) }, opts.map(([k, t]) => h('option', { value: k, selected: k === this.prefs.look }, t))));
  }

  savePrefs(): void { writeJson(this.storage, PREF_KEY, this.prefs); }

  // ------------------------------------------------------------------ lobby
  showLobby(): void {
    this.online?.reset();
    this.t?.destroy(); this.t = null; this.snap = null;
    this.board?.destroy();
    const p = this.prefs;
    const saved = readJson<SaveData>(this.storage, SAVE_KEY);
    const fieldEls = settingsFields(p.values);

    const lobby = h('div.lobby',
      h('h1', 'Settlers'),
      h('p.dim', 'Play against bots, or with friends.'),
      h('div.card.form',
        h('label.field', h('span', 'Your name'), h('input#name', { type: 'text', value: p.name, maxlength: 16, onchange: (e) => { p.name = inputOf(e).value.trim() || 'You'; } })),
        h('label.field', h('span', 'Bot opponents'), h('select#bots', { onchange: (e) => { p.bots = Number(selectOf(e).value); } }, [1, 2, 3].map((n) => h('option', { value: n, selected: n === p.bots }, `${n} bot${n > 1 ? 's' : ''}`)))),
        h('label.field.check', h('input#watch', { type: 'checkbox', checked: !!p.watch, onchange: (e) => { p.watch = inputOf(e).checked; } }), h('span', 'Watch only: a bot plays my seat too')),
        this.lookField((v) => { p.look = v; }, 'look'),
        h('label.field', h('span', 'Color theme'), h('select#theme', { onchange: (e) => { p.theme = applyTheme(selectOf(e).value); } }, Object.entries(THEMES).map(([k, t]) => h('option', { value: k, selected: k === p.theme }, t.label)))),
        h('details.settings', h('summary', 'Game settings'), ...fieldEls,
          h('button.btn.small', { type: 'button', onclick: () => { p.values = defaults(); this.savePrefs(); this.showLobby(); } }, 'Reset to defaults')),
        h('button.btn.primary.big#start', { onclick: () => this.start() }, 'Start game'),
        saved ? h('button.btn#resume', { onclick: () => this.resume(saved) }, 'Resume saved game') : null),
      this.online?.card() ?? null);
    mount(this.root, lobby);
  }

  start(): void {
    const p = this.prefs;
    this.savePrefs();
    this.launch({ settings: toSettings(p.values), name: p.name, numBots: p.bots, seed: newSeed(), autopilot: p.watch, speed: p.speed });
  }

  resume(saved: SaveData): void {
    this.launch({ settings: saved.settings, name: saved.name, numBots: saved.numBots, seed: saved.seed, strategy: saved.strategy, log: saved.log, autopilot: saved.autopilot, speed: this.prefs.speed });
  }

  launch(opts: Omit<TransportOptions, 'sleep'>): void {
    const t = this.makeTransport({ ...opts, sleep: this.sleep });
    this.attach(t);
    t.start();
  }

  /** Show the game screen for a transport that is already (or about to be) running. */
  attach(t: Transport): void {
    this.t = t;
    this.snap = null;
    this.ui = emptyUi();
    this.buildGameDom();
    t.subscribe((snap) => this.onSnapshot(snap));
  }

  refresh(): void { this.render(); }

  // ------------------------------------------------------------------ game dom
  buildGameDom(): void {
    this.board?.destroy();
    const flatSurface = (): SVGSVGElement => sv<SVGSVGElement>('svg#board', { xmlns: 'http://www.w3.org/2000/svg', preserveAspectRatio: 'xMidYMid meet' });
    const onTap = (t: BoardTap): void => this.onBoardTap(t);
    let surface: HTMLElement | SVGElement;
    if (this.prefs.look !== 'flat' && webglAvailable()) {
      surface = h<HTMLCanvasElement>('canvas#board');
      try { this.board = new Board3DView(surface as HTMLCanvasElement, { onTap, look: () => this.look3d() }); } catch { surface = flatSurface(); this.board = new BoardView(surface as SVGSVGElement, { onTap }); }
    } else {
      surface = flatSurface();
      this.board = new BoardView(surface as SVGSVGElement, { onTap });
    }
    this.dom = {
      status: h('div.status'), dice: h('div.dice'), watch: h('button.pill#watch', { onclick: () => this.tr.setAutopilot(!this.snap?.autopilot) }), speed: h('button.pill#speed', { 'aria-label': 'Playback speed', onclick: () => this.cycleSpeed() }), menu: h('button.icon#menu', { 'aria-label': 'Menu', onclick: () => this.openSheet('menu') }, '☰'),
      players: h('div.players'), banner: h('div.banner'), board: surface, hand: h('div.hand'), actions: h('div.actions'),
      toasts: h('div.toasts'), sheetHost: h('div.sheet-host'), overlay: h('div.overlay'),
      fx: h('div.fx'), bank: h('div.bank', { 'aria-label': 'Bank and development card deck' }), live: h('div.sr', { 'aria-live': 'polite' }),
    };
    this.fx = new Fx(this.dom.fx);
    mount(this.root,
      h('div.game',
        h('div.top', this.dom.status, this.dom.dice, this.dom.watch, this.dom.speed, this.dom.menu),
        this.dom.players,
        h('div.boardwrap', surface, this.dom.bank, this.dom.banner, this.dom.toasts),
        h('div.dock', this.dom.hand, this.dom.actions),
        this.dom.sheetHost, this.dom.overlay, this.dom.fx, this.dom.live));
  }

  send = <T extends ActionType>(type: T, params?: ActionParams[T]): void => { this.tr.send(type, params); };

  cycleSpeed(): void {
    const i = SPEEDS.indexOf(this.snap?.speed ?? 1);
    const next = SPEEDS[(i + 1) % SPEEDS.length];
    this.prefs.speed = next === Infinity ? 1e9 : next;
    this.savePrefs();
    this.tr.setSpeed(next);
  }

  openSheet(type: SheetName): void { this.ui.sheet = this.ui.sheet === type ? null : type; this.render(); }

  onBoardTap({ kind, id }: BoardTap): void {
    const mode = this.mode;
    if (mode && mode.kind === kind && mode.ids.has(id)) this.ui.pending = { kind, id };
    else this.ui.pending = null;
    this.render();
  }

  // ------------------------------------------------------------------ snapshots
  onSnapshot(snap: Snapshot): void {
    this.snap = snap;
    const v = snap.view;
    this.noteFresh(snap.events);
    const spoken = snap.events.map((ev) => describeEvent(ev, v, snap.cfg)).filter((x): x is string => !!x);
    if (spoken.length) this.dom.live.textContent = spoken.join('. ');
    if (snap.error) this.toast(snap.error, true);
    if (snap.events.length) this.persist();
    // Leaving a decision resets any half-made choice.
    if (this.ui.pending && !this.targetsFor(v, snap.cfg)?.ids.has(this.ui.pending.id)) this.ui.pending = null;
    if (this.ui.buildMode && !v.legal_actions.filter(isLegal('build')).some((a) => a.building_type === this.ui.buildMode)) this.ui.buildMode = null;
    this.autoDecline(v);
    this.render();
    this.fx?.play(snap.events, v, snap.cfg, this.anchors(), snap.speed);
  }

  /** Remember what is new so the next redraw can animate it once. */
  noteFresh(events: Snapshot['events']): void {
    const f = this.fresh;
    const now = Date.now();
    for (const ev of events) {
      if (ev.type === 'building_placed') (ev.location_type === 'edge' ? f.e : f.i).set(Number(ev.location), now);
      else if (ev.type === 'free_road_built') f.e.set(Number(ev.location), now);
      else if (ev.type === 'turn_started') f.chips.set(String(ev.player), now);
      else if (ev.type === 'achievement_gained') f.badges.set(`${String(ev.player)}:${String(ev.achievement)}`, now);
      else if (ev.type === 'dice_rolled') f.dice = now;
    }
  }

  anchors(): FxAnchors {
    const centre = (el: Element | null): Pt | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    const me = this.snap?.view.me;
    return {
      seat: (id, res) => centre(id === me && res ? this.dom.hand.querySelector(`[data-res="${res}"]`) : id === me ? this.dom.hand : this.dom.players.querySelector(`[data-seat="${id}"]`)),
      bank: () => centre(this.dom.bank),
      center: () => centre(this.dom.board),
      board: (kind, id) => this.board.clientPoint(kind, id),
      bump: (id) => {
        const el = id === me ? this.dom.hand : this.dom.players.querySelector(`[data-seat="${id}"]`);
        if (!el) return;
        el.classList.remove('bump'); void (el as HTMLElement).offsetWidth; el.classList.add('bump');
      },
    };
  }

  persist(): void {
    if (!this.storage || !this.t?.save || !this.snap) return;
    const v = this.snap.view;
    if (v.phase === 'finished') { try { this.storage.removeItem(SAVE_KEY); } catch { /* ignore */ } } else writeJson(this.storage, SAVE_KEY, this.t.save());
  }

  toast(text: string, bad = false): void {
    const item = { text, bad, id: Math.random() };
    this.ui.toasts.push(item);
    if (this.ui.toasts.length > 3) this.ui.toasts.shift();
    setTimeout(() => { this.ui.toasts = this.ui.toasts.filter((t) => t !== item); if (this.dom && this.snap) this.renderToasts(); }, 3200);
  }

  autoDecline(v: GameView): void {
    if (!this.ui.muteUntilTurn || v.turn_number >= this.ui.muteUntilTurn || this.declining) return;
    const t = this.trades(v).incoming[0];
    if (!t) return;
    this.declining = true;
    queueMicrotask(() => { this.declining = false; this.send('trade_respond', { trade_id: t.id, response: 'decline' }); });
  }

  // ------------------------------------------------------------------ derived UI state
  trades(v: GameView): { mine: TradeOffer[]; incoming: TradeOffer[]; countersToMe: TradeOffer[] } {
    const counters = new Set(Object.values(v.trade_offers).flatMap((o) => o.counter_ids));
    const out: { mine: TradeOffer[]; incoming: TradeOffer[]; countersToMe: TradeOffer[] } = { mine: [], incoming: [], countersToMe: [] };
    for (const o of Object.values(v.trade_offers)) {
      const isCounter = counters.has(o.id);
      if (o.from_player === v.me) { if (!isCounter) out.mine.push(o); } else if (isCounter) { if (v.current_player === v.me) out.countersToMe.push(o); } else if (!(v.me in o.responses)) out.incoming.push(o);
    }
    return out;
  }

  targetsFor(v: GameView, cfg: GameConfig): Mode | null {
    if (this.snap?.autopilot) return null;
    const legal = v.legal_actions;
    const myTurn = v.current_player === v.me;
    const fromBuild = (list: Extract<LegalAction, { type: 'build' }>[], bt: string): Mode => {
      const kind: Kind = cfg.building_types[bt].placement.location_type === 'edge' ? 'e' : 'i';
      return { kind, ids: new Set(list.map((a) => a.location)), piece: bt, apply: (id): Move => ['build', { building_type: bt, location: id }], label: `Place ${cfg.building_types[bt].name.toLowerCase()} here` };
    };
    if (v.phase === 'setup') {
      const b = legal.filter(isLegal('build'));
      return b.length ? fromBuild(b, b[0].building_type) : null;
    }
    if (v.phase !== 'playing' || !myTurn) return null;
    if (v.pending_robber_move) {
      return { kind: 'h', ids: new Set(legal.filter(isLegal('move_robber')).map((a) => a.hex_id)), apply: (id): Move => ['move_robber', { hex_id: id }], label: 'Move the robber here' };
    }
    if (v.pending_action?.type === 'build_free_roads') {
      const spots = legal.filter(isLegal('dev_card_action')).filter((a) => a.location !== undefined && a.location !== -1);
      return { kind: 'e', ids: new Set(spots.map((a) => a.location as number)), piece: 'road', apply: (id): Move => ['dev_card_action', { location: id }], label: 'Build free road here' };
    }
    const bm = this.ui.buildMode;
    if (bm) return fromBuild(legal.filter(isLegal('build')).filter((a) => a.building_type === bm), bm);
    return null;
  }

  /** What the local player should do next, as icons (plus a plain label for screen readers). Null = nothing to prompt. */
  promptFor(v: GameView): { icons: string[]; count?: number; label: string } | null {
    if (v.phase === 'finished' || this.snap?.autopilot) return null;
    const n = v.pending_discards[v.me];
    if (n) return { icons: ['card'], count: n, label: `Discard ${n} cards` };
    if (v.current_player !== v.me) return null;
    const pieceIcon: Record<string, string> = { settlement: 'house', city: 'city', road: 'road' };
    if (v.phase === 'setup') return { icons: [v.setup.settlements_placed < 1 ? 'house' : 'road'], label: v.setup.settlements_placed < 1 ? 'Place a settlement' : 'Place a road next to it' };
    if (v.pending_robber_move) return { icons: ['robber'], label: 'Move the robber' };
    if (v.pending_robber_steal) return { icons: ['robber', 'card'], label: 'Choose who to steal from' };
    const pa = v.pending_action;
    if (pa?.type === 'build_free_roads') return { icons: ['road'], count: pa.remaining, label: `Build ${pa.remaining} free roads` };
    if (pa?.type === 'choose_resources') return { icons: ['plenty'], label: 'Choose resources' };
    if (pa?.type === 'choose_monopoly_resource') return { icons: ['crown'], label: 'Choose a resource' };
    if (!v.dice_rolled) return { icons: ['dice'], label: 'Your turn: roll the dice' };
    if (this.ui.buildMode) return { icons: [pieceIcon[this.ui.buildMode] ?? 'house'], label: 'Tap a highlighted spot' };
    return null;
  }

  // ------------------------------------------------------------------ render
  render(): void {
    if (!this.snap || !this.dom) return;
    const { view: v, cfg } = this.snap;
    this.mode = this.targetsFor(v, cfg);
    const ghost = this.mode && this.ui.pending ? { kind: this.mode.kind, id: this.ui.pending.id, type: this.mode.piece, player: v.me } : null;
    this.pruneFresh();
    const targets: BoardTargets = { fresh: { i: this.fresh.i, e: this.fresh.e }, pictures: this.prefs.theme === 'pastel' };
    if (this.mode) { targets[this.mode.kind] = this.mode.ids; targets.ghost = ghost; }
    this.board.update(v, cfg, targets);

    const me = v.players[v.me];
    this.dom.status.textContent = v.phase === 'setup' ? 'Setup' : v.phase === 'finished' ? 'Game over' : `Turn ${v.turn_number}`;
    const tumble = this.fresh.dice ? '.roll' : '';
    const resumeDice: Record<string, string> = this.fresh.dice ? { animationDelay: `${-(Date.now() - this.fresh.dice)}ms` } : {};
    mount(this.dom.dice, ...(v.last_roll ? v.last_roll.map((n) => h('span.die' + tumble, { 'aria-label': String(n), style: resumeDice }, dieFace(n))) : [h('span.die.off', icon('dice', 20)), h('span.die.off', icon('dice', 20))]), v.last_roll ? h('span.dice-total', v.last_roll.reduce((a, b) => a + b, 0)) : null);

    mount(this.dom.players, ...v.player_order.map((id, i) => {
      const p = v.players[id];
      const badges = p.achievements.map((a) => h('span.badge' + (this.fresh.badges.has(`${id}:${a}`) ? '.pop' : ''), { title: cfg.achievements[a]?.name, style: this.fresh.badges.has(`${id}:${a}`) ? { animationDelay: `${-(Date.now() - this.fresh.badges.get(`${id}:${a}`)!)}ms` } : {} }, icon(a === 'longest_road' ? 'road' : a === 'largest_army' ? 'sword' : 'star', 12)));
      const knights = p.played_dev_cards.filter((c) => cfg.dev_card_types[c]?.persistent_tag === 'knight').length;
      const owes = v.pending_discards[id];
      const thinking = this.snap?.thinking === id && id !== v.me;
      return h('div.pchip' + (id === v.current_player && v.phase !== 'finished' ? '.active' : '') + (id === v.me ? '.me' : '') + (this.fresh.chips.has(id) ? '.turn' : ''), { style: { '--pc': `var(--p${i})`, ...(this.fresh.chips.has(id) ? { animationDelay: `${-(Date.now() - this.fresh.chips.get(id)!)}ms` } : {}) }, dataset: { seat: id }, 'aria-label': `${p.name}${id === v.me ? ' (you)' : ''}, ${p.vp} points` },
        h('span.dot'), h('span.pname', p.name), h('span.pvp', icon('star', 13), String(p.vp)),
        h('span.pmeta', icon('card', 13), String(p.resource_count), icon('deck', 13), String(p.dev_card_count), knights ? [icon('knight', 13), String(knights)] : null, owes ? h('span.owes', icon('card', 12), `-${owes}`) : null),
        ...badges, thinking ? h('span.think', h('i'), h('i'), h('i')) : null);
    }));

    const fmtSpeed = (x: number): string => (x === Infinity || x >= 1e9 ? 'Max' : `${x}x`);
    this.dom.watch.textContent = this.snap.autopilot ? 'Take over' : 'Watch';
    this.dom.watch.classList.toggle('on', !!this.snap.autopilot);
    this.dom.speed.textContent = fmtSpeed(this.snap.speed);
    this.dom.speed.hidden = !!this.online?.inRoom && !this.online.isHost;
    const prompt = this.promptFor(v);
    mount(this.dom.banner, ...(prompt ? [...prompt.icons.map((n) => icon(n, 22)), prompt.count ? h('span.cnt', `×${prompt.count}`) : null] : []));
    this.dom.banner.setAttribute('aria-label', prompt?.label ?? '');
    this.dom.banner.hidden = !prompt;
    this.dom.banner.classList.toggle('urgent', !!prompt);
    const deck = v.dev_cards_remaining;
    mount(this.dom.bank, icon('bank', 22), icon('deck', 18), h('span.cnt', String(deck)));
    this.renderToasts();

    mount(this.dom.hand, ...Object.keys(cfg.resource_types).map((r) => h('div.hcard', { style: { '--c': `var(--r-${r})` }, dataset: { res: r }, 'aria-label': `${handOf(me)[r] ?? 0} ${cfg.resource_types[r].name}` }, icon(resIcon(r), 22), h('span.hn', handOf(me)[r] ?? 0))),
      h('div.hcard.dev', { dataset: { res: 'dev' }, 'aria-label': `${me.dev_card_count} development cards` }, icon('deck', 22), h('span.hn', me.dev_card_count)));
    this.dom.hand.parentElement?.classList.toggle('mine', v.current_player === v.me && v.phase !== 'finished' && !this.snap.autopilot);

    this.renderActions(v, cfg);
    this.renderSheet(v, cfg);
    this.renderOverlay(v, cfg);
  }

  /** Markers live for about a second so any redraw in that window keeps the animation going. */
  pruneFresh(): void {
    const cutoff = Date.now() - 1000;
    const f = this.fresh;
    for (const m of [f.i, f.e, f.chips, f.badges] as Map<unknown, number>[]) for (const [k, t] of m) if (t < cutoff) m.delete(k);
    if (f.dice < cutoff) f.dice = 0;
  }

  renderToasts(): void {
    mount(this.dom.toasts, ...this.ui.toasts.map((t) => h('div.toast' + (t.bad ? '.bad' : ''), t.text)));
  }

  renderActions(v: GameView, _cfg: GameConfig): void {
    const legal = v.legal_actions;
    const has = (t: LegalAction['type']): boolean => legal.some((a) => a.type === t);
    const btns: HTMLElement[] = [];
    const b = (label: string, onclick: () => void, o: { primary?: boolean; cls?: string; disabled?: boolean; icon?: string } = {}): void => { btns.push(h('button.btn' + (o.primary ? '.primary' : '') + (o.cls ? '.' + o.cls : ''), { onclick, disabled: o.disabled }, o.icon ? icon(o.icon, 18) : null, label)); };

    if (v.phase === 'finished') { mount(this.dom.actions); return; }
    if (this.snap?.autopilot) { b('Take over my seat', () => this.tr.setAutopilot(false), { primary: true }); mount(this.dom.actions, ...btns); return; }
    const mode = this.mode;
    const pending = this.ui.pending;
    if (pending && mode) {
      b('Confirm', () => { const [type, params] = mode.apply(pending.id); this.ui.pending = null; this.ui.buildMode = null; this.tr.send(type, params); }, { primary: true });
      b('Cancel', () => { this.ui.pending = null; this.render(); });
    } else if (this.ui.buildMode) {
      b('Cancel building', () => { this.ui.buildMode = null; this.render(); });
    } else if (v.pending_action?.type === 'build_free_roads' && v.current_player === v.me) {
      if (legal.filter(isLegal('dev_card_action')).some((a) => a.skip)) b('Skip', () => this.send('dev_card_action', { skip: true, location: -1 }), { primary: true });
    } else if (v.phase === 'playing' && v.current_player === v.me && !v.pending_robber_move && !v.pending_robber_steal && !v.pending_action && !Object.keys(v.pending_discards).length) {
      if (!v.dice_rolled) {
        b('Roll dice', () => this.send('roll_dice'), { primary: true, cls: 'big', icon: 'dice' });
        if (has('play_dev_card')) b('Dev cards', () => this.openSheet('dev'));
      } else {
        b('Build', () => this.openSheet('build'), { icon: 'house', disabled: !(has('build') || has('buy_dev_card')) });
        b('Trade', () => this.openSheet('trade'), { icon: 'swap' });
        b(`Dev (${v.players[v.me].dev_card_count})`, () => this.openSheet('dev'), { disabled: !v.players[v.me].dev_card_count });
        b('End turn', () => { this.ui.sheet = null; this.send('end_turn'); }, { primary: true });
      }
    } else if (v.players[v.me].dev_card_count) {
      b(`Dev (${v.players[v.me].dev_card_count})`, () => this.openSheet('dev'));
    }
    mount(this.dom.actions, ...btns);
  }

  autoSheet(v: GameView): SheetSpec | null {
    if (v.phase === 'finished' || this.snap?.autopilot) return null;
    if (v.pending_discards[v.me]) return { type: 'discard', title: 'Discard cards', modal: true };
    const myTurn = v.current_player === v.me;
    if (myTurn && v.pending_robber_steal) return { type: 'steal', title: 'Steal from', modal: true };
    if (myTurn && v.pending_action?.type === 'choose_resources') return { type: 'yop', title: 'Year of Plenty', modal: true };
    if (myTurn && v.pending_action?.type === 'choose_monopoly_resource') return { type: 'monopoly', title: 'Monopoly', modal: true };
    const t = this.trades(v);
    if (t.incoming.length && !(this.ui.muteUntilTurn && v.turn_number < this.ui.muteUntilTurn)) return { type: 'incoming', title: 'Trade offer', modal: true, offer: t.incoming[0] };
    if (t.mine.length) return { type: 'waiting', title: 'Your offer', modal: true, offer: t.mine[0], counters: t.countersToMe };
    return null;
  }

  renderSheet(v: GameView, cfg: GameConfig): void {
    if (!this.snap) return;
    const titles: Record<SheetName, string> = { build: 'Build', trade: 'Trade', dev: 'Development cards', log: 'Game log', menu: 'Menu' };
    const chosen: SheetSpec | null = this.autoSheet(v) ?? (this.ui.sheet ? { type: this.ui.sheet, title: titles[this.ui.sheet] } : null);
    if (!chosen) { mount(this.dom.sheetHost); return; }
    const ctx: SheetCtx = { view: v, cfg, ui: this.ui, snap: this.snap, send: this.send, rerender: () => this.render() };
    const body = sheets.withCtx(ctx, (): HTMLElement => {
      switch (chosen.type) {
        case 'discard': return sheets.discardSheet(ctx);
        case 'steal': return sheets.stealSheet(ctx);
        case 'yop': return sheets.yopSheet(ctx);
        case 'monopoly': return sheets.monopolySheet(ctx);
        case 'incoming': return sheets.incomingSheet({ ...ctx, offer: chosen.offer });
        case 'waiting': return sheets.waitingSheet({ ...ctx, offer: chosen.offer, counters: chosen.counters });
        case 'build': return sheets.buildSheet(ctx);
        case 'dev': return sheets.devSheet(ctx);
        case 'trade': return sheets.tradeSheet(ctx);
        case 'log': return sheets.logSheet(ctx);
        case 'menu': return this.menuSheet(v, cfg);
      }
    });
    mount(this.dom.sheetHost,
      h('div.backdrop' + (chosen.modal ? '.modal' : ''), { onclick: () => { if (!chosen.modal) { this.ui.sheet = null; this.render(); } } }),
      h('div.sheet', { role: 'dialog', 'aria-label': chosen.title },
        h('div.sheet-head', h('strong', chosen.title), chosen.modal ? null : h('button.icon', { 'aria-label': 'Close', onclick: () => { this.ui.sheet = null; this.render(); } }, '✕')),
        h('div.sheet-body', body)));
  }

  menuSheet(v: GameView, cfg: GameConfig): HTMLElement {
    return h('div.list',
      h('label.field', h('span', 'Color theme'), h('select', { onchange: (e) => { this.prefs.theme = applyTheme(selectOf(e).value); this.savePrefs(); this.render(); } }, Object.entries(THEMES).map(([k, t]) => h('option', { value: k, selected: k === this.prefs.theme }, t.label)))),
      this.lookField((v) => { this.prefs.look = v; this.savePrefs(); this.buildGameDom(); this.ui.sheet = null; this.render(); }),
      h('button.btn', { onclick: () => { this.ui.sheet = 'log'; this.render(); } }, 'Game log'),
      h('button.btn', { onclick: () => { this.board.resetZoom(); this.ui.sheet = null; this.render(); } }, 'Reset board zoom'),
      h('p.dim.small', `${cfg.name} · ${cfg.win_conditions[0]?.params.threshold} VP to win · ${v.board.rings} rings`),
      this.online?.inRoom ? this.online.menuSection() : null,
      h('button.btn.danger', { onclick: () => { if (this.ui.confirmLeave) this.showLobby(); else { this.ui.confirmLeave = true; this.render(); } } }, this.ui.confirmLeave ? 'Tap again to leave (progress is saved)' : 'Leave game'));
  }

  renderOverlay(v: GameView, _cfg: GameConfig): void {
    if (v.phase !== 'finished') { mount(this.dom.overlay); return; }
    const rows = [...v.player_order].sort((a, b) => v.players[b].vp - v.players[a].vp).map((id) => h('div.score' + (id === v.winner ? '.win' : ''), h('span', v.players[id].name), h('strong', `${v.players[id].vp} VP`)));
    mount(this.dom.overlay, h('div.winner', h('h2', v.winner === v.me ? 'You win!' : `${v.winner ? v.players[v.winner].name : ''} wins`), ...rows, h('button.btn.primary.big', { onclick: () => this.showLobby() }, 'New game')));
  }
}
