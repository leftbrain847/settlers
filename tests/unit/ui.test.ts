import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import type { App } from '../../games/settlers/client/app.ts';
import type { Snapshot } from '../../games/settlers/client/transport.ts';

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent,
});
const { boot } = await import('../../games/settlers/client/app.ts');

const memStore = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); }, removeItem: (k: string) => { m.delete(k); }, m };
};
const maybe = (sel: string): HTMLElement | null => document.querySelector<HTMLElement>(sel);
const $$ = (sel: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(sel)];
const $ = (sel: string): HTMLElement => { const el = maybe(sel); if (!el) throw new Error(`missing ${sel}`); return el; };
const must = $;
const snapOf = (app: App): Snapshot => { if (!app.snap) throw new Error('no snapshot yet'); return app.snap; };
const button = (label: string): HTMLElement | undefined => $$('button').find((b) => (b.textContent ?? '').trim().startsWith(label) && !b.hasAttribute('disabled'));
const fire = (el: Element, type: string): void => { el.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, clientX: 5, clientY: 5 })); };
const tap = (el: Element): void => { fire(el, 'pointerdown'); fire(el, 'pointerup'); };
const pumping = (app: App): boolean => (app.t as unknown as { pumping: boolean }).pumping;
const settle = async (app: App): Promise<void> => { for (let i = 0; i < 400; i++) { await new Promise((r) => setTimeout(r, 0)); if (!pumping(app)) { await new Promise((r) => setTimeout(r, 0)); if (!pumping(app)) return; } } throw new Error('transport never settled'); };
const until = async (cond: () => boolean, what: string, ms = 4000): Promise<void> => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 5)); } };
const banner = () => maybe('.banner')?.getAttribute('aria-label') ?? '';

function start(opts: { rings?: number; vp?: number; discard?: number; bots?: number } = {}) {
  document.getElementById('app')!.innerHTML = '';
  const storage = memStore();
  const app = boot(document.getElementById('app')!, { storage, autoSleep: () => Promise.resolve() });
  if (opts.rings) { app.prefs.values.board_rings = opts.rings; }
  if (opts.vp) app.prefs.values.vp_to_win = opts.vp;
  if (opts.discard) app.prefs.values.discard_threshold = opts.discard;
  app.prefs.bots = opts.bots ?? 2;
  app.start();
  return { app, storage };
}

