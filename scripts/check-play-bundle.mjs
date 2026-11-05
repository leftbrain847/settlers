#!/usr/bin/env node
// The Play build must make no network calls: it's an offline, login-free app.
// Fails if the built bundle contains any network code path.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'dist/play';
// A tripwire, not a proof: plain substrings, so keep the client free of these words even in comments.
const FORBIDDEN = ['/api/', 'WebSocket', 'fetch(', 'XMLHttpRequest', 'sendBeacon', 'EventSource', 'import("http', 'http://', 'https://'];

const files = [];
const walk = (d) => {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|mjs|html|css|json|webmanifest)$/.test(name)) files.push(p);
  }
};
walk(DIR);

const hits = [];
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  for (const needle of FORBIDDEN) if (text.includes(needle)) hits.push(`${f}: contains "${needle}"`);
}
if (hits.length) {
  console.error('Play bundle has network code (it must work offline with no server):\n' + hits.join('\n'));
  process.exit(1);
}
console.log(`Play bundle clean: ${files.length} files, no network code.`);
