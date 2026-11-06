/**
 * The UI's only door to a turn-based game: a local in-tab game or a room over a
 * WebSocket (`WsTransport`). Typed by the game's own view, event and config
 * shapes so the platform never needs to know them.
 */

/** Everything the UI needs to draw one frame. Produced by a transport; never mutated by the UI. */
export interface Snapshot<View = unknown, Event = unknown, Cfg = unknown> {
  view: View;
  events: Event[];
  cfg: Cfg;
  /** timer id -> epoch ms at which it fires */
  deadlines: Record<string, number>;
  now: number;
  autopilot: boolean;
  speed: number;
  thinking?: string | null;
  error?: string;
}

export interface Transport<View = unknown, Event = unknown, Cfg = unknown, ActionType extends string = string> {
  subscribe(fn: (s: Snapshot<View, Event, Cfg>) => void): () => void;
  start(): void;
  send(type: ActionType, params?: object): void;
  setAutopilot(on: boolean): void;
  setSpeed(x: number): void;
  destroy(): void;
  save?(): unknown;
}

/** Minimal storage surface (localStorage satisfies it; so does an in-memory fake). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
