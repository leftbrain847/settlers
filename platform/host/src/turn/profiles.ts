import { DurableObject } from 'cloudflare:workers';
import type { TurnEnv } from './env.ts';
import type { GameResult } from './game.ts';
import { ProfilesCore } from './profiles_core.ts';
import type { Stats } from './protocol.ts';
import { kvStore } from './room.ts';

/** Optional player profiles for one app, in one instance. Called over RPC by rooms only: never reachable from the internet. */
export class ProfileStore extends DurableObject<TurnEnv> {
  private core: ProfilesCore;
  constructor(ctx: DurableObjectState, env: TurnEnv) {
    super(ctx, env);
    this.core = new ProfilesCore(kvStore(ctx));
  }
  create(name: string): Promise<{ id: string; secret: string }> {
    return this.core.create(name);
  }
  verify(id: string, secret: string): Promise<{ name: string } | null> {
    return this.core.verify(id, secret);
  }
  stats(id: string): Promise<Stats | null> {
    return this.core.stats(id);
  }
  remove(id: string, secret: string): Promise<boolean> {
    return this.core.remove(id, secret);
  }
  record(gameId: string, entries: { profileId: string; result: GameResult['seats'][string] }[]): Promise<void> {
    return this.core.record(gameId, entries);
  }
}
