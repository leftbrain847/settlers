// Optional player profiles. A profile is a random id plus a secret that lives on the player's device (or in a
// recovery code). Names are display-only and never grant access.
import { newToken, randomHex, safeEqual, sha256Hex } from './crypto.ts';
import type { Stats } from './protocol.ts';
import type { GameResult } from './game.ts';
import type { ProfileService, Store } from './services.ts';

interface Record_ { name: string; secretHash: string; stats: Stats; seen: string[]; createdAt: number }
const MAX_PROFILES = 10_000;
const MAX_SEEN = 200;

export class ProfilesCore implements ProfileService {
  private store: Store;
  private now: () => number;
  constructor(store: Store, now: () => number = Date.now) { this.store = store; this.now = now; }

  async create(name: string): Promise<{ id: string; secret: string }> {
    const count = this.store.get<number>('count') ?? 0;
    if (count >= MAX_PROFILES) throw new Error('profile limit reached');
    const id = randomHex(8);
    const secret = newToken();
    const rec: Record_ = { name, secretHash: await sha256Hex(secret), stats: { games: 0, wins: 0, totalScore: 0, extras: {} }, seen: [], createdAt: this.now() };
    this.store.put(`p:${id}`, rec);
    this.store.put('count', count + 1);
    return { id, secret };
  }

  async verify(id: string, secret: string): Promise<{ name: string } | null> {
    const rec = this.store.get<Record_>(`p:${id}`);
    if (!rec) { await safeEqual(secret, secret); return null; }
    return (await safeEqual(await sha256Hex(secret), rec.secretHash)) ? { name: rec.name } : null;
  }

  async stats(id: string): Promise<Stats | null> { return this.store.get<Record_>(`p:${id}`)?.stats ?? null; }

  async remove(id: string, secret: string): Promise<boolean> {
    if (!(await this.verify(id, secret))) return false;
    this.store.delete(`p:${id}`);
    this.store.put('count', Math.max(0, (this.store.get<number>('count') ?? 1) - 1));
    return true;
  }

  async record(gameId: string, entries: { profileId: string; result: GameResult['seats'][string] }[]): Promise<void> {
    for (const e of entries) {
      const rec = this.store.get<Record_>(`p:${e.profileId}`);
      if (!rec || rec.seen.includes(gameId)) continue;
      rec.stats.games += 1;
      if (e.result.won) rec.stats.wins += 1;
      rec.stats.totalScore += e.result.score;
      for (const [k, v] of Object.entries(e.result.extras)) rec.stats.extras[k] = (rec.stats.extras[k] ?? 0) + v;
      rec.seen = [...rec.seen, gameId].slice(-MAX_SEEN);
      this.store.put(`p:${e.profileId}`, rec);
    }
  }
}
