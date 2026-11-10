// The parts of the 3D board that change during play: settlements, cities, roads, the robber, plus the tap targets and ghost preview.
// Rebuilt on every update (they are a few dozen meshes); the terrain around them is built once.
import * as THREE from 'three';
import { Kit, scaleSat, tint } from './kit.ts';
import { PIECE_GLOW } from './style.ts';
import type { LightPreset, Palette, StylePreset } from './style.ts';
import type { Topology } from '../../engine/topology.ts';
import type { GameView } from '../../engine/types.ts';
import type { BoardTargets } from '../ui-types.ts';

export interface PiecesCtx {
  kit: Kit; style: StylePreset; light: LightPreset; pal: Palette; topo: Topology; scene: THREE.Scene;
  interPoint(id: number): THREE.Vector3; edgePoint(id: number): THREE.Vector3; hexPoint(id: number): THREE.Vector3;
  hasChip(hexId: number): boolean;
}

export interface Hit { kind: 'i' | 'e' | 'h'; id: number }

const POP_MS = 380;
const easeOutBack = (x: number): number => { const c = 1.9; return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2; };

export class Pieces {
  private group = new THREE.Group();
  private pops: { obj: THREE.Object3D; born: number }[] = [];
  private pulses: { mat: THREE.Material & { opacity: number }; base: number }[] = [];
  private smokers: { mesh: THREE.Mesh; x: number; y: number; z: number; i: number }[] = [];
  private robber: THREE.Object3D | null = null;
  private hop: { from: THREE.Vector3; to: THREE.Vector3; t0: number } | null = null;
  private lastRobber: THREE.Vector3 | null = null;
  private owned: { dispose(): void }[] = [];
  /** invisible, raycastable hit shapes for the spots the player may tap right now */
  hits: THREE.Object3D[] = [];
  private c: PiecesCtx;

  constructor(c: PiecesCtx) { this.c = c; c.scene.add(this.group); }

  private clearGroup(): void {
    for (const o of [...this.group.children]) this.group.remove(o);
    for (const d of this.owned) d.dispose();
    this.owned = []; this.pops = []; this.pulses = []; this.smokers = []; this.hits = []; this.robber = null;
  }

  dispose(): void { this.clearGroup(); this.c.scene.remove(this.group); }

  /** What kind of spot (and which one) a raycast hit. */
  static hitOf(o: THREE.Object3D): Hit | null { const d = o.userData as Partial<Hit>; return d.kind && d.id !== undefined ? { kind: d.kind, id: d.id } : null; }

