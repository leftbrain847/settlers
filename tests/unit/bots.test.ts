import test from 'node:test';
import assert from 'node:assert/strict';
import { configFromSettings, createGame, addPlayer, startGame } from '../../games/settlers/engine/index.ts';
import { botPlan, createBots, runBotsSync } from '../../games/settlers/ai/driver.ts';
import type { StrategyName } from '../../games/settlers/ai/driver.ts';
import type { Settings, TradeOffer } from '../../games/settlers/engine/index.ts';
import { TradeClock } from '../../games/settlers/clock.ts';

function botGame(seed: number, spec: StrategyName[], settings: Settings = { vp_to_win: 10 }) {
  const cfg = configFromSettings(settings);
  let s = createGame(cfg, { game_id: `b${seed}`, seed });
  const ids: string[] = [];
  spec.forEach((_name, i) => { s = addPlayer(cfg, s, { name: `Bot${i + 1}`, is_ai: true }); ids.push(`p${i + 1}`); });
  s = startGame(cfg, s).state;
  const bots = createBots(Object.fromEntries(ids.map((id, i) => [id, spec[i]!])));
  return { cfg, s, bots, rng: { rng: (seed * 31 + 7) >>> 0 } };
}

test('bot-only games finish: smart vs smart vs random, no rejected moves, trades happen', () => {
  let finished = 0, rejected = 0, trades = 0, totalTurns = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const g = botGame(seed, ['smart', 'smart', seed % 2 ? 'random' : 'smart']);
    const end = runBotsSync(g.cfg, g.s, g.bots, g.rng, {
      maxActions: 6000,
      onAction: (a, r) => { if (!r.ok) rejected++; else if (r.events.some((e) => e.type === 'trade_completed')) trades++; },
    });
    if (end.phase === 'finished') finished++;
    totalTurns += end.turn_number;
  }
  assert.equal(rejected, 0, 'bots must never submit an illegal action');
  assert.ok(finished >= 8, `only ${finished}/12 finished`);
  assert.ok(trades > 0, 'bots never completed a trade');
  assert.ok(totalTurns > 100);
});

test('random-only bot games also run clean (with discards, robber, dev cards)', () => {
  let rejected = 0;
  for (let seed = 20; seed < 28; seed++) {
    const g = botGame(seed, ['random', 'random', 'random', 'random'], { vp_to_win: 6, discard_threshold: 5 });
    runBotsSync(g.cfg, g.s, g.bots, g.rng, { maxActions: 5000, onAction: (a, r) => { if (!r.ok) rejected++; } });
  }
  assert.equal(rejected, 0);
});

test('bot decisions are deterministic for a given seed', () => {
  const run = () => { const g = botGame(5, ['smart', 'smart']); return runBotsSync(g.cfg, g.s, g.bots, g.rng, { maxActions: 800 }); };
  assert.deepEqual(run(), run());
});

test('a human among bots: bots stop and wait on the human turn', () => {
  const cfg = configFromSettings({});
  let s = createGame(cfg, { game_id: 'h', seed: 9 });
  s = addPlayer(cfg, s, { name: 'Human' });
  s = addPlayer(cfg, s, { name: 'Bot', is_ai: true });
  s = startGame(cfg, s).state;
  const bots = createBots({ p2: 'smart' });
  const rng = { rng: 3 };
  assert.equal(runBotsSync(cfg, s, bots, rng).setup_player_idx, 0, 'waits for the human placing first');
});

test('a bot with an open offer waits for the human instead of acting (and does not throw)', () => {
  const cfg = configFromSettings({});
  let s = createGame(cfg, { game_id: 'w', seed: 11 });
  s = addPlayer(cfg, s, { name: 'Human' });
  s = addPlayer(cfg, s, { name: 'Bot', is_ai: true });
  s = startGame(cfg, s).state;
  s.phase = 'playing'; s.current_player_idx = 1; s.dice_rolled = true; s.turn_number = 3;
  s.players.p2.resources.wood = 2; s.players.p1.resources.clay = 0;
  s.trade_offers = { t1: { id: 't1', from_player: 'p2', offering: { wood: 1 }, requesting: { clay: 1 }, responses: {}, counter_ids: [] } };
  const bots = createBots({ p2: 'smart' });
  assert.deepEqual(botPlan(cfg, s, bots, { rng: 1 }), []);
  s.trade_offers.t1.responses.p1 = 'declined';
  const plan = botPlan(cfg, s, bots, { rng: 1 });
  assert.equal(plan[0].type, 'trade_expire');
});

