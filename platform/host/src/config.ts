/** Host defaults. Every value is overridable: a game's `limits` override the room ones. */
export interface HostConfig {
  tickHz: number;
  snapshotHz: number;
  maxMsgBytes: number;
  maxInputsPerSec: number;
  /** Dropped inputs per second, sustained over `abuseWindowS`, that get a socket closed. */
  abuseDropsPerSec: number;
  abuseWindowS: number;
  /** A disconnected player's seat is held this long, in ms. */
  seatGraceMs: number;
  /** A room with nobody connected is deleted after this long, in ms. */
  emptyRoomTtlMs: number;
  /** Rooms and runs flush their usage tallies to the meter this often, in ms. */
  usageFlushMs: number;
  /** Access signing keys are cached this long, in ms (Access rotates them every 6 weeks; the old key stays valid 7 days). */
  accessKeysTtlMs: number;
  /** An unknown key id refetches them at most this often, in ms. */
  accessKeysMinRefreshMs: number;
  /** Allowed clock skew when checking token times, in seconds. */
  clockSkewS: number;
  solo: {
    /** An unfinished solo run is deleted after this long, in ms. */
    runTtlMs: number;
    /** Best scores kept per game. */
    scoresKept: number;
  };
  quota: {
    /** Workers Free: 100,000 requests/day; Durable Objects Free: 100,000 requests/day (Cloudflare docs, Oct 2026; re-verify). */
    dailyRequestBudget: number;
    /** Durable Objects bill 20 inbound WebSocket messages as one request. */
    inboundWsPerRequest: number;
    /** Durable Objects Free: 100,000 rows written/day. */
    dailyRowsWrittenBudget: number;
    warnAtFraction: number;
    /** Past this, new rooms and runs are refused. */
    hardStopAtFraction: number;
  };
}

export const HOST_CONFIG: HostConfig = {
  tickHz: 30,
  snapshotHz: 20,
  maxMsgBytes: 2048,
  maxInputsPerSec: 20,
  abuseDropsPerSec: 20,
  abuseWindowS: 5,
  seatGraceMs: 30_000,
  emptyRoomTtlMs: 5 * 60_000,
  usageFlushMs: 30_000,
  accessKeysTtlMs: 60 * 60_000,
  accessKeysMinRefreshMs: 60_000,
  clockSkewS: 60,
  solo: { runTtlMs: 6 * 60 * 60_000, scoresKept: 50 },
  quota: {
    dailyRequestBudget: 100_000,
    inboundWsPerRequest: 20,
    dailyRowsWrittenBudget: 100_000,
    warnAtFraction: 0.7,
    hardStopAtFraction: 0.95,
  },
};

let ACTIVE: HostConfig = HOST_CONFIG;

/** Per-app overrides of the host defaults (one app per Worker). Nested `solo` and `quota` merge key by key. */
export type HostOverrides = Partial<Omit<HostConfig, 'solo' | 'quota'>> & { solo?: Partial<HostConfig['solo']>; quota?: Partial<HostConfig['quota']> };

export function configureHost(o: HostOverrides = {}): void {
  ACTIVE = { ...HOST_CONFIG, ...o, solo: { ...HOST_CONFIG.solo, ...o.solo }, quota: { ...HOST_CONFIG.quota, ...o.quota } };
}

/** The host settings in force for this Worker. */
export const hostConfig = (): HostConfig => ACTIVE;
