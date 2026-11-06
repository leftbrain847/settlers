import type { Stats } from './protocol.ts';
import type { GameResult } from './game.ts';

export interface ProfileService {
  create(name: string): Promise<{ id: string; secret: string }>;
  verify(id: string, secret: string): Promise<{ name: string } | null>;
  stats(id: string): Promise<Stats | null>;
  remove(id: string, secret: string): Promise<boolean>;
  /** Idempotent per (gameId, profile). */
  record(gameId: string, entries: { profileId: string; result: GameResult['seats'][string] }[]): Promise<void>;
}

export interface UsageService {
  add(requests: number): Promise<void>;
  /** fraction of the daily budget used so far */
  fraction(): Promise<number>;
}

export interface Store {
  get<T>(key: string): T | undefined;
  put(key: string, value: unknown): void;
  delete(key: string): void;
  deleteAll(): void;
}

export class MemoryStore implements Store {
  private m = new Map<string, string>();
  get<T>(key: string): T | undefined { const v = this.m.get(key); return v === undefined ? undefined : (JSON.parse(v) as T); }
  put(key: string, value: unknown): void { this.m.set(key, JSON.stringify(value)); }
  delete(key: string): void { this.m.delete(key); }
  deleteAll(): void { this.m.clear(); }
}
