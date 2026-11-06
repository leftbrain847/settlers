import { HOST_CONFIG } from './config.ts';
import type { Store, UsageService } from './services.ts';

/** Daily request meter. The free plan resets at 00:00 UTC. Rooms flush batched counts; nothing is billed per message here. */
export class UsageCore implements UsageService {
  private store: Store;
  private now: () => number;
  private budget: number;
  constructor(store: Store, now: () => number = Date.now, budget: number = HOST_CONFIG.quota.dailyRequestBudget) { this.store = store; this.now = now; this.budget = budget; }

  private day(): string { return new Date(this.now()).toISOString().slice(0, 10); }

  async add(requests: number): Promise<void> {
    const day = this.day();
    const cur = this.store.get<{ day: string; used: number }>('usage');
    const used = cur && cur.day === day ? cur.used : 0;
    this.store.put('usage', { day, used: used + Math.max(0, Math.floor(requests)) });
  }

  async fraction(): Promise<number> {
    const cur = this.store.get<{ day: string; used: number }>('usage');
    return cur && cur.day === this.day() ? Math.min(1, cur.used / this.budget) : 0;
  }
}
