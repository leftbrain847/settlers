import { hostConfig } from './config';
import { addUsage, usageReport, utcDay, type UsageDay, type UsageDelta } from './usageCore';

const isDelta = (v: unknown): v is UsageDelta => {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Record<string, unknown>;
  return ['workerRequests', 'objectRequests', 'inboundWs', 'rowsWritten'].every((k) => typeof d[k] === 'number' && Number.isFinite(d[k]) && (d[k] as number) >= 0);
};

/**
 * Daily usage against the free allowances. Everything else sends it batched
 * tallies (`POST /add`); `GET /report` answers `/api/usage` and the
 * hard-stop check. One row per UTC day.
 */
export class UsageMeter implements DurableObject {
  constructor(private readonly ctx: DurableObjectState) {}

  private async today(): Promise<UsageDay> {
    const day = utcDay(Date.now());
    return (await this.ctx.storage.get<UsageDay>(`day:${day}`)) ?? { day, workerRequests: 0, objectRequests: 0, inboundWs: 0, rowsWritten: 0 };
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    let day = await this.today();
    if (request.method === 'POST' && path === '/add') {
      const body: unknown = await request.json().catch(() => null);
      if (!isDelta(body)) return new Response(null, { status: 400 });
      // This flush is itself an object request and a row written.
      day = addUsage(day, { ...body, objectRequests: body.objectRequests + 1, rowsWritten: body.rowsWritten + 1 });
      await this.ctx.storage.put(`day:${day.day}`, day);
    } else if (!(request.method === 'GET' && path === '/report')) {
      return new Response(null, { status: 404 });
    }
    return Response.json(usageReport(day, hostConfig()));
  }
}
