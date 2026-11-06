// npm run e2e: build, start the app Worker and the platform Worker together in real workerd (wrangler dev),
// run tests/e2e/e2e.ts against them, then stop. A throwaway HOST_KEY goes in .dev.vars (gitignored) if missing.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

if (!existsSync('.dev.vars')) writeFileSync('.dev.vars', `HOST_KEY=${randomBytes(24).toString('hex')}\n`);
if (spawnSync('npm', ['run', 'build'], { stdio: 'inherit' }).status !== 0) process.exit(1);

const port = process.env.PORT ?? '8787';
const dev = spawn('npx', ['wrangler', 'dev', '-c', 'wrangler.toml', '-c', 'tests/e2e/platform.wrangler.toml', '--port', port, '--ip', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let log = '';
dev.stdout.on('data', (d) => (log += d));
dev.stderr.on('data', (d) => (log += d));
const stop = () => { try { process.kill(-dev.pid, 'SIGTERM'); } catch { /* gone */ } };

const base = `http://127.0.0.1:${port}/settlers`;
let up = false;
for (let i = 0; i < 120 && !up; i++) {
  await new Promise((r) => setTimeout(r, 500));
  up = await fetch(`${base}/`).then((r) => r.status === 200, () => false);
}
if (!up) { console.error(`wrangler dev did not come up:\n${log}`); stop(); process.exit(1); }
const run = spawnSync('node', ['tests/e2e/e2e.ts'], { stdio: 'inherit', env: { ...process.env, BASE: base } });
stop();
if (run.status !== 0) console.error(`\n--- wrangler log ---\n${log.slice(-4000)}`);
process.exit(run.status ?? 1);
