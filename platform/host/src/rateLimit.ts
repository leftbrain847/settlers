/**
 * Per-player input limit: at most `perSec` inputs in each wall-clock second;
 * the excess is dropped and counted. Drops sustained above `abusePerSec`
 * across the last `windowS` seconds mean the socket should be closed.
 */
export interface RateLimit {
  perSec: number;
  abusePerSec: number;
  windowS: number;
}

export interface RateState {
  second: number;
  used: number;
  /** Drops per second, newest last, at most `windowS` entries. */
  drops: { second: number; n: number }[];
}

export const freshRate = (): RateState => ({ second: -1, used: 0, drops: [] });

export type RateVerdict = 'ok' | 'drop' | 'abuse';

export function admit(r: RateState, limit: RateLimit, nowMs: number): RateVerdict {
  const second = Math.floor(nowMs / 1000);
  if (second !== r.second) {
    r.second = second;
    r.used = 0;
  }
  r.drops = r.drops.filter((d) => d.second > second - limit.windowS);
  if (r.used < limit.perSec) {
    r.used++;
    return 'ok';
  }
  const last = r.drops[r.drops.length - 1];
  if (last && last.second === second) last.n++;
  else r.drops.push({ second, n: 1 });
  const total = r.drops.reduce((t, d) => t + d.n, 0);
  return total > limit.abusePerSec * limit.windowS ? 'abuse' : 'drop';
}