  set(view: GameView, targets: BoardTargets, now = Date.now()): void {
    this.clearGroup();
    const { kit, style, light, pal, topo } = this.c;
    const glowing = new Set<THREE.Material>();
    const mat = (color: THREE.Color | string, o: { rough?: number; opacity?: number; glow?: boolean } = {}): THREE.MeshStandardMaterial => {
      const emissive = o.glow ? new THREE.Color(color).multiplyScalar(PIECE_GLOW) : new THREE.Color(0);
      const m = new THREE.MeshStandardMaterial({ color, emissive, roughness: o.rough ?? 0.6, flatShading: style.flat, ...(o.opacity !== undefined ? { transparent: true, opacity: o.opacity, depthWrite: false } : {}) });
      this.owned.push(m);
      if (o.glow) glowing.add(m);
      return m;
    };
    const windowMat = new THREE.MeshBasicMaterial({ color: light.windows > 0.3 ? '#ffd98a' : '#31465a' });
    const smokeMat = new THREE.MeshBasicMaterial({ color: light.windows > 0.3 ? '#8d97ad' : '#f1f1f1', transparent: true, opacity: 0.5, depthWrite: false });
    const blobMat = kit.blob(0.5);
    this.owned.push(windowMat, smokeMat);
    const idx = (pid: string): number => Math.max(0, view.player_order.indexOf(pid));
    const colorOf = (pid: string): THREE.Color => scaleSat(pal.players[idx(pid) % pal.players.length]!, 1);
    const k = (style.propScale > 1.2 ? 1.2 : 1) * 1.75;
    // A dark shell behind each player part (inverted hull) outlines it against the board.
    const outline = new THREE.MeshBasicMaterial({ color: '#111318', side: THREE.BackSide });
    this.owned.push(outline);

    const part = (parent: THREE.Object3D, geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number, shadow = true): THREE.Mesh => {
      const me = new THREE.Mesh(geo, m);
      me.position.set(x, y, z); me.scale.set(sx, sy, sz);
      me.castShadow = shadow && style.shadows;
      parent.add(me);
      if (glowing.has(m)) {
        const hull = new THREE.Mesh(geo, outline), e = 0.035; // child of the part, so it follows its rotation and pop
        hull.scale.set((sx + e) / sx, (sy + e) / sy, (sz + e) / sz); hull.position.y = -e / 2 / sy;
        me.add(hull);
      }
      return me;
    };

    const building = (type: string, color: THREE.Color, ghost: boolean): THREE.Group => {
      const g = new THREE.Group();
      const solid = ghost ? { opacity: 0.55 } : { glow: true };
      const body = mat(color, solid), roof = mat(tint(color, 0, 0, -0.18), solid);
      if (type === 'city') {
        part(g, kit.geo.cyl4, body, -0.05 * k, 0, 0, 0.3 * k, 0.17 * k, 0.2 * k);
        part(g, kit.geo.pyramid, roof, -0.05 * k, 0.17 * k, 0, 0.32 * k, 0.12 * k, 0.24 * k);
        part(g, kit.geo.cyl4, mat(tint(color, 0, 0, 0.04), solid), 0.12 * k, 0, 0, 0.13 * k, 0.3 * k, 0.13 * k);
        part(g, kit.geo.pyramid, roof, 0.12 * k, 0.3 * k, 0, 0.16 * k, 0.12 * k, 0.16 * k);
        if (!ghost) {
          part(g, kit.geo.box, windowMat, -0.05 * k, 0.07 * k, 0.1 * k, 0.05 * k, 0.05 * k, 0.012, false);
          part(g, kit.geo.box, windowMat, 0.12 * k, 0.18 * k, 0.067 * k, 0.04 * k, 0.05 * k, 0.012, false);
        }
      } else {
        part(g, kit.geo.cyl4, body, 0, 0, 0, 0.2 * k, 0.12 * k, 0.2 * k);
        part(g, kit.geo.pyramid, roof, 0, 0.12 * k, 0, 0.25 * k, 0.12 * k, 0.25 * k);
        if (!ghost) part(g, kit.geo.box, windowMat, 0, 0.05 * k, 0.101 * k, 0.05 * k, 0.045 * k, 0.012, false);
      }
      return g;
    };

    const addBlob = (x: number, y: number, z: number, rx: number, rz: number): void => {
      if (style.flat) return;
      const b = new THREE.Mesh(kit.geo.blob, blobMat);
      b.position.set(x, y + 0.008, z); b.scale.set(rx, 1, rz); b.renderOrder = 1;
      this.group.add(b);
    };

    // ------------------------------------------------ settlements and cities
    const freshI = targets.fresh?.i, freshE = targets.fresh?.e;
    for (const [iid, b] of Object.entries(view.board.buildings.i)) {
      const id = Number(iid), p = this.c.interPoint(id);
      const g = building(b.type, colorOf(b.player), false);
      g.position.copy(p); g.rotation.y = (id % 4) * 0.4;
      this.group.add(g);
      addBlob(p.x, p.y, p.z, (b.type === 'city' ? 0.34 : 0.22) * k, (b.type === 'city' ? 0.26 : 0.22) * k);
      const born = freshI?.get(id);
      if (born !== undefined && now - born < POP_MS) this.pops.push({ obj: g, born });
      const sm = new THREE.Mesh(kit.geo.sphere, smokeMat);
      sm.castShadow = false; this.group.add(sm);
      this.smokers.push({ mesh: sm, x: p.x + (b.type === 'city' ? 0.12 : 0.05) * k, y: p.y + (b.type === 'city' ? 0.46 : 0.3) * k, z: p.z, i: this.smokers.length });
    }

    // ------------------------------------------------ roads
    const road = (a: THREE.Vector3, c: THREE.Vector3, m: THREE.Material): THREE.Mesh => {
      const len = Math.hypot(c.x - a.x, c.z - a.z) * 0.8;
      const me = part(this.group, kit.geo.box, m, (a.x + c.x) / 2, Math.max(a.y, c.y) - 0.005, (a.z + c.z) / 2, len, 0.1, 0.2);
      me.rotation.y = -Math.atan2(c.z - a.z, c.x - a.x);
      return me;
    };
    for (const [eid, b] of Object.entries(view.board.buildings.e)) {
      const id = Number(eid), e = topo.edges[id]!;
      const me = road(this.c.interPoint(e.a), this.c.interPoint(e.b), mat(colorOf(b.player), { rough: 0.7, glow: true }));
      const born = freshE?.get(id);
      if (born !== undefined && now - born < POP_MS) this.pops.push({ obj: me, born });
    }

    // ------------------------------------------------ robber
    if (view.board.robber_hex !== null) {
      const hp = this.c.hexPoint(view.board.robber_hex), chip = this.c.hasChip(view.board.robber_hex);
      const m = mat('#1c1d22', { rough: 0.45 });
      const g = new THREE.Group();
      part(g, new THREE.CylinderGeometry(0.1, 0.12, 0.05, 12), m, 0, 0.025, 0, 1, 1, 1);
      part(g, new THREE.ConeGeometry(0.1, 0.34, 12), m, 0, 0.2, 0, 1, 1, 1);
      part(g, new THREE.SphereGeometry(0.075, 12, 10), m, 0, 0.43, 0, 1, 1, 1);
      this.owned.push(...g.children.map((c) => (c as THREE.Mesh).geometry));
      const to = new THREE.Vector3(hp.x + (chip ? 0.33 : 0), hp.y, hp.z + (chip ? 0.2 : 0));
      g.position.copy(to);
      this.group.add(g);
      addBlob(to.x, to.y, to.z, 0.16, 0.16);
      // a redraw mid-hop keeps the same flight; a new destination starts a new one
      if (!(this.hop && this.hop.to.equals(to)) && this.lastRobber && !this.lastRobber.equals(to)) this.hop = { from: this.lastRobber.clone(), to, t0: now };
      this.robber = g;
      this.lastRobber = to;
    }

    // ------------------------------------------------ tap targets and ghost
    const glow = new THREE.MeshBasicMaterial({ color: '#fff3b0', transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, fog: false });
    const hitMat = new THREE.MeshBasicMaterial({ visible: false });
    const ringGeo = new THREE.RingGeometry(0.11, 0.2, 28).rotateX(-Math.PI / 2);
    const dotGeo = new THREE.CircleGeometry(0.075, 20).rotateX(-Math.PI / 2);
    const hexRing = new THREE.RingGeometry(0.5, 0.64, 40).rotateX(-Math.PI / 2);
    const hitSphere = new THREE.CylinderGeometry(0.36, 0.36, 0.6, 10);
    const hitHex = new THREE.CylinderGeometry(0.85, 0.85, 0.6, 6);
    this.owned.push(glow, hitMat, ringGeo, dotGeo, hexRing, hitSphere, hitHex);
    const markMat = (): THREE.MeshBasicMaterial => { const m = glow.clone(); this.owned.push(m); this.pulses.push({ mat: m, base: 0.9 }); return m; };
    const hit = (geo: THREE.BufferGeometry, kind: Hit['kind'], id: number, p: THREE.Vector3): THREE.Mesh => {
      const me = new THREE.Mesh(geo, hitMat);
      me.position.copy(p); me.userData = { kind, id };
      this.group.add(me); this.hits.push(me);
      return me;
    };
    const flat = (geo: THREE.BufferGeometry, p: THREE.Vector3, y = 0.06): THREE.Mesh => {
      const me = new THREE.Mesh(geo, markMat());
      me.position.set(p.x, p.y + y, p.z); me.renderOrder = 20;
      this.group.add(me);
      return me;
    };
    for (const id of targets.i ?? []) {
      const p = this.c.interPoint(id);
      flat(ringGeo, p); flat(dotGeo, p);
      hit(hitSphere, 'i', id, p.clone().setY(p.y + 0.2));
    }
    for (const id of targets.e ?? []) {
      const e = topo.edges[id]!, a = this.c.interPoint(e.a), b = this.c.interPoint(e.b), mid = this.c.edgePoint(id);
      const len = Math.hypot(b.x - a.x, b.z - a.z), yaw = -Math.atan2(b.z - a.z, b.x - a.x);
      const bar = new THREE.Mesh(kit.geo.box, markMat());
      bar.position.set(mid.x, mid.y + 0.04, mid.z); bar.scale.set(len * 0.62, 0.05, 0.1); bar.rotation.y = yaw; bar.renderOrder = 20;
      this.group.add(bar);
      const hb = hit(kit.geo.box, 'e', id, mid.clone().setY(mid.y + 0.1));
      hb.scale.set(len * 0.8, 0.4, 0.42); hb.rotation.y = yaw;
    }
    for (const id of targets.h ?? []) {
      const p = this.c.hexPoint(id);
      flat(hexRing, p, 0.35);
      hit(hitHex, 'h', id, p.clone().setY(p.y + 0.3));
    }
    const gh = targets.ghost;
    if (gh?.kind === 'i') {
      const g = building(gh.type ?? 'settlement', colorOf(gh.player), true), p = this.c.interPoint(gh.id);
      g.position.copy(p); g.rotation.y = (gh.id % 4) * 0.4; this.group.add(g);
    } else if (gh?.kind === 'e') {
      const e = topo.edges[gh.id]!;
      road(this.c.interPoint(e.a), this.c.interPoint(e.b), mat(colorOf(gh.player), { opacity: 0.55 }));
    } else if (gh?.kind === 'h') {
      flat(hexRing, this.c.hexPoint(gh.id), 0.4).scale.setScalar(1.25);
    }
    this.tick(0, now);
  }

