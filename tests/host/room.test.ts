import test from 'node:test';
import assert from 'node:assert/strict';
import { Net } from './net.ts';
import { HOST_CONFIG } from '@app-builder/host/turn/config';
import { sha256Hex, newToken } from '@app-builder/host/turn/crypto';

test('shared link: request -> host approves -> seated; host sees duplicate names', async () => {
  const net = await Net.make();
  const host = await net.host();
  const sam = net.connect();
  await sam.send({ t: 'join', name: 'Sam', invite: net.invite, token: sam.token });
  assert.equal(sam.last('pending')?.position, 1);
  const req = host.last('lobby')!.pending![0]!;
  assert.equal(req.name, 'Sam');
  assert.equal(req.dupName, false);
  const sam2 = net.connect();
  await sam2.send({ t: 'join', name: 'sam', invite: net.invite, token: sam2.token });
  assert.equal(host.last('lobby')!.pending!.every((p) => p.dupName), true, 'both flagged when names collide');
  await host.send({ t: 'host', cmd: { c: 'approve', request: req.id } });
  assert.equal(sam.last('joined')?.host, false);
  assert.equal(host.last('lobby')!.seats.length, 2);
  // a pending client can do nothing until approved
  await sam2.send({ t: 'action', type: 'roll_dice', params: {} });
  assert.equal(sam2.last('joined'), undefined);
});

test('a leaked link only lets someone ask: bad invite, expired invite, locked room and unauthenticated messages are refused', async () => {
  const net = await Net.make();
  const host = await net.host();
  const bad = net.connect();
  await bad.send({ t: 'join', name: 'Eve', invite: newToken(), token: bad.token });
  assert.deepEqual(bad.errors(), ['invite_invalid']);
  assert.ok(bad.closed);
  assert.equal(host.last('lobby')!.pending!.length, 0);

  const nobody = net.connect();
  await nobody.send({ t: 'action', type: 'roll_dice', params: {} });
  assert.ok(nobody.closed, 'unauthenticated sockets are dropped for anything but join/resume');

  await host.send({ t: 'host', cmd: { c: 'lock', on: true } });
  const late = net.connect();
  await late.send({ t: 'join', name: 'Late', invite: net.invite, token: late.token });
  assert.deepEqual(late.errors(), ['invite_invalid']);
  await host.send({ t: 'host', cmd: { c: 'lock', on: false } });

  net.now += HOST_CONFIG.inviteTtlMs + 1;
  const old = net.connect();
  await old.send({ t: 'join', name: 'Old', invite: net.invite, token: old.token });
  assert.deepEqual(old.errors(), ['invite_invalid']);
});

test('pending requests are capped, expire, and a rotated invite kills the old link', async () => {
  const net = await Net.make();
  const host = await net.host();
  for (let i = 0; i < HOST_CONFIG.maxPendingJoins; i++) { const c = net.connect(); await c.send({ t: 'join', name: `N${i}`, invite: net.invite, token: c.token }); assert.ok(c.last('pending')); }
  const over = net.connect();
  await over.send({ t: 'join', name: 'Over', invite: net.invite, token: over.token });
  assert.deepEqual(over.errors(), ['busy']);

  net.now += HOST_CONFIG.joinRequestTtlMs + 1;
  await net.core.alarm(net.now).then(({ out }) => net.flush(out));
  assert.equal(host.last('lobby')!.pending!.length, 0);

  const oldInvite = net.invite;
  await host.send({ t: 'host', cmd: { c: 'rotate_invite' } });
  const secret = host.last('invite')!.secret;
  const c1 = net.connect();
  await c1.send({ t: 'join', name: 'A', invite: oldInvite, token: c1.token });
  assert.deepEqual(c1.errors(), ['invite_invalid']);
  const c2 = net.connect();
  await c2.send({ t: 'join', name: 'B', invite: secret, token: c2.token });
  assert.ok(c2.last('pending'));
});

test('host-only commands are refused for friends; seat tokens are bound to seats; kicked tokens die', async () => {
  const net = await Net.make();
  const host = await net.host();
  const sam = await net.friend(host, 'Sam');
  const jo = await net.friend(host, 'Jo');
  await sam.send({ t: 'host', cmd: { c: 'start' } });
  assert.deepEqual(sam.errors(), ['forbidden']);
  await sam.send({ t: 'host', cmd: { c: 'kick', seat: jo.seat } });
  assert.equal(sam.errors().length, 2);
  assert.equal(net.core.phase, 'lobby');

  // reconnect with Sam's token gets Sam's seat; a made-up token gets nothing
  const again = net.connect();
  again.token = sam.token;
  await again.send({ t: 'resume', token: again.token });
  assert.equal(again.last('joined')?.seat, sam.seat);
  assert.ok(sam.closed, 'old socket for the seat is replaced');
  const forged = net.connect();
  await forged.send({ t: 'resume', token: newToken() });
  assert.deepEqual(forged.errors(), ['unknown_token']);

  await host.send({ t: 'host', cmd: { c: 'kick', seat: jo.seat } });
  assert.ok(jo.closed);
  const back = net.connect();
  await back.send({ t: 'resume', token: jo.token });
  assert.deepEqual(back.errors(), ['unknown_token']);
});

test('oversize messages close the socket; floods are rate limited then dropped; junk is rejected', async () => {
  const net = await Net.make();
  const host = await net.host();
  await host.send('x'.repeat(HOST_CONFIG.maxMsgBytes + 1));
  assert.equal(host.closed?.code, 1009);

  const net2 = await Net.make();
  const h2 = await net2.host();
  for (let i = 0; i < HOST_CONFIG.maxMsgsPerSec * 4; i++) await h2.send({ t: 'profile_stats' });
  assert.ok(h2.closed, 'sustained flooding disconnects');
  assert.equal(h2.closed?.code, 1008);

  const net3 = await Net.make();
  const h3 = await net3.host();
  for (const junk of ['not json', '[]', '{"t":42}', '{"t":"nope"}', '{"t":"action","type":"roll_dice","params":"x"}', '{"t":"host","cmd":{"c":"approve","request":"../../x"}}']) await h3.send(junk);
  assert.ok(h3.errors().length >= 5);
  assert.equal(h3.closed, null);
});

test('names are plain text: markup, control and bidi characters are stripped, length is capped', async () => {
  const net = await Net.make();
  const host = await net.host();
  const c = net.connect();
  await c.send({ t: 'join', name: '<img src=x onerror=alert(1)>‮\u0007Zed' + 'z'.repeat(40), invite: net.invite, token: c.token });
  const name = host.last('lobby')!.pending![0]!.name;
  assert.ok(!/[<>"'&‮\u0007]/.test(name), name);
  assert.ok(name.length <= HOST_CONFIG.nameMaxLen);
});

test('tokens and hashes never appear in anything sent to any client', async () => {
  const net = await Net.make();
  const host = await net.host();
  const sam = await net.friend(host, 'Sam');
  await host.send({ t: 'host', cmd: { c: 'start' } });
  const secrets = [net.invite, net.hostToken, sam.token, await sha256Hex(net.invite), await sha256Hex(sam.token), await sha256Hex(net.hostToken)];
  const wire = net.everySent.join('\n');
  for (const s of secrets) assert.ok(!wire.includes(s), 'a secret leaked onto the wire');
});
