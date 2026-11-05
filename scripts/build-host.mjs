// Builds the hosted client (dist/friends, served by the Worker at /settlers/) as separate files: the content policy
// allows only same-origin scripts and styles. Paths are absolute so invite links (/settlers/r/<room>) load it too.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const app = JSON.parse(readFileSync('app.config.json', 'utf8'));
const base = `/${app.id}`;
const out = 'dist/friends';

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: ['games/settlers/client/main.ts'], bundle: true, minify: true, format: 'iife', target: 'es2020',
  outfile: `${out}/app.js`, define: { __ONLINE__: 'true', __BASE__: JSON.stringify(base) }, legalComments: 'none',
});
copyFileSync('games/settlers/client/style.css', `${out}/style.css`);
const html = readFileSync('games/settlers/client/index.html', 'utf8')
  .replace('<!--STYLE-->', `<link rel="stylesheet" href="${base}/style.css">`)
  .replace('<!--SCRIPT-->', `<script src="${base}/app.js" defer></script>`);
writeFileSync(`${out}/index.html`, html);
console.log(`${out} built (served at ${base}/)`);
