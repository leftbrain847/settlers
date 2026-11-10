// Builds the whole 3D board (tiles, dressing, pieces, ports, sea) from a GameView. Pure construction: no renderer needed.
import * as THREE from 'three';
import { topology } from '../../engine/topology.ts';
import { place } from './batch.ts';
import { hexTopGeometry, hexXZ, noise2, rngFor, SQ3 } from './geometry.ts';
import { Kit, scaleSat, tint } from './kit.ts';
import { Pieces } from './pieces.ts';
import { DRESS, hexNorm } from './props.ts';
import type { SheepRef } from './props.ts';
import { BACKDROP_DIM } from './style.ts';
import type { LightPreset, Palette, StylePreset } from './style.ts';
import type { GameConfig, GameView } from '../../engine/types.ts';

export type MakeCanvas = (w: number, h: number) => HTMLCanvasElement;

export interface BuildOpts { view: GameView; cfg: GameConfig; style: StylePreset; light: LightPreset; pal: Palette; makeCanvas: MakeCanvas }

export interface Built {
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  /** things that always face the camera (number chips) */
  chips: THREE.Object3D[];
  /** world points the camera must keep in frame */
  fit: THREE.Vector3[];
  radius: number;
  tick(t: number): void;
  /** settlements, roads, robber, tap targets: redrawn as the game changes */
  pieces: Pieces;
  hexPoint(id: number): THREE.Vector3;
  interPoint(id: number): THREE.Vector3;
  edgePoint(id: number): THREE.Vector3;
  dispose(): void;
}

const R = 0.975;
const BASE_TOP: Record<string, number> = { hills: 0.3, mountains: 0.36, forest: 0.2, fields: 0.14, pasture: 0.16, desert: 0.12 };
const RELIEF: Record<string, number> = { hills: 1.8, mountains: 1.6, forest: 1, fields: 0.35, pasture: 0.8, desert: 1.1 };
const DEPTH = 0.45;

function textureFrom(canvas: HTMLCanvasElement): THREE.DataTexture {
  const ctx = canvas.getContext('2d')!;
  const { width: w, height: h } = canvas;
  const src = ctx.getImageData(0, 0, w, h).data;
  const flipped = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) flipped.set(src.subarray(y * w * 4, (y + 1) * w * 4), (h - 1 - y) * w * 4);
  const tex = new THREE.DataTexture(flipped, w, h, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

const PIPS: Record<number, number> = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };

