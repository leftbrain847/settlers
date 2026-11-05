import { configFromSettings, createGame, addPlayer, startGame, reduce, viewFor, redactEvents, playerVp, SYSTEM } from './engine/index.ts';
import type { Action, ActionType, GameConfig, GameEvent, GameState, GameView, ResMap, Settings } from './engine/index.ts';
import { botPlan, createBots, actionDelayMs } from './ai/driver.ts';
import type { Bots } from './ai/driver.ts';
import { TradeClock } from './clock.ts';
import { defineGame } from '@app-builder/host/turn/game';
import type { GameInstance, GameModule, GameResult } from '@app-builder/host/turn/game';

const START_RES = { none: 0, some: 5, plenty: 10 } as const;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const intIn = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined;

/** Untrusted lobby settings -> clamped Settings. Unknown keys are dropped; bad values fall back to defaults. */
export function parseSettings(raw: unknown): Settings | null {
  if (!isObj(raw)) return null;
  const base = configFromSettings({});
  const out: Settings = {};
  const set = <K extends keyof Settings>(k: K, v: Settings[K] | undefined): void => { if (v !== undefined) out[k] = v; };
  set('vp_to_win', intIn(raw.vp_to_win, 3, 100));
  set('board_rings', intIn(raw.board_rings, 2, 8));
  if (typeof raw.friendly_robber === 'boolean') out.friendly_robber = raw.friendly_robber;
  set('discard_threshold', intIn(raw.discard_threshold, 1, 50));
  set('max_roads', intIn(raw.max_roads, 1, 99));
  set('max_settlements', intIn(raw.max_settlements, 1, 99));
  set('max_cities', intIn(raw.max_cities, 1, 99));
  set('human_response_timer', intIn(raw.human_response_timer, 5, 600));
  set('counter_timer', intIn(raw.counter_timer, 3, 120));
  set('bot_offer_timer', intIn(raw.bot_offer_timer, 3, 120));
  if (raw.starting_resources === 'none' || raw.starting_resources === 'some' || raw.starting_resources === 'plenty') out.starting_resources = raw.starting_resources;
  if (isObj(raw.dev_cards)) {
    const dc: Record<string, number> = {};
    for (const id of Object.keys(base.dev_card_types)) { const n = intIn(raw.dev_cards[id], 0, 99); if (n !== undefined) dc[id] = n; }
    out.dev_cards = dc;
  }
  if (isObj(raw.port_counts)) {
    const pc: Record<string, number> = {};
    for (const id of Object.keys(base.port_types)) { const n = intIn(raw.port_counts[id], 0, 20); if (n !== undefined) pc[id] = n; }
    out.port_counts = pc;
  }
  return out;
}

const resMap = (v: unknown): ResMap | null => {
  if (!isObj(v)) return null;
  const out: ResMap = {};
  for (const [k, n] of Object.entries(v)) {
    if (!/^[a-z_]{1,24}$/.test(k) || typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 99) return null;
    out[k] = n;
  }
  return Object.keys(out).length ? out : null;
};
const str = (v: unknown, max = 32): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);

/** Strict, typed parse of a client action. System-only actions (trade_expire) can never come from a client. */
export function parseSettlersAction(type: string, params: unknown, playerId: string): Action | null {
  const p = params === undefined ? {} : params;
  if (!isObj(p)) return null;
  const mk = <T extends ActionType>(t: T, prm: Extract<Action, { type: T }>['params']): Action => ({ type: t, player_id: playerId, params: prm }) as Action;
  switch (type) {
    case 'roll_dice': return mk('roll_dice', {});
    case 'buy_dev_card': return mk('buy_dev_card', {});
    case 'end_turn': return mk('end_turn', {});
    case 'build': {
      const bt = str(p.building_type), loc = intIn(p.location, 0, 1_000_000);
      return bt && loc !== undefined ? mk('build', { building_type: bt, location: loc }) : null;
    }
    case 'play_dev_card': { const c = str(p.card_type); return c ? mk('play_dev_card', { card_type: c }) : null; }
    case 'dev_card_action': {
      const prm: { resources?: ResMap; resource?: string; location?: number; skip?: boolean } = {};
      if (p.resources !== undefined) { const r = resMap(p.resources); if (!r) return null; prm.resources = r; }
      if (p.resource !== undefined) { const r = str(p.resource); if (!r) return null; prm.resource = r; }
      if (p.location !== undefined) { const l = intIn(p.location, -1, 1_000_000); if (l === undefined) return null; prm.location = l; }
      if (p.skip !== undefined) { if (typeof p.skip !== 'boolean') return null; prm.skip = p.skip; }
      return mk('dev_card_action', prm);
    }
    case 'trade_bank': { const g = str(p.give_resource), w = str(p.want_resource); return g && w ? mk('trade_bank', { give_resource: g, want_resource: w }) : null; }
    case 'trade_offer': {
      const o = resMap(p.offering), r = resMap(p.requesting);
      if (!o || !r) return null;
      const counter = p.counter_to === undefined ? undefined : str(p.counter_to, 16);
      if (p.counter_to !== undefined && !counter) return null;
      return mk('trade_offer', { offering: o, requesting: r, ...(counter ? { counter_to: counter } : {}) });
    }
    case 'trade_respond': {
      const id = str(p.trade_id, 16);
      return id && (p.response === 'accept' || p.response === 'decline') ? mk('trade_respond', { trade_id: id, response: p.response }) : null;
    }
    case 'trade_accept': {
      const id = str(p.trade_id, 16);
      const who = p.accepter_id === undefined ? undefined : str(p.accepter_id, 16);
      if (!id || (p.accepter_id !== undefined && !who)) return null;
      return mk('trade_accept', { trade_id: id, ...(who ? { accepter_id: who } : {}) });
    }
    case 'trade_cancel': { const id = str(p.trade_id, 16); return id ? mk('trade_cancel', { trade_id: id }) : null; }
    case 'discard': { const r = resMap(p.resources); return r ? mk('discard', { resources: r }) : null; }
    case 'move_robber': { const h = intIn(p.hex_id, 0, 1_000_000); return h !== undefined ? mk('move_robber', { hex_id: h }) : null; }
    case 'steal': { const t = str(p.target_player, 16); return t ? mk('steal', { target_player: t }) : null; }
    default: return null;
  }
}

