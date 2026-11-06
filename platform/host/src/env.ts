import type { AccessEnv } from './auth';

export interface Env extends AccessEnv {
  /** The built game client (Workers Static Assets, served only after auth: `run_worker_first`). */
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace;
  RUNS: DurableObjectNamespace;
  SCORES: DurableObjectNamespace;
  USAGE: DurableObjectNamespace;
}

/**
 * The verified player, passed from the Worker to a Durable Object. Objects are
 * reachable only through the Worker (no route of their own), and the Worker
 * builds every object request from scratch, so a client can't set this.
 */
export const PLAYER_HEADER = 'X-Verified-Player';

/** Base for Worker → object requests (the host part is ignored). */
export const OBJECT_URL = 'https://object.internal';

/** The single usage meter. */
export const meter = (env: Env): DurableObjectStub => env.USAGE.get(env.USAGE.idFromName('global'));