function chipTexture(n: number, make: MakeCanvas): THREE.DataTexture {
  const c = make(128, 128);
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 128, 128);
  g.beginPath(); g.arc(64, 64, 60, 0, Math.PI * 2); g.fillStyle = '#f4ecd8'; g.fill();
  g.lineWidth = 5; g.strokeStyle = '#b9a77c'; g.stroke();
  const red = n === 6 || n === 8;
  g.fillStyle = red ? '#c0261e' : '#2b2a28';
  g.font = `bold ${n >= 10 ? 52 : 60}px sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String(n), 64, 56);
  const pips = PIPS[n] ?? 0;
  for (let i = 0; i < pips; i++) { g.beginPath(); g.arc(64 + (i - (pips - 1) / 2) * 11, 96, 3.6, 0, Math.PI * 2); g.fill(); }
  return textureFrom(c);
}

/** Layers of soil under each tile: a thin topsoil band, then stripes of earth that darken with depth, with speckle. */
function strata(base: THREE.Color, make: MakeCanvas, keep: { dispose(): void }[]): THREE.DataTexture {
  const W = 256, H = 64;
  const c = make(W, H), g = c.getContext('2d')!;
  const hsl = { h: 0, s: 0, l: 0 };
  base.getHSL(hsl, THREE.SRGBColorSpace);
  const rng = rngFor(Math.round(hsl.h * 1000) + 5);
  const bands = [0, 0.12, 0.3, 0.46, 0.7, 1].map((y, i, a) => ({ y: y * H, to: (a[i + 1] ?? 1) * H, l: i === 0 ? hsl.l + 0.1 : 0.34 - i * 0.045 + (rng() - 0.5) * 0.06, s: i === 0 ? hsl.s : 0.28 + (rng() - 0.5) * 0.1 }));
  for (const b of bands.slice(0, -1)) {
    g.fillStyle = `hsl(${Math.round((i0(hsl.h, b) * 360))}, ${Math.round(b.s * 100)}%, ${Math.round(Math.max(0.1, b.l) * 100)}%)`;
    g.fillRect(0, b.y, W, b.to - b.y); // textureFrom flips rows, so the canvas top lands at the top of the tile side
  }
  for (let i = 0; i < 420; i++) {
    g.fillStyle = rng() < 0.5 ? 'rgba(0,0,0,0.13)' : 'rgba(255,255,255,0.08)';
    const sz = 1 + rng() * 2.5;
    g.fillRect(rng() * W, rng() * H, sz * 1.8, sz);
  }
  const tex = textureFrom(c);
  keep.push(tex);
  return tex;
}
const i0 = (h: number, b: { l: number }): number => (b.l > 0.4 ? h : 0.075);

function badgeTexture(label: string, ring: string, make: MakeCanvas): THREE.DataTexture {
  const c = make(128, 128);
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 128, 128);
  g.beginPath(); g.arc(64, 64, 58, 0, Math.PI * 2); g.fillStyle = '#fbf5e6'; g.fill();
  g.lineWidth = 14; g.strokeStyle = ring; g.stroke();
  g.fillStyle = '#2b2a28'; g.font = 'bold 44px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(label, 64, 66);
  return textureFrom(c);
}

/** Sea: a flat unlit plane whose color is computed per pixel from the distance to the nearest tile, so the shoreline is exact. */
function seaMaterial(tiles: ({ x: number; z: number } | undefined)[], pal: Palette, light: LightPreset, time: { value: number }, style: StylePreset): THREE.MeshBasicMaterial {
  const pts = tiles.filter((t): t is { x: number; z: number } => !!t).map((t) => new THREE.Vector2(t.x, t.z));
  const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(light.waterTint).multiplyScalar(BACKDROP_DIM), fog: true });
  const col = (hex: string): THREE.Color => new THREE.Color(hex);
  const uniforms = { uTime: time, uHex: { value: pts }, uShore: { value: col(pal.shore) }, uSea: { value: col(pal.sea) }, uDeep: { value: col(pal.deep) }, uSun: { value: new THREE.Color(light.sun) }, uGlint: { value: light.windows > 0.3 ? 0.35 : 1 }, uFoam: { value: style.flat ? 0 : 1 } };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvW = (modelMatrix * vec4(position, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vW; uniform float uTime; uniform vec2 uHex[${pts.length}]; uniform vec3 uShore, uSea, uDeep, uSun; uniform float uGlint, uFoam;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }`)
      .replace('#include <color_fragment>', `
        float d = 99.0;
        for (int i = 0; i < ${pts.length}; i++) {
          vec2 q = vW - uHex[i];
          float n = max(abs(q.x) / 0.8660254, abs(q.y) + abs(q.x) / 1.7320508);
          d = min(d, (n - 1.0) * 0.8660254);
        }
        d = max(d, 0.0);
        vec3 water = mix(uShore, uSea, smoothstep(0.0, 0.75, d));
        water = mix(water, uDeep, 0.6 * smoothstep(0.8, 7.0, d));
        float swell = vnoise(vW * 2.2 + vec2(uTime * 0.35, -uTime * 0.25)) * 0.6 + vnoise(vW * 5.0 - vec2(uTime * 0.5, uTime * 0.3)) * 0.4;
        water *= 0.92 + 0.12 * swell;
        // foam: a wavering white line at the shore plus a faint second one that rolls in and out
        float edge = d + (swell - 0.5) * 0.07;
        float line = smoothstep(0.06, 0.02, edge) * 0.9;
        float roll = 0.11 + 0.05 * sin(uTime * 1.1);
        float ring = smoothstep(0.03, 0.0, abs(edge - roll - 0.06)) * 0.45 * smoothstep(0.05, 0.12, vnoise(vW * 7.0 + uTime * 0.2));
        water = mix(water, vec3(0.97), (line + ring) * uFoam);
        // sun glints: tiny bright specks that blink on the swell
        float sp = smoothstep(0.9, 0.985, vnoise(vW * 7.0 + vec2(uTime * 0.9, uTime * 0.6))) * smoothstep(0.55, 0.9, vnoise(vW * 1.3 - uTime * 0.1));
        water += uSun * sp * 0.3 * uGlint * smoothstep(0.5, 1.5, d) * (1.0 - smoothstep(2.5, 5.0, d)) * uFoam;
        diffuseColor.rgb = water * diffuse;`);
  };
  mat.customProgramCacheKey = () => `sea-${pts.length}`;
  return mat;
}