class SettlersInstance implements GameInstance<GameState, Action, GameView, GameEvent> {
  private cfg: GameConfig;
  private settings: Settings;
  private clock: TradeClock;
  private botMap: Bots = {};
  private botRng = { rng: (Math.random() * 4294967296) >>> 0 };

  constructor(settings: Settings) {
    this.settings = settings;
    this.cfg = configFromSettings(settings);
    this.clock = new TradeClock(this.cfg);
  }

  init(seats: { id: string; name: string; isBot: boolean }[], seed: number) {
    let s = createGame(this.cfg, { game_id: 'room', seed });
    for (const seat of seats) s = addPlayer(this.cfg, s, { name: seat.name, id: seat.id, is_ai: seat.isBot });
    return startGame(this.cfg, s, { starting_resources: START_RES[this.settings.starting_resources ?? 'none'], randomize_order: true });
  }

  parseAction = parseSettlersAction;

  reduce(state: GameState, action: Action) {
    const r = reduce(this.cfg, state, action);
    return r.ok ? { ok: true as const, state: r.state, events: r.events } : { ok: false as const, error: r.error };
  }

  viewFor(state: GameState, pid: string): GameView { return viewFor(this.cfg, state, pid); }
  redactEvents(events: GameEvent[], pid: string): GameEvent[] { return redactEvents(events, pid); }
  clientConfig(): GameConfig { return this.cfg; }
  isOver(state: GameState): boolean { return state.phase === 'finished'; }

  result(state: GameState): GameResult {
    const seats: GameResult['seats'] = {};
    for (const pid of state.player_order) {
      const p = state.players[pid]!;
      const trades = state.log.filter((e) => e.type === 'trade_accept' && (e.player === pid || e.from_player === pid)).length;
      seats[pid] = {
        won: state.winner === pid,
        score: playerVp(this.cfg, state, pid, true),
        extras: {
          longest_road: p.achievements.includes('longest_road') ? 1 : 0,
          largest_army: p.achievements.includes('largest_army') ? 1 : 0,
          cities: p.buildings_placed.city ?? 0,
          settlements: p.buildings_placed.settlement ?? 0,
          trades,
        },
      };
    }
    return { winner: state.winner, seats };
  }

  waitingOn(s: GameState): { key: string; seats: string[] } {
    const disc = Object.keys(s.pending_discards);
    if (disc.length) return { key: `d:${s.turn_number}:${disc.join(',')}`, seats: disc };
    if (s.phase === 'setup') {
      return { key: `s:${s.setup_round}:${s.setup_player_idx}:${s.setup_settlements_placed}:${s.setup_roads_placed}`, seats: [s.player_order[s.setup_player_idx]!] };
    }
    if (s.phase === 'playing') return { key: `t:${s.turn_number}`, seats: [s.player_order[s.current_player_idx]!] };
    return { key: 'none', seats: [] };
  }

  setSeatBot(state: GameState, seatId: string, isBot: boolean): GameState {
    const p = state.players[seatId];
    if (!p || p.is_ai === isBot) return state;
    return { ...state, players: { ...state.players, [seatId]: { ...p, is_ai: isBot } } };
  }

  timers = {
    sync: (state: GameState, now: number): void => this.clock.sync(state, now),
    due: (now: number): Action[] => this.clock.due(now).map((id) => ({ type: 'trade_expire', player_id: SYSTEM, params: { trade_id: id } }) as Action),
    next: (): number | null => this.clock.next(),
    deadlines: (): Record<string, number> => Object.fromEntries(this.clock.deadlines),
  };

  bots = {
    plan: (state: GameState, botSeats: string[]): Action[] => {
      for (const id of Object.keys(this.botMap)) if (!botSeats.includes(id)) delete this.botMap[id];
      for (const id of botSeats) if (!this.botMap[id]) Object.assign(this.botMap, createBots({ [id]: 'smart' }));
      return botPlan(this.cfg, state, this.botMap, this.botRng);
    },
    delayMs: (a: Action): number => actionDelayMs(a),
  };
}

export const settlersGame: GameModule<Settings, GameState, Action, GameView, GameEvent> = {
  id: 'settlers',
  limits: { minPlayers: 2, maxPlayers: 4 },
  defaultSettings: () => ({}),
  parseSettings,
  create: (settings) => new SettlersInstance(settings),
};

export const settlersModule = defineGame(settlersGame);
