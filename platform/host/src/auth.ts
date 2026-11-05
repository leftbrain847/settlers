/**
 * Cloudflare Access, re-checked inside the Worker on every request (fail
 * closed): the `Cf-Access-Jwt-Assertion` token must be RS256-signed by one of
 * the team's current keys, carry our application's AUD tag, come from our
 * team's issuer, be within its time window, and name an email (optionally on
 * an allowlist). Anything else is `null`, and the caller answers 403.
 * Hand-rolled on WebCrypto: no JWT library.
 */

export interface AccessEnv {
  /** Cloudflare One team name: `<team>.cloudflareaccess.com`. */
  TEAM?: string;
  /** The Access application's AUD tag. */
  ACCESS_AUD?: string;
  /** Optional second gate: comma-separated emails. */
  ALLOWED_EMAILS?: string;
}

export interface AuthDeps {
  fetch: typeof fetch;
  /** Seconds since the epoch. */
  nowS: () => number;
  keysTtlMs: number;
  /** An unknown key id refetches the keys at most this often, in ms (so forged tokens can't make us hammer Access). */
  keysMinRefreshMs: number;
  clockSkewS: number;
}

export interface Identity {
  email: string;
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

type KeyCache = { team: string; fetchedAtMs: number; keys: Map<string, CryptoKey> };
let cache: KeyCache | null = null;

/** Forget cached keys (tests). */
export function resetKeyCache(): void {
  cache = null;
}

const TEAM_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

function b64urlBytes(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function b64urlJson(s: string): Record<string, unknown> | null {
  const bytes = b64urlBytes(s);
  if (!bytes) return null;
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function teamKeys(team: string, deps: AuthDeps, forceRefresh: boolean): Promise<Map<string, CryptoKey>> {
  const nowMs = deps.nowS() * 1000;
  if (cache && cache.team === team) {
    const age = nowMs - cache.fetchedAtMs;
    if (age < (forceRefresh ? deps.keysMinRefreshMs : deps.keysTtlMs)) return cache.keys;
  }
  const res = await deps.fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error('certs unavailable');
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (!jwk.kid || jwk.kty !== 'RSA') continue;
    const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    keys.set(jwk.kid, key);
  }
  cache = { team, fetchedAtMs: nowMs, keys };
  return keys;
}

/** The verified identity on this request, or `null` (→ 403). Never throws. */
export async function verifyAccess(request: Request, env: AccessEnv, deps: AuthDeps): Promise<Identity | null> {
  try {
    const team = env.TEAM ?? '';
    const aud = env.ACCESS_AUD ?? '';
    if (!TEAM_NAME.test(team) || aud.length === 0) return null;
    const token = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!token || token.length > 8192) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [h, p, sig] = parts as [string, string, string];
    const header = b64urlJson(h);
    const payload = b64urlJson(p);
    const signature = b64urlBytes(sig);
    if (!header || !payload || !signature) return null;
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;

    let keys = await teamKeys(team, deps, false);
    // An unknown kid may be a fresh rotation: refetch once.
    if (!keys.has(header.kid)) keys = await teamKeys(team, deps, true);
    const key = keys.get(header.kid);
    if (!key) return null;
    const signed = new TextEncoder().encode(`${h}.${p}`);
    if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed))) return null;

    if (payload.iss !== `https://${team}.cloudflareaccess.com`) return null;
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(aud)) return null;
    const now = deps.nowS();
    if (typeof payload.exp !== 'number' || payload.exp + deps.clockSkewS < now) return null;
    if (typeof payload.iat !== 'number' || payload.iat - deps.clockSkewS > now) return null;
    if (typeof payload.nbf === 'number' && payload.nbf - deps.clockSkewS > now) return null;
    if (typeof payload.email !== 'string' || payload.email.length === 0 || payload.email.length > 254) return null;
    const email = payload.email.toLowerCase();

    const allowed = (env.ALLOWED_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (allowed.length > 0 && !allowed.includes(email)) return null;
    return { email };
  } catch {
    return null;
  }
}
