/**
 * Defaults for turn-based, invite-link rooms. Every value is overridable per
 * app (`registerTurn(..., { host })`, from app.config.json); some are also
 * adjustable per room by its host. No magic numbers live in the logic.
 */
export const HOST_CONFIG = {
  maxMsgBytes: 4096,
  maxMsgsPerSec: 25,          // per connection; sustained excess disconnects
  abuseStrikesBeforeClose: 3,
  seatGraceMs: 30_000,
  lobbyIdleTtlMs: 2 * 3600_000,       // an unstarted room nobody is in
  gameIdleTtlMs: 7 * 24 * 3600_000,   // a started room nobody has touched
  finishedRoomTtlMs: 7 * 24 * 3600_000,
  inviteTtlMs: 24 * 3600_000,
  joinRequestTtlMs: 5 * 60_000,
  maxPendingJoins: 8,
  /** Sockets open at once per room (seated, waiting or not yet authenticated). */
  maxConnections: 24,
  /** A socket that hasn't sent join/resume after this long is closed, in ms. */
  authTimeoutMs: 15_000,
  /** Consecutive bot turns whose moves all fail before bots pause (a buggy bot can't loop alarms forever). */
  maxBotFailures: 5,
  nameMaxLen: 16,
  minHostKeyLength: 32,
  /** `POST /api/rooms` bodies larger than this are refused, in bytes. */
  createBodyMaxBytes: 1024,
  usageFlushMs: 30_000,
  botStepMs: 800,
  afkBotReleaseOnAction: true,
  quota: {
    dailyRequestBudget: 100_000,
    inboundWsPerRequest: 20,  // 20 inbound WS messages bill as one request
    warnAtFraction: 0.7,
    hardStopAtFraction: 0.95, // refuse NEW rooms past this
  },
};
export type HostConfig = typeof HOST_CONFIG;

/** Per-app overrides; `quota` merges key by key. */
export type TurnOverrides = Partial<Omit<HostConfig, 'quota'>> & { quota?: Partial<HostConfig['quota']> };

let ACTIVE: HostConfig = HOST_CONFIG;

export function configureTurn(o: TurnOverrides = {}): void {
  ACTIVE = { ...HOST_CONFIG, ...o, quota: { ...HOST_CONFIG.quota, ...o.quota } };
}

/** The turn-room settings in force for this Worker. */
export const turnConfig = (): HostConfig => ACTIVE;
