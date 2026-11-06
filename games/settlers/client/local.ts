import { configFromSettings, createGame, addPlayer, startGame, reduce, viewFor, redactEvents, SYSTEM } from '../engine/index.ts';
import { botPlan, createBots, actionDelayMs } from '../ai/driver.ts';
import { TradeClock } from '../clock.ts';
import type { Action, ActionType, GameConfig, GameEvent, GameState, ReduceResult, Settings } from '../engine/types.ts';
import type { SaveData, Snapshot, StrategyName, Transport, TransportOptions } from './transport.ts';

export const HUMAN = 'p1';
export const SPEEDS: number[] = [0.5, 1, 2, 4, Infinity];
const START_RES: Record<string, number> = { none: 0, some: 5, plenty: 10 };

type Bots = ReturnType<typeof createBots>;
type Listener = (s: Snapshot) => void;

/**
 * Single-player transport: the whole game runs in this tab. The UI only talks to
 * subscribe()/send(), so the online transport (WebSocket to a Durable Object) is a drop-in swap.
 */
export class LocalTransport implements Transport {
  settings: Settings;
  name: string;
  numBots: number;
  seed: number;
  strategy: StrategyName;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  cfg: GameConfig;
  listeners: Set<Listener>;
  actionLog: Action[];
  pumping: boolean;
  destroyed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  autopilot: boolean;
  speed: number;
  state: GameState;
  bots: Bots;
  botRng: { rng: number };
  clock: TradeClock;
  startEvents: GameEvent[];

  constructor({ settings = {}, name = 'You', numBots = 2, seed, strategy = 'smart', now = () => Date.now(), sleep, log = [], autopilot = false, speed = 1 }: TransportOptions) {
    this.settings = settings; this.name = name; this.numBots = numBots; this.seed = seed >>> 0; this.strategy = strategy;
    this.now = now;
    this.sleep = sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.cfg = configFromSettings(settings);
    this.listeners = new Set();
    this.actionLog = [];
    this.pumping = false;
    this.destroyed = false;
    this.timer = null;
    this.autopilot = false;
    this.speed = speed >= 1e9 ? Infinity : speed;

    let s = createGame(this.cfg, { game_id: `local-${this.seed.toString(36)}`, seed: this.seed });
    s = addPlayer(this.cfg, s, { name, id: HUMAN });
    const spec: Record<string, StrategyName> = {};
    for (let i = 0; i < numBots; i++) {
      const id = `p${i + 2}`;
      s = addPlayer(this.cfg, s, { name: `Bot ${i + 1}`, id, is_ai: true });
      spec[id] = strategy;
    }
    this.state = startGame(this.cfg, s, { starting_resources: START_RES[settings.starting_resources ?? 'none'] ?? 0, randomize_order: true }).state;
    this.bots = createBots(spec);
    this.botRng = { rng: (this.seed ^ 0x9e3779b9) >>> 0 };
    this.clock = new TradeClock(this.cfg);
    this.startEvents = [{ type: 'game_started' }];
    for (const a of log) { const r = reduce(this.cfg, this.state, a); if (r.ok) { this.state = r.state; this.actionLog.push(a); } }
    this.botRng.rng = (this.botRng.rng + this.actionLog.length) >>> 0;
    this.clock.sync(this.state, this.now());
    if (autopilot) this.applyAutopilot(true);
  }

  // Hand the human seat to a bot (or take it back). Not part of the game log: it is a seat setting, not a move.
  applyAutopilot(on: boolean): void {
    const p = this.state.players[HUMAN];
    this.state = { ...this.state, players: { ...this.state.players, [HUMAN]: { ...p, is_ai: on } } };
    if (on) this.bots[HUMAN] = createBots({ [HUMAN]: this.strategy })[HUMAN];
    else delete this.bots[HUMAN];
    this.autopilot = on;
  }

  setAutopilot(on: boolean): void {
    if (on === this.autopilot) return;
    this.applyAutopilot(on);
    this.emit([]);
    void this.pump();
  }

  setSpeed(x: number): void { this.speed = x; this.emit([]); }

  subscribe(fn: Listener): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }

  snapshot(events: GameEvent[] = [], extra: { thinking?: string | null; error?: string } = {}): Snapshot {
    return {
      view: viewFor(this.cfg, this.state, HUMAN),
      events: redactEvents(events, HUMAN),
      cfg: this.cfg,
      deadlines: Object.fromEntries(this.clock.deadlines),
      now: this.now(),
      autopilot: this.autopilot,
      speed: this.speed,
      ...extra,
    };
  }

  emit(events: GameEvent[], extra?: { thinking?: string | null; error?: string }): void {
    const snap = this.snapshot(events, extra);
    for (const fn of this.listeners) fn(snap);
  }

  start(): void { this.emit([]); void this.pump(); }

  apply(action: Action): ReduceResult {
    const r = reduce(this.cfg, this.state, action);
    if (!r.ok) return r;
    this.state = r.state;
    this.actionLog.push(action);
    this.clock.sync(this.state, this.now());
    this.emit(r.events);
    return r;
  }

  /** The human's only way to act. `player_id` is always forced to the human seat. */
  send(type: ActionType, params: object = {}): ReduceResult {
    const r = this.apply({ type, player_id: HUMAN, params } as Action);
    if (!r.ok) this.emit([], { error: r.error });
    else void this.pump();
    return r;
  }

  save(): SaveData {
    return { v: 1, settings: this.settings, name: this.name, numBots: this.numBots, seed: this.seed, strategy: this.strategy, log: this.actionLog, autopilot: this.autopilot, speed: this.speed };
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.listeners.clear();
  }

  async pump(): Promise<void> {
    if (this.pumping || this.destroyed) return;
    this.pumping = true;
    let rejected = 0;
    try {
      for (let i = 0; i < 5000 && !this.destroyed; i++) {
        const due = this.clock.due(this.now());
        if (due.length) {
          for (const id of due) this.apply({ type: 'trade_expire', player_id: SYSTEM, params: { trade_id: id } });
          continue;
        }
        const plan = botPlan(this.cfg, this.state, this.bots, this.botRng);
        if (!plan.length) break;
        this.emit([], { thinking: plan[0].player_id });
        const version = this.actionLog.length;
        await this.sleep(this.speed === Infinity ? 0 : actionDelayMs(plan[0]) / this.speed);
        if (this.destroyed) break;
        if (this.actionLog.length !== version) continue; // the human acted while we waited: replan
        for (const a of plan) {
          if (a.player_id !== SYSTEM && !this.bots[a.player_id]) break; // seat was taken back while we waited
          const r = this.apply(a);
          if (!r.ok) { rejected++; console.warn('bot move rejected', r.error, a); }
        }
        if (rejected > 3) break;
      }
    } finally {
      this.pumping = false;
      if (!this.destroyed) {
        this.emit([], { thinking: null });
        const next = this.clock.next();
        if (this.timer !== null) clearTimeout(this.timer);
        if (next !== null) this.timer = setTimeout(() => { void this.pump(); }, Math.max(50, next - this.now()));
      }
    }
  }
}
