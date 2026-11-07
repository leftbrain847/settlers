// web/settlers.html is the committed, single-device build (bots only, no host) that J's public homepage copies.
// It must always match a fresh build, so it can never drift from the game. Fix: npm run build:web
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

test('web/settlers.html matches a fresh build (run npm run build:web)', () => {
  execFileSync(process.execPath, ['scripts/build.mjs'], { stdio: 'ignore' });
  const fresh = readFileSync('dist/settlers.html', 'utf8');
  const committed = readFileSync('web/settlers.html', 'utf8');
  assert.ok(committed === fresh, 'web/settlers.html is stale: run npm run build:web and commit it');
});

test('the public build loads nothing from other sites', () => {
  const page = readFileSync('web/settlers.html', 'utf8');
  assert.doesNotMatch(page, /<(script|link|img|iframe)[^>]+(src|href)\s*=\s*["']?(https?:)?\/\//i);   // tags, any quoting
  assert.doesNotMatch(page, /url\(\s*["']?(https?:)?\/\//i);                                          // CSS
  assert.doesNotMatch(page, /@import\s+["']?(url\()?\s*["']?https?:/i);
});