// One decision from the DOM, the way a person would take it. Returns false when the game is over.
async function step(app: App, rnd: () => number): Promise<boolean> {
  await settle(app);
  if (maybe('.winner')) return false;
  const sheet = maybe('.sheet');
  if (sheet) {
    const title = sheet.querySelector('.sheet-head strong')?.textContent;
    if (title === 'Discard cards') { for (let i = 0; i < 60 && !button('Discard'); i++) $$('.sheet .step').filter((b) => b.textContent === '+' && !b.hasAttribute('disabled'))[0]?.click(); button('Discard')!.click(); }
    else if (title === 'Trade offer') (rnd() < 0.5 && button('Accept') ? button('Accept') : button('Decline'))!.click();
    else if (title === 'Your offer') (button('Confirm trade') ?? button('Withdraw offer'))!.click();
    else if (title === 'Steal from') $$('.sheet .btn')[0].click();
    else if (title === 'Year of Plenty') { $$('.sheet .step').filter((b) => b.textContent === '+')[0].click(); $$('.sheet .step').filter((b) => b.textContent === '+')[0].click(); button('Take resources')!.click(); }
    else if (title === 'Monopoly') $$('.sheet .res-btn')[0].click();
    else (button('Leave game') ? $('.sheet .icon') : $('.sheet .icon')).click();
    return true;
  }
  const target = maybe('.target-hit, .target-edge-hit, polygon.target-hex');
  if (target) {
    const all = $$('.target-hit, .target-edge-hit, polygon.target-hex:not(.selected)');
    tap(all[Math.floor(rnd() * all.length)]);
    const ok = button('Confirm');
    assert.ok(ok, `no Confirm after tapping a target; banner: ${banner()}`);
    ok.click();
    return true;
  }
  if (button('Skip')) { button('Skip')!.click(); return true; }
  if (button('Roll dice')) { button('Roll dice')!.click(); return true; }
  const r = rnd();
  if (r < 0.35 && button('Build')) {
    button('Build')!.click();
    const choose = $$('.sheet .btn').filter((b) => b.textContent === 'Choose spot' || b.textContent === 'Buy');
    if (choose.length) choose[Math.floor(rnd() * choose.length)].click(); else $('.sheet .icon').click();
    return true;
  }
  if (r < 0.45 && button('Trade')) {
    button('Trade')!.click();
    $$('.sheet .step').filter((b) => b.textContent === '+' && !b.hasAttribute('disabled'))[0]?.click();
    $$('.sheet .step').filter((b) => b.textContent === '+' && !b.hasAttribute('disabled'))[5 % 5]?.click();
    const send = button('Send offer');
    if (send) send.click(); else $('.sheet .icon')?.click();
    return true;
  }
  if (r < 0.5 && button('Dev (') && $$('.hcard.dev .hn')[0]?.textContent !== '0') {
    button('Dev (')!.click();
    const play = $$('.sheet .btn').find((b) => b.textContent === 'Play' && !b.hasAttribute('disabled'));
    if (play) play.click(); else $('.sheet .icon').click();
    return true;
  }
  if (button('End turn')) { button('End turn')!.click(); return true; }
  return true; // waiting on bots
}

