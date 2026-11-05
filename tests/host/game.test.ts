import test from 'node:test';
import assert from 'node:assert/strict';
import { Net } from './net.ts';
import type { Client } from './net.ts';
import type { GameView } from '../../games/settlers/engine/index.ts';
import { newToken } from '@app-builder/host/turn/crypto';

const view = (c: Client): GameView => c.last('state')!.view as GameView;

async function runToEnd(net: Net, maxSteps = 6000): Promise<number> {
  let n = 0;
  while (net.core.phase === 'playing' && n < maxSteps && (await net.alarm())) n++;
  return n;
}

async function startedGame(settings: object = { vp_to_win: 5 }, bots = 1) {
  const net = await Net.make();
  const host = await net.host();
  const sam = await net.friend(host, 'Sam');
  await host.send({ t: 'host', cmd: { c: 'settings', settings, bots } });
  await host.send({ t: 'host', cmd: { c: 'start' } });
  return { net, host, sam };
}

test('game runs to a finish on alarms alone while humans use autopilot', async () => {
  const { net, host, sam } = await startedGame();
  assert.equal(net.core.phase, 'playing');
  assert.equal(view(host).player_order.length, 3, 'two humans plus one bot');
  await host.send({ t: 'autopilot', on: true });
  await sam.send({ t: 'autopilot', on: true });
  const steps = await runToEnd(net);
  assert.equal(net.core.phase, 'finished', `still ${net.core.phase} after ${steps} alarms`);
  assert.ok(view(host).winner);
  assert.ok(steps > 30);
});

test('hidden information on the wire: nobody receives another seat\'s hand, the deck, or the rng', async () => {
  const { net, host, sam } = await startedGame({ vp_to_win: 5, starting_resources: 'plenty' });
  await host.send({ t: 'autopilot', on: true });
  await sam.send({ t: 'autopilot', on: true });
  for (let i = 0; i < 200; i++) await net.alarm();
  for (const c of [host, sam]) {
    for (const m of c.all('state')) {
      if ((m.view as GameView).phase === 'finished') continue; // a finished game is revealed on purpose
      const json = JSON.stringify(m);
      assert.ok(!json.includes('dev_card_deck') && !json.includes('"rng"'), 'secret field in a state message');
      const v = m.view as GameView;
      for (const [id, p] of Object.entries(v.players)) {
        if (id !== c.seat) for (const k of ['resources', 'dev_cards', 'hidden_vp']) assert.ok(!(k in p), `${k} of ${id} sent to ${c.seat}`);
      }
    }
  }
});

test('clients cannot author system actions or act for another seat', async () => {
  const { net, host, sam } = await startedGame();
  const v = view(host);
  const cur = v.current_player!;
  const mover = cur === host.seat ? host : sam;
  const other = mover === host ? sam : host;
  await other.send({ t: 'action', type: 'roll_dice', params: {} });
  assert.ok(other.errors().includes('illegal') || other.errors().includes('bad_action'), 'wrong seat cannot act');
  await mover.send({ t: 'action', type: 'trade_expire', params: { trade_id: 't1' } });
  assert.ok(mover.errors().includes('bad_action'), 'system actions are unparseable from a client');
  await mover.send({ t: 'action', type: 'build', params: { building_type: 'settlement', location: -3, player_id: other.seat } });
  assert.ok(mover.errors().filter((e) => e === 'bad_action').length >= 2);
  void net;
});

