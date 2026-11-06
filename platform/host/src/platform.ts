/**
 * The one shared Worker (`app-platform`). It owns the account-wide
 * `UsageMeter` (Cloudflare's free limits are per account, so every app counts
 * into the same meter) and every app's `Scores` board. Apps bind to both by
 * `script_name = "app-platform"`. On the hostname root it serves a small,
 * Access-protected index of the live apps, listed in the `APPS` variable.
 */
import { verifyAccess } from './auth';
import { hostConfig } from './config';
import { meter, OBJECT_URL, type Env } from './env';
import { deny, json, secured } from './headers';

export { UsageMeter } from './usage';
export { Scores } from './solo';

export interface PlatformEnv extends Pick<Env, 'TEAM' | 'ACCESS_AUD' | 'ALLOWED_EMAILS' | 'USAGE' | 'SCORES'> {
  /** JSON list of `{ "id": "settlers", "title": "Settlers" }`, kept in `wrangler.toml` `[vars]`. */
  APPS?: string;
}

interface AppEntry {
  id: string;
  title: string;
}

export function parseApps(raw: string | undefined): AppEntry[] {
  try {
    const v: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(v)) return [];
    return v.filter((a): a is AppEntry => typeof a === 'object' && a !== null && typeof a.id === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(a.id) && typeof a.title === 'string' && a.title.length <= 80);
  } catch {
    return [];
  }
}

const escape = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** No inline styles or scripts: the CSP is `'self'` only, so the page is plain markup. */
export function indexPage(apps: AppEntry[]): string {
  const items = apps.length ? apps.map((a) => `<li><a href="/${a.id}/">${escape(a.title)}</a></li>`).join('') : '<li>No apps yet.</li>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Apps</title></head><body><h1>Apps</h1><ul>${items}</ul></body></html>`;
}

export default {
  async fetch(request: Request, env: PlatformEnv): Promise<Response> {
    try {
      const cfg = hostConfig();
      const who = await verifyAccess(request, env, {
        fetch: (input, init) => fetch(input, init),
        nowS: () => Math.floor(Date.now() / 1000),
        keysTtlMs: cfg.accessKeysTtlMs,
        keysMinRefreshMs: cfg.accessKeysMinRefreshMs,
        clockSkewS: cfg.clockSkewS,
      });
      if (!who) return deny(403);
      const path = new URL(request.url).pathname;
      if (request.method !== 'GET') return deny(405);
      if (path === '/' || path === '/index.html') {
        return secured(new Response(indexPage(parseApps(env.APPS)), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }));
      }
      if (path === '/api/platform/usage') {
        const res = await meter(env as unknown as Env).fetch(`${OBJECT_URL}/report`);
        return json(await res.json());
      }
      return deny(404);
    } catch {
      return deny(500);
    }
  },
} satisfies ExportedHandler<PlatformEnv>;
