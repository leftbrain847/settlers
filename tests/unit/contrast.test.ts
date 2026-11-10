import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { THEMES } from '../../games/settlers/client/theme.ts';
import { PALETTE_IDS, paletteOf } from '../../games/settlers/client/board3d/style.ts';
import { FLAT_TERRAIN_FILTER, check, distance, flatBackdrop, litBackdrop } from '../../games/settlers/client/contrast.ts';
import type { Violation } from '../../games/settlers/client/contrast.ts';
import { PLAYER_COLORS } from '../../games/settlers/engine/state.ts';

const report = (vs: Violation[]): string => vs.map((v) => `${v.palette}: ${v.piece} vs ${v.against} (${v.what}) ${v.distance.toFixed(3)} < ${v.min}`).join('\n');

test('piece rules, flat board: every theme\'s players stand out from its muted terrain and from each other', () => {
  const vs = Object.entries(THEMES).flatMap(([id, t]) =>
    check(`flat:${id}`, t.players, Object.fromEntries(Object.entries(t.terrain).map(([k, v]) => [k, flatBackdrop(v)]))));
  assert.deepEqual(vs, [], report(vs));
});

test('piece rules, 3D boards: every palette\'s players stand out from dimmed terrain, props and sea', () => {
  const vs = PALETTE_IDS.flatMap((id) => {
    const p = paletteOf(id);
    const backdrop = { ...p.terrain, foliage: p.foliage, grass: p.grass, wheat: p.wheat, sea: p.sea, shore: p.shore };
    return check(`3d:${id}`, p.players, Object.fromEntries(Object.entries(backdrop).map(([k, v]) => [k, litBackdrop(v)])));
  });
  assert.deepEqual(vs, [], report(vs));
});

test('piece rules: every view uses the shared seat colours, and the rule models the CSS that ships', () => {
  for (const t of Object.values(THEMES)) assert.deepEqual(t.players, PLAYER_COLORS);
  for (const id of PALETTE_IDS) assert.deepEqual(paletteOf(id).players, PLAYER_COLORS);
  const css = readFileSync('games/settlers/client/style.css', 'utf8');
  assert.ok(css.includes(`filter: saturate(${String(FLAT_TERRAIN_FILTER.saturate).replace(/^0/, '')}) brightness(${String(FLAT_TERRAIN_FILTER.brightness).replace(/^0/, '')})`), 'style.css terrain filter differs from FLAT_TERRAIN_FILTER');
  // the checker itself: identical colours fail, black and white are as far apart as OKLab goes
  assert.equal(check('x', ['#808080'], { same: flatBackdrop('#808080') }).length > 0, true);
  assert.ok(distance('#000000', '#ffffff') > 0.99);
});