test('turn timer: adjustable mid-game; expiry hands that decision to a bot; acting takes the seat back', async () => {
  const { net, host, sam } = await startedGame({ vp_to_win: 8 });
  await host.send({ t: 'host', cmd: { c: 'turn_timer', seconds: 20 } });
  assert.equal(host.last('lobby')!.turnTimerS, 20);
  // seats are shuffled, so let bots play until a human is the one being waited on
  const isHuman = (id: string | null): boolean => id === host.seat || id === sam.seat;
  for (let i = 0; i < 60 && !isHuman(view(host).current_player); i++) await net.alarm();
  assert.ok(isHuman(view(host).current_player), 'a human decision was reached');
  const who = view(host).current_player === host.seat ? host : sam;
  net.now += 21_000;
  const { out } = await net.core.alarm(net.now);
  net.flush(out);
  assert.equal(host.last('lobby')!.seats.find((s) => s.id === who.seat)!.bot, 'afk');
  for (let i = 0; i < 40; i++) await net.alarm();
  assert.notEqual(view(host).current_player === who.seat && view(host).phase === 'setup', true, 'bot placed for the idle player');
  // the player comes back by acting
  const legal = view(who).legal_actions.find((a) => a.type === 'build' || a.type === 'roll_dice');
  if (legal && view(who).current_player === who.seat) {
    const { type, ...params } = legal;
    await who.send({ t: 'action', type, params });
    assert.equal(host.last('lobby')!.seats.find((s) => s.id === who.seat)!.bot, 'none');
  }
  await host.send({ t: 'host', cmd: { c: 'turn_timer', seconds: 0 } });
  assert.equal(host.last('lobby')!.turnTimerS, 0);
});

test('host can hand a quiet seat to a bot, and a newcomer can be approved into it mid-game', async () => {
  const { net, host, sam } = await startedGame();
  await host.send({ t: 'host', cmd: { c: 'bot_seat', seat: sam.seat!, on: true } });
  assert.equal(host.last('lobby')!.seats.find((s) => s.id === sam.seat)!.bot, 'host');
  const newbie = net.connect();
  await newbie.send({ t: 'join', name: 'Newbie', invite: net.invite, token: newbie.token });
  assert.deepEqual(newbie.errors(), ['invite_invalid'], 'a started room is locked: the host must rotate the invite first');
  await host.send({ t: 'host', cmd: { c: 'rotate_invite' } });
  await host.send({ t: 'host', cmd: { c: 'lock', on: false } });
  const secret = host.last('invite')!.secret;
  const n2 = net.connect();
  await n2.send({ t: 'join', name: 'Newbie', invite: secret, token: n2.token });
  const req = host.last('lobby')!.pending![0]!;
  await host.send({ t: 'host', cmd: { c: 'approve', request: req.id } });
  assert.ok(host.errors().includes('no_seat'), 'in a running game the host must name the seat');
  await host.send({ t: 'host', cmd: { c: 'approve', request: req.id, seat: sam.seat! } });
  assert.equal(n2.last('joined')?.seat, sam.seat);
  assert.ok(view(n2).me === sam.seat);
  await sam.send({ t: 'action', type: 'roll_dice', params: {} });
  const old = net.connect();
  await old.send({ t: 'resume', token: sam.token });
  assert.deepEqual(old.errors(), ['unknown_token'], "the previous owner's token no longer works");
});

test('profiles: stats follow a recovery code, not a name; wrong code is refused; delete works', async () => {
  const { net, host, sam } = await startedGame({ vp_to_win: 4 });
  await host.send({ t: 'profile_create' });
  const prof = host.last('profile')!;
  assert.ok(prof.secret && prof.recovery);
  await host.send({ t: 'autopilot', on: true });
  await sam.send({ t: 'autopilot', on: true });
  await runToEnd(net);
  assert.equal(net.core.phase, 'finished');
  await host.send({ t: 'profile_stats' });
  assert.equal(host.last('profile')!.stats!.games, 1);

  // A new device with the same *name* gets nothing; the recovery code does.
  const net2 = await Net.make(undefined, net.profiles);
  const h2 = await net2.host();
  await h2.send({ t: 'profile_link', profile: { id: prof.id, secret: newToken() } });
  assert.deepEqual(h2.errors(), ['profile_invalid']);
  await h2.send({ t: 'profile_link', profile: { id: prof.id, secret: prof.secret! } });
  assert.equal(h2.last('profile')!.stats!.games, 1);
  await h2.send({ t: 'profile_delete', profile: { id: prof.id, secret: prof.secret! } });
  await h2.send({ t: 'profile_stats' });
  assert.equal(await net.profiles.stats(prof.id), null);
});

test('closing the room disconnects everyone and the room reports itself dead on the next alarm', async () => {
  const { net, host, sam } = await startedGame();
  await host.send({ t: 'host', cmd: { c: 'close' } });
  assert.ok(sam.closed && host.closed);
  const { dead } = await net.core.alarm(net.now);
  assert.equal(dead, true);
});