test('TradeClock: 70s for human offers, 20s for bot offers, 15s for counters, early expiry when all decline', () => {
  const cfg = configFromSettings({});
  let s = createGame(cfg, { game_id: 'c', seed: 1 });
  s = addPlayer(cfg, s, { name: 'H1' }); s = addPlayer(cfg, s, { name: 'H2' }); s = addPlayer(cfg, s, { name: 'B', is_ai: true });
  const base = structuredClone(s);
  const offer = (id: string, from: string, extra: Partial<TradeOffer> = {}): TradeOffer => ({ id, from_player: from, offering: { wood: 1 }, requesting: { clay: 1 }, responses: {}, counter_ids: [], ...extra });

  base.trade_offers = { t1: offer('t1', 'p1'), t2: offer('t2', 'p3') };
  const clock = new TradeClock(cfg);
  clock.sync(base, 1000);
  assert.equal(clock.deadlines.get('t1'), 1000 + 70_000);
  assert.equal(clock.deadlines.get('t2'), 1000 + 20_000);

  base.trade_offers = { t1: offer('t1', 'p1', { counter_ids: ['t3'] }), t3: offer('t3', 'p3') };
  clock.sync(base, 2000);
  assert.equal(clock.deadlines.get('t3'), 2000 + 15_000);
  assert.ok(!clock.deadlines.has('t2'));

  base.trade_offers = { t4: offer('t4', 'p1', { responses: { p2: 'declined', p3: 'declined' } }) };
  clock.sync(base, 5000);
  assert.equal(clock.deadlines.get('t4'), 5000 + 1500);
  assert.deepEqual(clock.due(6500), ['t4']);

});

test('a bot keeps saving for settlements after upgrading to cities (a city returns its settlement)', async () => {
  const { goalsFor } = await import('../../games/settlers/ai/smart.ts');
  const cfg = configFromSettings({});
  const me = (settlement: number, city: number) => ({ buildings_placed: { settlement, city } }) as unknown as Parameters<typeof goalsFor>[1];
  const wantsSettlement = (s: number, c: number) => goalsFor(cfg, me(s, c)).some((g) => 'sheep' in g && 'clay' in g);
  const wantsCity = (s: number, c: number) => goalsFor(cfg, me(s, c)).some((g) => g.rock === 3);
  assert.equal(wantsSettlement(2, 3), true, '2 settlements + 3 cities: 3 settlements still in supply');
  assert.equal(wantsSettlement(5, 0), false, 'all 5 settlements on the board');
  assert.equal(wantsCity(1, 4), false, 'all 4 cities on the board');
  assert.equal(wantsCity(1, 3), true);
});

test('six-player bot games finish with no rejected moves; a seventh seat is refused', () => {
  let finished = 0, rejected = 0;
  for (let seed = 1; seed <= 4; seed++) {
    const g = botGame(seed, ['smart', 'smart', 'smart', 'smart', 'smart', 'random']);
    const end = runBotsSync(g.cfg, g.s, g.bots, g.rng, { maxActions: 12000, onAction: (_a, r) => { if (!r.ok) rejected++; } });
    if (end.phase === 'finished') finished++;
  }
  assert.equal(rejected, 0);
  assert.ok(finished >= 3, `only ${finished}/4 six-player games finished`);
  const cfg = configFromSettings({});
  let s = createGame(cfg, { game_id: 'seven', seed: 1 });
  for (let i = 0; i < 6; i++) s = addPlayer(cfg, s, { name: `P${i}`, is_ai: true });
  assert.throws(() => addPlayer(cfg, s, { name: 'P7', is_ai: true }), /Maximum players/);
});
