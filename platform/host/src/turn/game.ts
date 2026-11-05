import type { HostConfig } from './config.ts';

export interface SeatInfo { id: string; name: string; isBot: boolean }

export interface GameResult {
  winner: string | null;
  seats: Record<string, { won: boolean; score: number; extras: Record<string, number> }>;
}

/** One running game (rules bound to its settings). State is plain JSON; everything else lives inside the instance. */
export interface GameInstance<State, Action, View, Event> {
  init(seats: SeatInfo[], seed: number): { state: State; events: Event[] };
  /** Strict parse of an untrusted client action. The host fixes player_id; clients can never author system actions. */
  parseAction(type: string, params: unknown, playerId: string): Action | null;
  reduce(state: State, action: Action): { ok: true; state: State; events: Event[] } | { ok: false; error: string };
  viewFor(state: State, playerId: string): View;
  redactEvents(events: Event[], playerId: string): Event[];
  /** Static data a client needs once (rules, names). */
  clientConfig(): unknown;
  isOver(state: State): boolean;
  result(state: State): GameResult;
  /** Seats the game is waiting on (turn owner, pending discards). `key` changes when a new decision begins. */
  waitingOn(state: State): { key: string; seats: string[] };
  /** Flip a seat between human and bot control. */
  setSeatBot(state: State, seatId: string, isBot: boolean): State;
  timers: {
    sync(state: State, now: number): void;
    due(now: number): Action[];
    next(): number | null;
    /** Seconds remaining per open timer (public: the UI draws countdown bars). */
    deadlines(): Record<string, number>;
  };
  bots: {
    plan(state: State, botSeats: string[]): Action[];
    delayMs(a: Action): number;
  };
}

export interface GameModule<Settings, State, Action, View, Event> {
  id: string;
  limits: { minPlayers: number; maxPlayers: number };
  defaultSettings(): Settings;
  /** Validate and clamp untrusted lobby settings. null = reject. */
  parseSettings(raw: unknown): Settings | null;
  create(settings: Settings, host: HostConfig): GameInstance<State, Action, View, Event>;
}

/** The host handles every game through this erased shape; only `defineGame` casts, in one place. */
export type ErasedGame = GameModule<unknown, unknown, unknown, unknown, unknown>;
export function defineGame<S, St, A, V, E>(m: GameModule<S, St, A, V, E>): ErasedGame {
  return m as unknown as ErasedGame;
}
