/** Wire types shared by the host and the client SDK. */

/** Every WebSocket message: `{ t: type, s: sequence, d: data }`. */
export interface Envelope<T extends string = string, D = unknown> {
  t: T;
  s: number;
  d: D;
}

/** Client → server over a room socket. */
export type ClientMessage = Envelope<'input', unknown> | Envelope<'ping', null>;

/** Server → client over a room socket. */
export type ServerMessage =
  | Envelope<'welcome', { seat: number; players: number; gameId: string }>
  | Envelope<'view', unknown>
  | Envelope<'over', unknown>
  | Envelope<'pong', null>
  | Envelope<'error', { code: ErrorCode }>;

/** Deliberately coarse: no detail that would help someone probe the host. */
export type ErrorCode = 'bad_message' | 'rate_limited' | 'room_full' | 'not_found' | 'over_budget' | 'rejected';

/** `POST /api/solo/:gameId/start` → */
export interface SoloStartResponse {
  runId: string;
  seed: number;
}

/** `POST /api/solo/:gameId/:runId/segment` → */
export type SoloSegmentResponse = { ok: true; score: number; over: boolean } | { ok: false; code: ErrorCode };

/** `GET /api/solo/:gameId/scores` → best scores, highest first. */
export interface ScoresResponse {
  scores: { player: string; score: number; atMs: number }[];
}

/** `GET /api/usage` → today's request budget. */
export interface UsageResponse {
  day: string;
  used: number;
  budget: number;
  fraction: number;
  warn: boolean;
  hardStop: boolean;
}
