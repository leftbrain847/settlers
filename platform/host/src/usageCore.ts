import type { HostConfig } from './config';
import type { UsageResponse } from './protocol';

/** One UTC day's usage, as the meter stores it. */
export interface UsageDay {
  day: string;
  workerRequests: number;
  objectRequests: number;
  inboundWs: number;
  rowsWritten: number;
}

export type UsageDelta = Omit<UsageDay, 'day'>;

export const emptyDelta = (): UsageDelta => ({ workerRequests: 0, objectRequests: 0, inboundWs: 0, rowsWritten: 0 });

/** Quotas reset at 00:00 UTC. */
export const utcDay = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);

export function addUsage(day: UsageDay, d: UsageDelta): UsageDay {
  return {
    day: day.day,
    workerRequests: day.workerRequests + d.workerRequests,
    objectRequests: day.objectRequests + d.objectRequests,
    inboundWs: day.inboundWs + d.inboundWs,
    rowsWritten: day.rowsWritten + d.rowsWritten,
  };
}

/** The tightest of the daily free allowances, as a fraction used. */
export function usageReport(day: UsageDay, cfg: HostConfig): UsageResponse {
  const q = cfg.quota;
  const objectBilled = day.objectRequests + day.inboundWs / q.inboundWsPerRequest;
  const used = Math.max(day.workerRequests, objectBilled);
  const fraction = Math.max(used / q.dailyRequestBudget, day.rowsWritten / q.dailyRowsWrittenBudget);
  return { day: day.day, used: Math.round(used), budget: q.dailyRequestBudget, fraction, warn: fraction >= q.warnAtFraction, hardStop: fraction >= q.hardStopAtFraction };
}

/**
 * Tallies kept in memory and flushed to the meter at most every `flushMs`, so
 * counting requests doesn't cost a request each.
 */
export class UsageTally {
  private pending = emptyDelta();
  private lastFlushMs = 0;

  private readonly flushMs: number;

  constructor(flushMs: number) {
    this.flushMs = flushMs;
  }

  add(d: Partial<UsageDelta>): void {
    this.pending.workerRequests += d.workerRequests ?? 0;
    this.pending.objectRequests += d.objectRequests ?? 0;
    this.pending.inboundWs += d.inboundWs ?? 0;
    this.pending.rowsWritten += d.rowsWritten ?? 0;
  }

  /** The tally to send now, or `null` if it isn't time yet (or there's nothing). */
  due(nowMs: number, force = false): UsageDelta | null {
    const p = this.pending;
    const empty = p.workerRequests + p.objectRequests + p.inboundWs + p.rowsWritten === 0;
    if (empty || (!force && nowMs - this.lastFlushMs < this.flushMs)) return null;
    this.pending = emptyDelta();
    this.lastFlushMs = nowMs;
    return p;
  }
}