export function buildBoard(o: BuildOpts): Built {
  const { view, style, light, pal } = o;
  const topo = topology(view.board.rings);
  const kit = new Kit(style);
  const scene = new THREE.Scene();
  const disposables: { dispose(): void }[] = [kit];
  const sheep: SheepRef[] = [];
  const chips: THREE.Object3D[] = [];
  const fit: THREE.Vector3[] = [];
  const tileTop: number[] = [];
  const tileXZ: { x: number; z: number }[] = [];

  scene.background = new THREE.Color(light.sky);
  scene.fog = new THREE.Fog(light.fog, light.fogNear, light.fogFar);

  // ---------------------------------------------------------------- tiles
  const tiles = new THREE.Group();
  const sideMats = new Map<string, THREE.MeshStandardMaterial>();
  const topMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: style.flat, roughness: 0.92, metalness: 0 });
  disposables.push(topMat);
  const hexById = new Map(view.board.hexes.map((h) => [h.id, h]));
  let maxR = 0;

  for (const hx of view.board.hexes) {
    const { x: cx, z: cz } = hexXZ(hx.q, hx.r);
    tileXZ[hx.id] = { x: cx, z: cz };
    maxR = Math.max(maxR, Math.hypot(cx, cz));
    const top = (BASE_TOP[hx.terrain] ?? 0.15) + (style.relief > 0 ? noise2(cx * 0.9, cz * 0.9, 5) * 0.025 : 0);
    tileTop[hx.id] = top;
    const hexColor = scaleSat(pal.terrain[hx.terrain] ?? '#88aa88', style.saturation);
    const relief = style.relief * (RELIEF[hx.terrain] ?? 1);
    const heightAt = (lx: number, lz: number, edge: number): number => (relief ? relief * noise2((cx + lx) * 1.7, (cz + lz) * 1.7, 11) * (1 - edge) ** 1.3 + relief * 0.4 * (1 - edge) : 0);
    const surface = (lx: number, lz: number): number => top + heightAt(lx, lz, Math.min(1, hexNorm(lx, lz)));

    const colorAt = (lx: number, lz: number, y: number): THREE.Color => {
      const n = noise2((cx + lx) * 2.3, (cz + lz) * 2.3, 3);
      const rim = style.flat ? 0 : Math.max(0, hexNorm(lx, lz) - 0.7) / 0.3;
      const speck = style.flat ? 0 : noise2((cx + lx) * 9, (cz + lz) * 9, 21) * style.jitter * 0.5;
      return tint(hexColor, n * style.jitter * 0.25, n * style.jitter, n * style.jitter * 1.5 + speck + (relief ? y * 0.5 : 0) - rim * rim * 0.09);
    };
    const topGeo = hexTopGeometry(R * style.lip, style.topDetail, heightAt, colorAt);
    const topMesh = new THREE.Mesh(topGeo, topMat);
    topMesh.position.set(cx, top + 0.002, cz);
    topMesh.receiveShadow = style.shadows; topMesh.castShadow = style.shadows && relief > 0;
    tiles.add(topMesh);
    disposables.push(topGeo);

    let side = sideMats.get(hx.terrain);
    if (!side) {
      const sideColor = style.tray ? tint('#8a5e3a', 0, 0, 0.02) : tint(hexColor, 0, -0.1, -0.2);
      side = new THREE.MeshStandardMaterial({ color: style.flat ? sideColor : '#ffffff', map: style.flat || style.tray ? null : strata(sideColor, o.makeCanvas, disposables), flatShading: style.flat, roughness: 0.95 });
      sideMats.set(hx.terrain, side);
    }
    const rim = new THREE.MeshStandardMaterial({ color: tint(hexColor, 0, -0.05, -0.1), flatShading: style.flat, roughness: 0.9 });
    disposables.push(rim);
    const sideGeo = new THREE.CylinderGeometry(R, R * 0.97, top + DEPTH, 6);
    const sideMesh = new THREE.Mesh(sideGeo, [side, rim, side]);
    sideMesh.position.set(cx, (top - DEPTH) / 2, cz);
    sideMesh.castShadow = style.shadows; sideMesh.receiveShadow = style.shadows;
    tiles.add(sideMesh);
    disposables.push(sideGeo);

    const hasChip = hx.number_token !== null;
    DRESS[hx.terrain]?.({ kit, preset: style, pal, hexId: hx.id, cx, cz, surface, hasChip, sheep });

    for (let k = 0; k < 6; k++) fit.push(new THREE.Vector3(cx + Math.sin((k * Math.PI) / 3), top, cz + Math.cos((k * Math.PI) / 3)));
  }
  scene.add(tiles);

  // ---------------------------------------------------------------- number chips
  const chipTex = new Map<number, THREE.DataTexture>();
  const discGeo = new THREE.CylinderGeometry(0.26, 0.26, 0.05, 28);
  const discMat = new THREE.MeshStandardMaterial({ color: '#efe5cb', roughness: 0.6 });
  disposables.push(discGeo, discMat);
  for (const hx of view.board.hexes) {
    if (hx.number_token === null) continue;
    const { x, z } = tileXZ[hx.id]!;
    let tex = chipTex.get(hx.number_token);
    if (!tex) { tex = chipTexture(hx.number_token, o.makeCanvas); chipTex.set(hx.number_token, tex); disposables.push(tex); }
    const g = new THREE.Group();
    g.position.set(x, tileTop[hx.id]! + 0.24, z);
    const disc = new THREE.Mesh(discGeo, discMat);
    disc.rotation.x = Math.PI / 2;
    disc.castShadow = style.shadows;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.52), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, color: light.chipTint }));
    face.position.z = 0.03;
    disposables.push(face.geometry as THREE.BufferGeometry, face.material as THREE.Material);
    g.add(disc, face);
    scene.add(g);
    chips.push(g);
    if (!style.flat) kit.batch('blob', 'blob', kit.blob(), { castShadow: false }).add(place(x + 0.02, tileTop[hx.id]! + 0.012, z + 0.03, 0.3, 1, 0.3));
  }

  // ---------------------------------------------------------------- pieces
  const heightAtInter = (iid: number): number => Math.max(...topo.intersections[iid]!.hexIds.map((h) => tileTop[h] ?? 0.15));
  const interPoint = (iid: number): THREE.Vector3 => {
    const i = topo.intersections[iid]!;
    const { x, z } = hexXZ(i.q, i.r);
    return new THREE.Vector3(x, heightAtInter(iid), z);
  };
  const edgePoint = (eid: number): THREE.Vector3 => {
    const e = topo.edges[eid]!;
    return interPoint(e.a).add(interPoint(e.b)).multiplyScalar(0.5);
  };
  const hexPoint = (id: number): THREE.Vector3 => new THREE.Vector3(tileXZ[id]?.x ?? 0, tileTop[id] ?? 0.15, tileXZ[id]?.z ?? 0);

  const pieces = new Pieces({ kit, style, light, pal, topo, scene, interPoint, edgePoint, hexPoint, hasChip: (id) => hexById.get(id)?.number_token !== null });
  disposables.push({ dispose: () => pieces.dispose() });
  pieces.set(view, {});

  // ---------------------------------------------------------------- ports
  const boats = new THREE.Group();
  const bobbers: { g: THREE.Object3D; y: number; yaw: number; phase: number }[] = [];
  const hullMat = new THREE.MeshStandardMaterial({ color: '#8a5a33', flatShading: style.flat, roughness: 0.8 });
  const sailMat = new THREE.MeshStandardMaterial({ color: '#f3efe6', flatShading: style.flat, roughness: 0.9, side: THREE.DoubleSide });
  const pierMat = new THREE.MeshStandardMaterial({ color: '#a87a4a', roughness: 0.85 });
  disposables.push(hullMat, sailMat, pierMat);
  for (const [a, b, type] of view.board.port_slots ?? []) {
    const pa = interPoint(a), pb = interPoint(b);
    const mid = pa.clone().add(pb).multiplyScalar(0.5);
    const out = new THREE.Vector3(mid.x, 0, mid.z).normalize();
    const boat = new THREE.Group();
    const hull = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.09, 0.2), hullMat); hull.position.y = 0.05;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.5, 5), pierMat); mast.position.y = 0.32;
    const sail = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.42, 3), sailMat); sail.position.set(0, 0.3, 0.0); sail.rotation.y = Math.PI / 2; sail.scale.z = 0.25;
    boat.add(hull, mast, sail);
    const pt = o.cfg.port_types[type];
    const ring = pt?.resource ? (pal.terrain[o.cfg.resource_types[pt.resource]?.terrain ?? ''] ?? '#d8a640') : '#e8e2d0';
    const badge = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.62), new THREE.MeshBasicMaterial({ map: badgeTexture(`${pt?.ratio ?? 3}:1`, ring, o.makeCanvas), transparent: true, depthWrite: false, color: light.chipTint }));
    badge.position.set(mid.x + out.x * 0.95, 1.0, mid.z + out.z * 0.95);
    scene.add(badge); // not a child of the boat: it must face the camera in world space
    chips.push(badge);
    disposables.push(hull.geometry as THREE.BufferGeometry, mast.geometry as THREE.BufferGeometry, sail.geometry as THREE.BufferGeometry, badge.geometry as THREE.BufferGeometry, badge.material as THREE.Material);
    boat.position.set(mid.x + out.x * 0.95, 0.0, mid.z + out.z * 0.95);
    boat.rotation.y = Math.atan2(out.x, out.z) + Math.PI / 2;
    boat.scale.setScalar(1.45);
    boats.add(boat);
    bobbers.push({ g: boat, y: boat.position.y, yaw: boat.rotation.y, phase: bobbers.length * 1.7 });
    for (const p of [pa, pb]) {
      const dx = boat.position.x - p.x, dz = boat.position.z - p.z, len = Math.hypot(dx, dz);
      const pier = new THREE.Mesh(new THREE.BoxGeometry(len * 0.9, 0.03, 0.05), pierMat);
      pier.position.set(p.x + dx * 0.5, 0.07, p.z + dz * 0.5);
      pier.rotation.y = -Math.atan2(dz, dx);
      boats.add(pier);
      disposables.push(pier.geometry as THREE.BufferGeometry);
    }
    fit.push(new THREE.Vector3(boat.position.x, 0.8, boat.position.z));
  }
  scene.add(boats);

  // ---------------------------------------------------------------- sea (or felt) and tray
  const seaR = maxR + 12;
  const seaUniform = { value: 0 };
  const seaMesh = new THREE.Mesh(new THREE.PlaneGeometry(seaR * 2, seaR * 2, 1, 1).rotateX(-Math.PI / 2), seaMaterial(tileXZ, pal, light, seaUniform, style));
  seaMesh.receiveShadow = false;
  scene.add(seaMesh);
  disposables.push(seaMesh.geometry, seaMesh.material as THREE.Material);

  if (style.tray) {
    // a felt-topped board inside a wooden frame: the felt takes the shoreline gradient, the frame is a base slab with six rails
    const trayR = maxR + 2.4;
    scene.remove(seaMesh);
    const felt = new THREE.Mesh(hexTopGeometry(trayR, 16, () => 0, (x, z) => {
      let d = Infinity;
      for (const tl of tileXZ) if (tl) d = Math.min(d, Math.hypot(x - tl.x, z - tl.z));
      const edge = Math.max(0, d - 1);
      return new THREE.Color(pal.shore).lerp(new THREE.Color(pal.sea), Math.min(1, edge / 0.9)).lerp(new THREE.Color(pal.deep), Math.min(1, Math.max(0, edge - 0.8) / 4));
    }), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: false }));
    felt.position.y = 0.0; felt.receiveShadow = true;
    scene.add(felt);
    const wood = new THREE.MeshStandardMaterial({ color: '#7b5230', roughness: 0.65, flatShading: true });
    const slab = new THREE.Mesh(new THREE.CylinderGeometry(trayR + 0.52, trayR + 0.6, 0.55, 6), wood);
    slab.position.y = -0.33; slab.castShadow = true; slab.receiveShadow = true;
    scene.add(slab);
    const railR = trayR + 0.04;
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI) / 3 + Math.PI / 6; // edge midpoints of a pointy-top hexagon
      const apothem = railR * Math.cos(Math.PI / 6);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(railR + 0.5, 0.3, 0.5), wood);
      rail.position.set(Math.sin(a) * (apothem + 0.22), 0.08, Math.cos(a) * (apothem + 0.22));
      rail.rotation.y = a;
      rail.castShadow = true; rail.receiveShadow = true;
      scene.add(rail);
      disposables.push(rail.geometry as THREE.BufferGeometry);
    }
    disposables.push(wood, slab.geometry as THREE.BufferGeometry, felt.geometry as THREE.BufferGeometry, felt.material as THREE.Material);
    const far = trayR + 0.9;
    fit.push(new THREE.Vector3(0, 0.3, far), new THREE.Vector3(0, 0.3, -far), new THREE.Vector3(far, 0.3, 0), new THREE.Vector3(-far, 0.3, 0));
    for (let k = 0; k < 6; k++) fit.push(new THREE.Vector3(Math.sin((k * Math.PI) / 3) * (trayR + 0.7), 0.3, Math.cos((k * Math.PI) / 3) * (trayR + 0.7)));
  }

  // ---------------------------------------------------------------- birds (realistic only): a few gulls circling high over the sea
  const gulls: { m: THREE.Mesh; r: number; h: number; speed: number; phase: number }[] = [];
  if (!style.flat && light.windows < 0.3) {
    const wing = new THREE.BufferGeometry();
    wing.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.05, -0.16, 0.02, -0.04, 0, 0, -0.05, 0, 0, 0.05, 0.16, 0.02, -0.04, 0, 0, -0.05], 3));
    wing.computeVertexNormals();
    const gullMat = new THREE.MeshBasicMaterial({ color: '#fbfbf6', side: THREE.DoubleSide, fog: true });
    disposables.push(wing, gullMat);
    for (let i = 0; i < 5; i++) {
      const m = new THREE.Mesh(wing, gullMat);
      scene.add(m);
      gulls.push({ m, r: maxR + 1.8 + (i % 3) * 1.1, h: 1.9 + (i % 2) * 0.7 + i * 0.1, speed: 0.09 + (i % 3) * 0.02, phase: i * 1.3 });
    }
  }

  // ---------------------------------------------------------------- lights
  // Land and sea are lit at BACKDROP_DIM; player pieces carry their own glow (pieces.ts), so they stand out.
  const hemi = new THREE.HemisphereLight(light.hemiSky, light.hemiGround, light.hemi * BACKDROP_DIM);
  const sun = new THREE.DirectionalLight(light.sun, light.sunPower * BACKDROP_DIM);
  sun.position.set(...light.sunPos);
  sun.target.position.set(0, 0, 0);
  if (style.shadows) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const ext = maxR + 3;
    Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: 40 });
    sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.02;
  }
  scene.add(hemi, sun, sun.target);

  // ---------------------------------------------------------------- batches into the scene
  for (const b of kit.allBatches()) { const m = b.build(); if (m) scene.add(m); }

  // ---------------------------------------------------------------- motion
  const tick = (t: number): void => {
    kit.wind.value = t; seaUniform.value = t;
    for (const s of sheep) {
      const a = t * 0.22 + s.phase;
      const x = s.home.x + Math.cos(a) * s.radius, z = s.home.z + Math.sin(a) * s.radius;
      s.batch.set(s.index, place(x, s.home.y + Math.abs(Math.sin(t * 2 + s.phase)) * 0.006, z, s.scale, s.scale, s.scale, -a - Math.PI / 2));
    }
    pieces.tick(t);
    for (const o of bobbers) { o.g.position.y = o.y + Math.sin(t * 1.3 + o.phase) * 0.018; o.g.rotation.z = Math.sin(t * 1.1 + o.phase) * 0.05; }
    for (const b of gulls) {
      const a = t * b.speed + b.phase;
      b.m.position.set(Math.cos(a) * b.r, b.h + Math.sin(t * 0.8 + b.phase) * 0.08, Math.sin(a) * b.r);
      b.m.rotation.set(0, -a, Math.sin(t * 5 + b.phase) * 0.3); // banked into the circle, wings flapping
    }
  };
  tick(0);

  return {
    scene, sun, chips, fit, pieces, radius: maxR + 1.5, tick, hexPoint, interPoint, edgePoint,
    dispose: () => { for (const d of disposables) d.dispose(); },
  };
}
