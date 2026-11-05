import type { ProfileStore } from './profiles.ts';
import type { TurnRoom } from './room.ts';

/** Bindings of an invite-mode app's Worker (see the generated wrangler.toml). */
export interface TurnEnv {
  /** Secret (`wrangler secret put HOST_KEY`): creates rooms and signs room capabilities. Never in the repo. */
  HOST_KEY: string;
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace<TurnRoom>;
  PROFILES: DurableObjectNamespace<ProfileStore>;
  /** The account-wide meter in the platform Worker (by `script_name`), shared with every app. */
  USAGE: DurableObjectNamespace;
}
