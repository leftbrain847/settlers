import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCanvas } from '@napi-rs/canvas';
import { buildBoard } from '../../games/settlers/client/board3d/scene.ts';
import { fitCamera } from '../../games/settlers/client/board3d/board3d.ts';
import { hexTopGeometry } from '../../games/settlers/client/board3d/geometry.ts';
import { windy } from '../../games/settlers/client/board3d/batch.ts';
import { sampleGame } from '../../games/settlers/client/board3d/sample.ts';
import { LIGHTS, PALETTE_IDS, STYLES, paletteOf } from '../../games/settlers/client/board3d/style.ts';
import type { StyleId } from '../../games/settlers/client/board3d/style.ts';

const makeCanvas = ((w: number, h: number) => createCanvas(w, h)) as unknown as (w: number, h: number) => HTMLCanvasElement;
const { cfg, view } = sampleGame();
const build = (style: StyleId, pal = paletteOf('natural')) => buildBoard({ view, cfg, style: STYLES[style], light: LIGHTS.day, pal, makeCanvas });

test('tile tops: normals point up, the rim is flush, no NaN', () => {
  for (const sub of [1, 2, 5]) {
    const g = hexTopGeometry(1, sub, (x, z, edge) => 0.1 * Math.sin(x * 3) * (1 - edge), () => new THREE.Color('#fff'));
    const pos = g.getAttribute('position'), nor = g.getAttribute('normal');
    assert.equal(pos.count, 1 + 3 * sub * (sub + 1));
    for (let i = 0; i < pos.count; i++) {
      assert.ok(Number.isFinite(pos.getY(i)) && Number.isFinite(nor.getY(i)));
      assert.ok(nor.getY(i) > 0.5, `normal ${i} points down at sub ${sub}`);
      if (Math.max(Math.abs(pos.getX(i)) / (Math.sqrt(3) / 2), Math.abs(pos.getZ(i)) + Math.abs(pos.getX(i)) / Math.sqrt(3)) > 0.999) assert.ok(Math.abs(pos.getY(i)) < 1e-9, 'rim must be flush');
    }
  }
});

test('every style builds the sample board with finite transforms and the right amount of stuff', () => {
  for (const style of Object.keys(STYLES) as StyleId[]) {
    const b = build(style);
    let instances = 0;
    b.scene.traverse((o) => {
      const m = o as THREE.InstancedMesh;
      if (!m.isInstancedMesh) return;
      instances += m.count;
      for (let i = 0; i < m.count; i++) { const e = new THREE.Matrix4(); m.getMatrixAt(i, e); assert.ok(e.elements.every(Number.isFinite), `${style}: non-finite instance`); }
    });
    assert.ok(instances > 400, `${style}: only ${instances} instances`);
    const numbered = view.board.hexes.filter((h) => h.number_token !== null).length;
    assert.equal(b.chips.length, numbered + view.board.port_slots.length, 'one chip per number plus one badge per port');
    assert.ok(b.fit.length >= 19 * 6);
    b.tick(1.3);
    b.dispose();
  }
});

test('the fixed camera keeps the whole board in frame on phones, squares and wide screens', () => {
  for (const style of ['civ', 'tabletop'] as StyleId[]) {
    const b = build(style);
    for (const aspect of [0.45, 0.6, 1, 1.8]) {
      const cam = new THREE.PerspectiveCamera(30, aspect, 0.1, 400);
      const target = new THREE.Vector3(0, 0.2, 0);
      fitCamera(cam, b.fit, target);
      const m = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      for (const p of b.fit) { const n = p.clone().applyMatrix4(m); assert.ok(Math.abs(n.x) <= 1 && Math.abs(n.y) <= 1, `${style} @${aspect}: ${n.x.toFixed(2)},${n.y.toFixed(2)} off screen`); }
    }
    b.dispose();
  }
});

test('shader patches target chunks that exist in three\'s standard shader', () => {
  const src = THREE.ShaderLib.standard.vertexShader;
  assert.ok(src.includes('#include <common>') && src.includes('#include <begin_vertex>'));
  const mat = new THREE.MeshStandardMaterial();
  windy(mat, { value: 0 }, 0.05, 'test');
  const shader = { uniforms: {} as Record<string, unknown>, vertexShader: src } as unknown as THREE.WebGLProgramParametersWithUniforms;
  mat.onBeforeCompile(shader, null as unknown as THREE.WebGLRenderer);
  assert.ok(shader.vertexShader.includes('uniform float uTime;') && shader.vertexShader.includes('instanceMatrix[3].x') && shader.vertexShader.includes('transformed.x += sway'));
  assert.ok('uTime' in shader.uniforms);
  const basic = THREE.ShaderLib.basic.vertexShader;
  for (const chunk of ['#include <common>', '#include <color_vertex>', '#include <begin_vertex>']) assert.ok(basic.includes(chunk), `basic shader lacks ${chunk}`);
});