  /** Per-frame motion: pop-in of new pieces, robber hop, pulsing tap targets, chimney smoke. */
  tick(t: number, now = Date.now()): void {
    for (const p of this.pops) {
      const u = Math.min(1, Math.max(0, (now - p.born) / POP_MS));
      p.obj.scale.setScalar(u >= 1 ? 1 : Math.max(0.001, easeOutBack(u)));
    }
    this.pops = this.pops.filter((p) => now - p.born < POP_MS);
    const hop = this.hop;
    if (hop && this.robber) {
      const u = Math.min(1, (now - hop.t0) / 650), e = u * u * (3 - 2 * u);
      this.robber.position.lerpVectors(hop.from, hop.to, e);
      this.robber.position.y += Math.sin(u * Math.PI) * 0.45;
      if (u >= 1) this.hop = null;
    }
    const pulse = 0.65 + 0.35 * Math.sin(t * 4.2);
    for (const p of this.pulses) p.mat.opacity = p.base * pulse;
    for (const s of this.smokers) {
      const u = (t * 0.35 + s.i * 0.37) % 1, sc = 0.03 + u * 0.07;
      s.mesh.position.set(s.x + Math.sin(t + s.i) * 0.03 + u * 0.12, s.y + u * 0.32, s.z);
      s.mesh.scale.setScalar(sc);
    }
  }
}
