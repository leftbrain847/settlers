import type { GameModule, PlayerId } from './gameModule';
import type { ErrorCode, SoloSegmentResponse } from './protocol';

type AnyGame = GameModule<unknown, unknown, unknown, unknown>;

/** What a solo run's Durable Object stores. */
export interface SoloRecord {
  gameId: string;
  owner: PlayerId;
  seed: number;
  run: unknown;
  segments: number;
  createdMs: number;
}

export function startSolo(game: AnyGame, owner: PlayerId, seed: number, nowMs: number): SoloRecord | null {
  if (!game.solo) return null;
  return { gameId: game.id, owner, seed, run: game.solo.start(game.defaultConfig, seed), segments: 0, createdMs: nowMs };
}

export type SegmentOutcome =
  | { record: SoloRecord; response: SoloSegmentResponse; finished: boolean }
  | { record: SoloRecord | null; response: Extract<SoloSegmentResponse, { ok: false }>; finished: false };

const fail = (record: SoloRecord | null, code: ErrorCode): SegmentOutcome => ({ record, response: { ok: false, code }, finished: false });

/**
 * One submitted segment: only the run's owner, within the size limit, in the
 * game's strict schema, and only while the run is live. The game replays it
 * on the stored run; the score is what that replay says. A segment that
 * doesn't replay ends the run (no score).
 */
export function applySolo(game: AnyGame, record: SoloRecord, player: PlayerId, body: string): SegmentOutcome {
  const solo = game.solo;
  if (!solo || record.gameId !== game.id) return fail(record, 'not_found');
  if (record.owner !== player) return fail(record, 'rejected');
  if (solo.isOver(record.run)) return fail(record, 'rejected');
  if (new TextEncoder().encode(body).byteLength > solo.maxSegmentBytes) return fail(record, 'bad_message');
  if (record.segments >= solo.maxSegments) return fail(null, 'rejected');
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return fail(record, 'bad_message');
  }
  const segment = solo.parseSegment(raw);
  if (segment === null) return fail(record, 'bad_message');
  const out = solo.apply(game.defaultConfig, record.run, segment);
  if ('error' in out) return fail(null, 'rejected');
  const next: SoloRecord = { ...record, run: out.run, segments: record.segments + 1 };
  const over = solo.isOver(out.run);
  return { record: next, response: { ok: true, score: solo.score(out.run), over }, finished: over };
}
