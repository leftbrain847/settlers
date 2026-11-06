import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalTransport, HUMAN } from '../../games/settlers/client/local.ts';
import type { Snapshot } from '../../games/settlers/client/transport.ts';

const idle = () => new Promise((r) => setTimeout(r, 0));
async function settle(t: { pumping: boolean }): Promise<void> { for (let i = 0; i < 2000; i++) { await idle(); if (!t.pumping) { await idle(); if (!t.pumping) return; } } throw new Error('never settled'); }

test('autopilot plays the human seat to the end with no input, using the smart bot', async () => {
  const t = new LocalTransport({ settings: { vp_to_win: 6 }, numBots: 2, seed: 7, sleep: () => Promise.resolve(), autopilot: true });
  let last: Snapshot | undefined;
  t.subscribe((s) => { last = s; });
  t.start();
  await settle(t);
  assert.equal(last!.view.phase, 'finished');
  assert.equal(last!.autopilot, true);
  assert.ok(t.actionLog.some((a) => a.player_id === HUMAN), 'the human seat acted via autopilot');
});

test('speed divides bot delays (0.5x slower, 4x faster, Max is zero)', async () => {
  const run = async (speed: number) => {
    const delays: number[] = [];
    const t = new LocalTransport({ settings: {}, numBots: 2, seed: 3, speed, autopilot: true, sleep: (ms) => { delays.push(ms); return Promise.resolve(); } });
    t.start();
    for (let i = 0; i < 40; i++) await idle();
    t.destroy();
    return delays.filter((d) => d > 0 || speed === Infinity);
  };
  const base = await run(1), slow = await run(0.5), fast = await run(4), max = await run(Infinity);
  assert.ok(base.length > 5);
  assert.equal(slow[0], base[0] * 2);
  assert.equal(fast[0], base[0] / 4);
  assert.ok(max.length > 5 && max.every((d) => d === 0));
});

test('taking the seat back stops autopilot and waits for the human', async () => {
  const t = new LocalTransport({ settings: {}, numBots: 2, seed: 5, sleep: () => Promise.resolve(), autopilot: true });
  t.start();
  for (let i = 0; i < 60; i++) await idle();
  t.setAutopilot(false);
  await settle(t);
  assert.equal(t.state.players[HUMAN].is_ai, false);
  const before = t.actionLog.length;
  await settle(t);
  assert.equal(t.actionLog.length, before, 'no moves are made for the human once they are back');
});