test('palettes cover every terrain and have enough player colors', () => {
  for (const id of PALETTE_IDS) {
    const p = paletteOf(id);
    for (const t of ['hills', 'forest', 'mountains', 'fields', 'pasture', 'desert']) assert.ok(p.terrain[t], `${id} lacks ${t}`);
    assert.ok(p.players.length >= 4 && p.foliage && p.grass && p.wheat && p.sea);
    assert.ok(build('civ', p).scene.children.length > 5);
  }
});

test('animation moves sheep and smoke, and nothing else drifts', () => {
  const b = build('civ');
  const flock = b.scene.children.filter((o) => (o as THREE.InstancedMesh).isInstancedMesh).map((o) => o as THREE.InstancedMesh);
  const snap = () => flock.map((m) => Array.from(m.instanceMatrix.array as Float32Array).join(','));
  const a = snap();
  b.tick(5);
  const c = snap();
  const changed = a.filter((x, i) => x !== c[i]).length;
  assert.ok(changed >= 1 && changed <= 3, `${changed} instanced meshes moved (expected sheep and smoke only)`);
});

test('tap targets: a ray through each highlighted spot hits exactly that spot', () => {
  const b = build('realistic');
  const camera = new THREE.PerspectiveCamera(30, 0.6, 0.1, 400);
  const target = new THREE.Vector3(0, 0.2, 0);
  fitCamera(camera, b.fit, target);
  const ids = { i: [3, 10, 20], e: [5, 12], h: [4] };
  b.pieces.set(view, { i: new Set(ids.i), e: new Set(ids.e), h: new Set(ids.h) });
  b.scene.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  const pts = { i: b.interPoint, e: b.edgePoint, h: b.hexPoint } as const;
  for (const kind of ['i', 'e', 'h'] as const) for (const id of ids[kind]) {
    const p = pts[kind](id).clone().project(camera);
    ray.setFromCamera(new THREE.Vector2(p.x, p.y), camera);
    const hit = ray.intersectObjects(b.pieces.hits, false)[0];
    assert.ok(hit, `${kind}${id}: nothing hit`);
    assert.deepEqual(hit.object.userData, { kind, id });
  }
  b.pieces.set(view, {});
  assert.equal(b.pieces.hits.length, 0, 'targets vanish when nothing is highlighted');
});

test('pieces: new buildings pop in, then settle at full size', () => {
  const b = build('realistic');
  const iid = Number(Object.keys(view.board.buildings.i)[0]);
  const t0 = 1_000_000;
  b.pieces.set(view, { fresh: { i: new Map([[iid, t0]]), e: new Map() } }, t0 + 40);
  const scales: number[] = [];
  b.scene.traverse((o) => { if (o.type === 'Group' && o.scale.x < 0.99) scales.push(o.scale.x); });
  assert.ok(scales.length >= 1, 'a fresh piece starts small');
  b.pieces.tick(0, t0 + 1000);
  const after: number[] = [];
  b.scene.traverse((o) => { if (o.type === 'Group' && o.scale.x < 0.99) after.push(o.scale.x); });
  assert.equal(after.length, 0);
});

test('big boards: the sea shader only loops over coast tiles, so it stays within phone GPU limits', async () => {
  const { configFromSettings, createGame, addPlayer, startGame, viewFor } = await import('../../games/settlers/engine/index.ts');
  for (const rings of [3, 8]) {
    const c = configFromSettings({ board_rings: rings });
    let s = createGame(c, { game_id: 'big', seed: 2 });
    for (const n of ['a', 'b', 'c']) s = addPlayer(c, s, { name: n });
    s = startGame(c, s).state;
    const b = buildBoard({ view: viewFor(c, s, s.player_order[0]!), cfg: c, style: STYLES.realistic, light: LIGHTS.day, pal: paletteOf('natural'), makeCanvas });
    let key = '';
    b.scene.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.Material | undefined; const k = m?.customProgramCacheKey?.(); if (k?.startsWith('sea-')) key = k; });
    const n = Number(key.slice(4));
    assert.equal(n, rings === 1 ? 1 : 6 * (rings - 1), `${rings} rings: sea loops over ${n} tiles`);
    b.dispose();
  }
});
