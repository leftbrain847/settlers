import type { ScoresResponse } from './protocol';

export type ScoreEntry = ScoresResponse['scores'][number];

/** Shown to other players: the part of the email before the @, never the whole address. */
export function displayName(email: string): string {
  return email.split('@')[0] ?? '';
}

/** Each player's best only, highest first, at most `kept`. */
export function mergeScore(list: ScoreEntry[], entry: ScoreEntry, kept: number): ScoreEntry[] {
  const mine = list.find((e) => e.player === entry.player);
  if (mine && mine.score >= entry.score) return list;
  return [...list.filter((e) => e.player !== entry.player), entry].sort((a, b) => b.score - a.score || a.atMs - b.atMs).slice(0, kept);
}
