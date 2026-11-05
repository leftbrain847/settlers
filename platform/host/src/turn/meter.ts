import { OBJECT_URL } from '../env.ts';
import type { UsageService } from './services.ts';

interface Report { fraction: number }

/**
 * Turn rooms count into the same account-wide meter as every other app (the
 * free allowances are per account). `add` reports billed object requests.
 */
export function sharedMeter(usage: DurableObjectNamespace): UsageService {
  const stub = (): DurableObjectStub => usage.get(usage.idFromName('global'));
  let last = 0;
  const read = async (res: Response): Promise<number> => {
    const r = (await res.json()) as Report;
    last = typeof r.fraction === 'number' && Number.isFinite(r.fraction) ? Math.min(1, Math.max(0, r.fraction)) : last;
    return last;
  };
  return {
    async add(requests: number): Promise<void> {
      const n = Math.max(0, Math.floor(requests));
      await read(await stub().fetch(`${OBJECT_URL}/add`, { method: 'POST', body: JSON.stringify({ workerRequests: 0, objectRequests: n, inboundWs: 0, rowsWritten: 0 }) }));
    },
    async fraction(): Promise<number> {
      return read(await stub().fetch(`${OBJECT_URL}/report`));
    },
  };
}
