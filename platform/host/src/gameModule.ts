/**
 * The plug-in contract every game implements. Game code is pure and
 * deterministic: no I/O, no clock, no `Math.random()`; randomness comes from a
 * seed in state. That keeps it testable outside Cloudflare and lets the host
 * replay it to check results.
 */

/** A player's identity: their verified Cloudflare Access email. Never client-supplied. */
export type PlayerId = string;

export interface GameLimits {
  /** Server simulation rate, in Hz. `0` = turn-based: no loop, the room sleeps between moves and state is saved after each one. */
  tickHz: number;
  /** How often views are sent, in Hz (can be below `tickHz`). */
  snapshotHz: number;
  minPlayers: number;
  maxPlayers: number;
  /** Inbound messages larger than this are rejected before parsing, in bytes. */
  maxMsgBytes: number;
  /** Per player; the excess is dropped and counted. */
  maxInputsPerSec: number;
}

/** A real-time room game: the server runs the simulation; clients send intentions. */
export interface GameModule<Cfg, State, Input, View> {
  id: string;
  /** All tunables live here. */
  defaultConfig: Cfg;
  /** Overrides `HOST_CONFIG` for this game. */
  limits: GameLimits;
  /** Strict schema check: anything unknown or malformed → `null` (rejected). */
  parseInput(raw: unknown): Input | null;
  init(cfg: Cfg, players: PlayerId[], seed: number): State;
  onInput(state: State, player: PlayerId, input: Input, nowMs: number): void;
  /** One fixed timestep. Not called in turn-based rooms (`tickHz: 0`), so those can leave it out. */
  tick?(state: State, dtMs: number): void;
  /** Only what this player may see: the only path from state to the wire. */
  viewFor(state: State, player: PlayerId): View;
  isOver(state: State): boolean;
  /** Present when the game also supports solo runs played locally and checked by replay (see `SoloVerifier`). */
  solo?: SoloVerifier<Cfg, unknown, unknown>;
}

/**
 * Solo runs, played in the browser for zero-latency feel and checked by the
 * server. The server issues the seed, the client plays and submits each
 * segment (e.g. one play) as the inputs it fed the sim, and the server
 * replays the segment from its own copy of the run. The score the server
 * computes is the only one recorded.
 */
export interface SoloVerifier<Cfg, Run, Segment> {
  /** A new run from a server-issued seed. */
  start(cfg: Cfg, seed: number): Run;
  /** Strict schema check of a submitted segment; `null` = reject. */
  parseSegment(raw: unknown): Segment | null;
  /** Replay one segment on top of `run`. An error means the submission doesn't fit the rules. */
  apply(cfg: Cfg, run: Run, segment: Segment): { run: Run } | { error: string };
  isOver(run: Run): boolean;
  score(run: Run): number;
  /** Segments larger than this are rejected before parsing, in bytes. */
  maxSegmentBytes: number;
  /** A run with more segments than this is abandoned. */
  maxSegments: number;
}
