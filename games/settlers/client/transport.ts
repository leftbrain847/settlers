// Settlers' view of the platform's turn transport: the same Snapshot/Transport shapes, typed with this game's
// view, events and config, plus what the in-tab (local) game saves and restores.
import type { KeyValueStore, Snapshot as TurnSnapshot, Transport as TurnTransport } from '@app-builder/client-sdk/turn/transport';
import type { Action, ActionType, GameConfig, GameEvent, GameView, Settings } from '../engine/types.ts';

export type { KeyValueStore };
export type StrategyName = 'random' | 'smart';
export type Snapshot = TurnSnapshot<GameView, GameEvent, GameConfig>;
export type Transport = TurnTransport<GameView, GameEvent, GameConfig, ActionType>;

export interface TransportOptions {
  settings?: Settings;
  name?: string;
  numBots?: number;
  seed: number;
  strategy?: StrategyName;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: Action[];
  autopilot?: boolean;
  speed?: number;
}

/** What LocalTransport.save() returns and the lobby reads back to resume. */
export interface SaveData {
  v: 1;
  settings: Settings;
  name: string;
  numBots: number;
  seed: number;
  strategy: StrategyName;
  log: Action[];
  autopilot: boolean;
  speed: number;
}
