#!/usr/bin/env node
// Post-deploy checks against the live friends URL, made WITHOUT logging in.
// Access apps: every one must show the login wall, never the app.
// Invite apps (no login): every one must be refused without the host key or a signed room link.
// Exit 1 on any failure.
import { readFileSync } from 'node:fs';
import { request } from 'node:https';

const app = JSON.parse(readFileSync('app.config.json', 'utf8'));
const platform = JSON.parse(readFileSync('platform/platform.config.json', 'utf8'));
const invite = app.mode === 'invite';
const host = invite ? platform.friendsHost : platform.appsHost;
const base = `/${app.id}`;
const fails = [];

const toLogin = (status, location) => (status === 301 || status === 302 || status === 303 || status === 307) && /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com\//.test(location ?? '');

/** One raw HTTPS request (no redirects followed), so WebSocket upgrade headers can be sent too. */
function probe(path, headers = {}, method = 'GET') {
  return new Promise((resolve) => {
    const req = request({ host, port: process.env.SMOKE_PORT ?? 443, path, method, headers: { 'User-Agent': 'app-smoke-test', ...headers }, timeout: 15_000 });
    req.on('response', (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, location: res.headers.location ?? '' });
    });
    // A 101 here would mean the socket opened without a login: the worst outcome.
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode ?? 101, location: '' });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (e) => resolve({ status: 0, location: '', error: e.message }));
    req.end();
  });
}

async function check(name, path, { headers = {}, strict = false } = {}) {
  const r = await probe(path, headers);
  // Strict: must be Access's redirect to the team login. That proves Access (not just our Worker) covers the path.
  // Otherwise a 403 also passes: our Worker refusing a request that carries no token.
  const ok = toLogin(r.status, r.location) || (!strict && r.status === 403);
  if (ok) console.log(`ok   ${name} (${r.status})`);
  else fails.push(`${name}: got ${r.status}${r.location ? ` → ${r.location}` : ''}${r.error ? ` (${r.error})` : ''}; expected the login wall`);
}

const WS = { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': 'c21va2UtdGVzdC1ub25jZQ==', 'Sec-WebSocket-Version': '13' };

async function refused(name, path, want, headers = {}, method = 'GET') {
  const r = await probe(path, headers, method);
  if (r.status === want) console.log(`ok   ${name} (${r.status})`);
  else fails.push(`${name}: got ${r.status}${r.error ? ` (${r.error})` : ''}; expected ${want}`);
}

if (invite) {
  // The page itself is public (it holds no secrets); everything that does anything is refused.
  await refused('usage needs the host key', `${base}/api/usage`, 403);
  await refused('only the host key creates rooms', `${base}/api/rooms`, 403, { 'Content-Length': '0' }, 'POST');
  await refused('a forged room link opens no socket', `${base}/ws/${'0'.repeat(32)}.${'A'.repeat(22)}`, 403, WS);
  await refused('nothing else is routed', `${base}/api/rooms/list`, 404);
  await refused('a socket from another site is refused', `${base}/ws/${'0'.repeat(32)}.${'A'.repeat(22)}`, 403, { ...WS, Origin: 'https://evil.example' });
} else {
  await check('app page redirects to the Access login', `${base}/`, { strict: true });
  await check('assets need login', `${base}/index.html`);
  await check('api needs login', `${base}/api/usage`);
  await check('room socket needs login', `${base}/api/rooms/00000000-0000-4000-8000-000000000000/ws`, { headers: WS });
}

// The Worker must have no other way in.
const wrangler = readFileSync('wrangler.toml', 'utf8');
const before = fails.length;
if (!/^workers_dev\s*=\s*false/m.test(wrangler)) fails.push('wrangler.toml: workers_dev must be false');
if (!/^preview_urls\s*=\s*false/m.test(wrangler)) fails.push('wrangler.toml: preview_urls must be false');
if (fails.length === before) console.log('ok   no workers.dev or preview URLs');

if (fails.length) {
  console.error('\nSMOKE FAILED:\n' + fails.join('\n'));
  process.exit(1);
}
console.log(invite ? '\nSmoke passed: nothing works without the host key or a signed room link.' : '\nSmoke passed: the app is behind the login wall.');