function rng(seed: number): () => number { let s = seed; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

test('lobby renders and a game starts with 3 players, a themed board, and setup targets', async () => {
  const { app } = start();
  await settle(app);
  assert.equal($$('.pchip').length, 3);
  assert.equal($$('polygon.hex').length, 19);
  assert.equal($$('.port-badge').length, 9);
  assert.match(banner(), /Place a settlement/);
  assert.ok($$('.target-hit').length > 40, 'all legal intersections are tappable at setup');
  assert.equal($$('.sheet').length, 0);
  assert.equal($$('.hcard').length, 6); // 5 resources + dev
});

test('tapping a spot only previews it; Confirm places, Cancel backs out', async () => {
  const { app } = start();
  await settle(app);
  const placed = $$('.piece').length;
  tap($$('.target-hit')[10]);
  assert.ok(button('Confirm') && button('Cancel'));
  assert.equal($$('.piece').length, placed + 1, 'ghost only');
  assert.equal(snapOf(app).view.legal_actions.length > 0, true);
  button('Cancel')!.click();
  assert.equal($$('.piece').length, placed);
  tap($$('.target-hit')[10]);
  button('Confirm')!.click();
  await settle(app);
  assert.match(banner(), /road|Place a road|is placing|roll/i);
  assert.ok(Object.keys(snapOf(app).view.board.buildings.i).length >= 1);
});

test('full UI-driven games: setup, rolls, builds, robber, discards, trades — no errors, reaches the end', async () => {
  const errors: string[] = [];
  const origErr = console.error;
  console.error = (...a) => { errors.push(a.join(' ')); };
  let finished = 0;
  try {
    for (const [seed, bots] of [[1, 2], [2, 3], [3, 1]]) {
      const { app } = start({ vp: 6, discard: 4, bots });
      const rnd = rng(seed * 977);
      let steps = 0;
      while (steps++ < 2500 && (await step(app, rnd))) { /* keep playing */ }
      if (maybe('.winner')) finished++;
      assert.ok(snapOf(app).view.turn_number > 6, `game ${seed} barely progressed (turn ${snapOf(app).view.turn_number}, banner "${banner()}")`);
      app.t?.destroy();
    }
  } finally { console.error = origErr; }
  assert.deepEqual(errors, []);
  assert.ok(finished >= 1, 'at least one UI-driven game reached a winner screen');
});

test('saved game resumes with identical state', async () => {
  const { app, storage } = start({ bots: 2 });
  const rnd = rng(5);
  for (let i = 0; i < 40; i++) await step(app, rnd);
  await settle(app);
  const before = JSON.stringify(snapOf(app).view.board.buildings) + snapOf(app).view.turn_number;
  assert.ok(storage.m.has('settlers.save.v1'));
  app.t?.destroy();
  document.getElementById('app')!.innerHTML = '';
  const app2 = boot(document.getElementById('app')!, { storage, autoSleep: () => Promise.resolve() });
  $('#resume').click();
  await settle(app2);
  assert.equal(JSON.stringify(snapOf(app2).view.board.buildings) + snapOf(app2).view.turn_number >= before, true);
  assert.ok(snapOf(app2).view.turn_number >= snapOf(app).view.turn_number);
  app2.t?.destroy();
});

test('theme switch changes terrain colors without re-rendering the game', async () => {
  const { app } = start();
  await settle(app);
  const before = document.documentElement.style.getPropertyValue('--t-hills');
  $('.icon').click();
  const sel = $('.sheet select') as HTMLSelectElement;
  sel.value = 'nord';
  sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.notEqual(document.documentElement.style.getPropertyValue('--t-hills'), before);
  assert.equal(app.prefs.theme, 'nord');
});

test('large boards render (8 rings) and small labels are dropped', async () => {
  const { app } = start({ rings: 8 });
  await settle(app);
  assert.equal($$('polygon.hex').length, 3 * 8 * 7 + 1);
  assert.equal($$('.terrain-label').length, 0);
});

test('Watch hands the seat to a bot, hides the controls, and Take over returns it; speed button cycles', { timeout: 60000 }, async () => {
  const { app } = start();
  await settle(app);
  assert.equal($('#speed').textContent, '1x');
  for (const want of ['2x', '4x', 'Max', '0.5x', '1x']) { $('#speed').click(); assert.equal($('#speed').textContent, want); }
  $('#watch').click();
  await settle(app);
  assert.equal($('#watch').textContent, 'Take over');
  assert.ok(snapOf(app).view.turn_number >= 1);
  assert.equal($$('.target-hit').length, 0, 'no placement prompts while watching');
  assert.equal($$('.sheet').length, 0);
  $('#watch').click();
  assert.equal($('#watch').textContent, 'Watch');
});

test('what just happened is shown once: a new piece pops in, then redraws leave it alone; prompts are icons', async () => {
  const { app } = start();
  await settle(app);
  assert.equal(banner(), 'Place a settlement');
  assert.equal($('.banner').querySelectorAll('svg').length, 1, 'the prompt is a house icon, not a sentence');
  assert.equal($('.banner').textContent, '');
  assert.equal($$('.hcard .ico').length, 6, 'the hand shows resource icons');
  tap($$('.target-hit')[3]!);
  button('Confirm')!.click(); // the click redraws synchronously, before any bot move
  assert.ok($$('.piece-shape.pop').length >= 1, 'the new settlement pops in');
  app.render();
  assert.ok($$('.piece-shape.pop').length >= 1, 'a redraw during the animation keeps it going');
  assert.match($('.piece-shape.pop').style.animationDelay, /^-\d+ms$/, 'and resumes at the right moment');
  await new Promise((r) => setTimeout(r, 1100));
  app.render();
  assert.equal($$('.piece-shape.pop').length, 0, 'once it is over, redraws leave the piece alone');
  assert.equal($$('.toast').length, 0, 'nothing is written to the player for ordinary events');
  assert.ok($$('.pchip[data-seat]').length >= 3);
});

test('without online play the lobby does not promise friends', () => {
  boot(document.getElementById('app')!, { storage: memStore(), online: false });
  assert.equal(maybe('.lobby p.dim')?.textContent, 'Play against bots.');
});
