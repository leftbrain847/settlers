import { sv, clear } from './dom.ts';
import { icon, resIcon } from './icons.ts';
import { topology } from '../engine/topology.ts';
import type { Topology } from '../engine/topology.ts';
import type { GameConfig, GameView } from '../engine/types.ts';
import type { BoardRenderer, BoardTargets, Kind } from './ui-types.ts';

const S = 40; // world units per hex edge
const SQ3 = Math.sqrt(3);
const px = (q: number, r: number): { x: number; y: number } => ({ x: S * (SQ3 * q + (SQ3 / 2) * r), y: S * 1.5 * r });
const PIPS: Record<number, number> = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };

interface ViewBox { x: number; y: number; w: number; h: number }
interface Pt { x: number; y: number }
interface Drag { moved: boolean; sx: number; sy: number; target: EventTarget | null; pinch: number | null }
export interface BoardTap { kind: Kind; id: number }

const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The Pastel mountain tile: layered sky, back range, front range and snow caps, clipped to the hex. */
function mountainScene(c: Pt, clipId: string): SVGElement {
  const poly = (pts: [number, number][], fill: string): SVGElement => sv('polygon', { points: pts.map(([dx, dy]) => `${c.x + dx * S},${c.y + dy * S}`).join(' '), fill });
  return sv('g', { 'clip-path': `url(#${clipId})`, class: 'scene' },
    sv('rect', { x: c.x - S, y: c.y - S * 1.2, width: S * 2, height: S * 2.4, fill: '#C8E0F0' }),
    poly([[-0.87, 0.7], [-0.5, -0.52], [-0.15, 0.04], [0.2, -0.65], [0.55, -0.25], [0.87, 0.7]], '#BDD2DC'),
    poly([[-0.87, 1.1], [-0.87, 0.1], [-0.4, -0.4], [0, 0.15], [0.32, -0.5], [0.72, -0.1], [0.87, 0.2], [0.87, 1.1]], '#7A8E98'),
    poly([[-0.64, -0.36], [-0.5, -0.52], [-0.36, -0.36]], '#E8F0F4'), poly([[0.07, -0.49], [0.2, -0.65], [0.34, -0.49]], '#E8F0F4'),
    poly([[-0.54, -0.26], [-0.4, -0.4], [-0.26, -0.26]], '#F2F6F8'), poly([[0.18, -0.36], [0.32, -0.5], [0.46, -0.36]], '#F2F6F8'));
}

/**
 * Renders the board from a view and turns taps/drags into onTap({kind:'i'|'e'|'h', id}).
 * Pan = one finger drag, zoom = pinch or wheel. Hit targets are generous (~36px) and only exist
 * for currently legal spots, so a stray tap can never place anything.
 */
export class BoardView implements BoardRenderer {
  svg: SVGSVGElement;
  get el(): SVGSVGElement { return this.svg; }
  destroy(): void { /* nothing to release */ }
  onTap: (t: BoardTap) => void;
  vb: ViewBox | null;
  full: ViewBox | null;
  key: string | null;
  pointers: Map<number, Pt>;
  drag: Drag | null;
  private geo: { topo: Topology; pos: Pt[]; hexes: GameView['board']['hexes'] } | null = null;
  private lastRobber: Pt | null = null;

  constructor(svg: SVGSVGElement, { onTap }: { onTap: (t: BoardTap) => void }) {
    this.svg = svg;
    this.onTap = onTap;
    this.vb = null;
    this.full = null;
    this.key = null;
    this.pointers = new Map();
    this.drag = null;
    this.bindGestures();
  }

  fit(topo: Topology): void {
    const pts = topo.intersections.map((i) => px(i.q, i.r));
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const pad = S * 1.3;
    const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad;
    this.full = { x: x0, y: y0, w: Math.max(...xs) + pad - x0, h: Math.max(...ys) + pad - y0 };
    this.vb = { ...this.full };
    this.applyVb();
  }

  applyVb(): void {
    if (!this.vb) return;
    const { x, y, w, h: hh } = this.vb;
    this.svg.setAttribute('viewBox', `${x} ${y} ${w} ${hh}`);
  }

  resetZoom(): void {
    if (!this.full) return;
    this.vb = { ...this.full };
    this.applyVb();
  }

  update(view: GameView, cfg: GameConfig, targets: BoardTargets = {}): void {
    const topo = topology(view.board.rings);
    const key = `${view.game_id}:${view.board.rings}`;
    if (this.key !== key) { this.key = key; this.fit(topo); }
    clear(this.svg);

    const pos = topo.intersections.map((i) => px(i.q, i.r));
    const idx = (pid: string): number => Math.max(0, view.player_order.indexOf(pid));
    const g = (cls: string): SVGElement => sv('g', { class: cls });
    const small = view.board.rings > 5;
    const edgeLine = (eid: number): { x1: number; y1: number; x2: number; y2: number } => {
      const e = topo.edges[eid];
      return { x1: pos[e.a].x, y1: pos[e.a].y, x2: pos[e.b].x, y2: pos[e.b].y };
    };
    const hexPoints = (hid: number): string => topo.hexIntersections[hid].map((i) => `${pos[i].x},${pos[i].y}`).join(' ');

    this.geo = { topo, pos, hexes: view.board.hexes };
    const defs = sv('defs');
    const hexLayer = g('hexes');
    for (const hx of view.board.hexes) {
      const c = px(hx.q, hx.r);
      hexLayer.append(sv('polygon', { points: hexPoints(hx.id), class: 'hex', style: { fill: `var(--t-${hx.terrain})` } }));
      const produces = cfg.terrain_types[hx.terrain]?.produces ?? null;
      if (targets.pictures && hx.terrain === 'mountains') {
        defs.append(sv('clipPath', { id: `clip-h${hx.id}` }, sv('polygon', { points: hexPoints(hx.id) })));
        hexLayer.append(mountainScene(c, `clip-h${hx.id}`));
      } else if (!small) {
        const ic = icon(resIcon(produces), 15, 'terrain-ico');
        ic.setAttribute('x', String(c.x - 7.5));
        ic.setAttribute('y', String(c.y - S * 0.7));
        hexLayer.append(ic);
      }
      if (hx.number_token) {
        const red = hx.number_token === 6 || hx.number_token === 8;
        hexLayer.append(
          sv('circle', { cx: c.x, cy: c.y, r: S * 0.36, class: 'token' }),
          sv('text', { x: c.x, y: c.y + 1, class: 'token-num' + (red ? ' red' : '') }, hx.number_token),
        );
        if (!small) {
          const n = PIPS[hx.number_token] ?? 0;
          for (let k = 0; k < n; k++) hexLayer.append(sv('circle', { cx: c.x + (k - (n - 1) / 2) * 4.2, cy: c.y + S * 0.26, r: 1.5, class: 'pip' + (red ? ' red' : '') }));
        }
      }
    }

    const portLayer = g('ports');
    for (const [a, b, type] of view.board.port_slots ?? []) {
      const m = { x: (pos[a].x + pos[b].x) / 2, y: (pos[a].y + pos[b].y) / 2 };
      const d = Math.hypot(m.x, m.y) || 1;
      const lab = { x: m.x + (m.x / d) * S * 0.62, y: m.y + (m.y / d) * S * 0.62 };
      const pt = cfg.port_types[type];
      const ratio = pt ? `${pt.ratio}:1` : '3:1';
      const badgeIcon = pt?.resource ? icon(resIcon(pt.resource), 10, 'port-ico') : null;
      if (badgeIcon) { badgeIcon.setAttribute('x', String(lab.x - 5)); badgeIcon.setAttribute('y', String(lab.y - 10.5)); badgeIcon.style.setProperty('color', `var(--r-${pt!.resource})`); }
      portLayer.append(
        sv('line', { x1: lab.x, y1: lab.y, x2: pos[a].x, y2: pos[a].y, class: 'port-line' }),
        sv('line', { x1: lab.x, y1: lab.y, x2: pos[b].x, y2: pos[b].y, class: 'port-line' }),
        sv('circle', { cx: lab.x, cy: lab.y, r: S * 0.34, class: 'port-badge', style: pt?.resource ? { stroke: `var(--r-${pt.resource})` } : {} }),
        ...(badgeIcon ? [badgeIcon] : []),
        sv('text', { x: lab.x, y: lab.y + (badgeIcon ? 6.2 : 0.5), class: 'port-text' }, ratio),
      );
    }

    const roadLayer = g('roads');
    for (const [eid, b] of Object.entries(view.board.buildings.e)) {
      const l = edgeLine(Number(eid));
      const born = targets.fresh?.e.get(Number(eid));
      const fresh = born !== undefined ? ' pop' : '';
      const resume: Record<string, string> = born !== undefined ? { animationDelay: `${-(Date.now() - born)}ms` } : {};
      roadLayer.append(sv('line', { ...l, class: 'road-edge' + fresh, style: resume }), sv('line', { ...l, class: 'road' + fresh, style: { stroke: `var(--p${idx(b.player)})`, ...resume } }));
    }

    const buildLayer = g('buildings');
    // `born` = when the piece appeared: a redraw mid-animation resumes it at the right moment instead of restarting or dropping it.
    const drawPiece = (player: string, p: Pt, type: string | undefined, ghost: boolean, born?: number): SVGElement => {
      const city = type === 'city';
      const s = city ? 1.35 : 1;
      const d = city
        ? `M${-9 * s * 0.75},${7} L${-9 * s * 0.75},${-3} L${-2},${-3} L${-2},${-8} L${3},${-12} L${8},${-8} L${8},${7} Z`
        : 'M-8,6 L-8,-2 L0,-9 L8,-2 L8,6 Z';
      return sv('g', { transform: `translate(${p.x},${p.y}) scale(1.25)`, class: 'piece' + (ghost ? ' ghost' : '') },
        sv('path', { d, class: 'piece-shape' + (born !== undefined ? ' pop' : ''), style: { fill: `var(--p${idx(player)})`, ...(born !== undefined ? { animationDelay: `${-(Date.now() - born)}ms` } : {}) } }));
    };
    for (const [iid, b] of Object.entries(view.board.buildings.i)) buildLayer.append(drawPiece(b.player, pos[Number(iid)], b.type, false, targets.fresh?.i.get(Number(iid))));

    const robberLayer = g('robber');
    if (view.board.robber_hex !== null) {
      const rh = view.board.hexes[view.board.robber_hex];
      const c = px(rh.q, rh.r);
      const to = { x: c.x + S * 0.38, y: c.y + S * 0.22 };
      const pawn = sv('g', { transform: `translate(${to.x},${to.y})` },
        sv('circle', { cx: 0, cy: -9, r: 4.5, class: 'robber' }), sv('path', { d: 'M-6,8 L-3.5,-4 L3.5,-4 L6,8 Z', class: 'robber' }));
      robberLayer.append(pawn);
      const from = this.lastRobber;
      if (from && (from.x !== to.x || from.y !== to.y) && typeof (pawn as unknown as { animate?: unknown }).animate === 'function' && !reducedMotion()) {
        pawn.animate([{ transform: `translate(${from.x}px, ${from.y}px)` }, { transform: `translate(${from.x}px, ${from.y - 14}px)`, offset: 0.25 }, { transform: `translate(${to.x}px, ${to.y - 14}px)`, offset: 0.75 }, { transform: `translate(${to.x}px, ${to.y}px)` }], { duration: 650, easing: 'ease-in-out' });
      }
      this.lastRobber = to;
    }

    const targetLayer = g('targets');
    for (const id of targets.h ?? []) {
      const hx = view.board.hexes[id];
      const c = px(hx.q, hx.r);
      targetLayer.append(sv('polygon', { points: hexPoints(id), class: 'target-hex', dataset: { kind: 'h', id } }), sv('circle', { cx: c.x, cy: c.y, r: S * 0.42, class: 'target-ring' }));
    }
    for (const id of targets.e ?? []) {
      const l = edgeLine(id);
      targetLayer.append(sv('line', { ...l, class: 'target-edge-vis' }), sv('line', { ...l, class: 'target-edge-hit', dataset: { kind: 'e', id } }));
    }
    for (const id of targets.i ?? []) {
      targetLayer.append(sv('circle', { cx: pos[id].x, cy: pos[id].y, r: 7, class: 'target-dot' }), sv('circle', { cx: pos[id].x, cy: pos[id].y, r: 18, class: 'target-hit', dataset: { kind: 'i', id } }));
    }
    const gh = targets.ghost;
    if (gh) {
      if (gh.kind === 'i') targetLayer.append(drawPiece(gh.player, pos[gh.id], gh.type, true));
      else if (gh.kind === 'e') {
        targetLayer.append(sv('line', { ...edgeLine(gh.id), class: 'road ghost', style: { stroke: `var(--p${idx(gh.player)})` } }));
      } else {
        targetLayer.append(sv('polygon', { points: hexPoints(gh.id), class: 'target-hex selected' }));
      }
    }

    this.svg.append(defs, hexLayer, portLayer, roadLayer, buildLayer, robberLayer, targetLayer);
  }

  /** Screen position of a hex centre / intersection / edge midpoint, for effects that fly between the board and the HUD. */
  clientPoint(kind: Kind, id: number): Pt | null {
    const geo = this.geo;
    const svg = this.svg as unknown as { getScreenCTM?: () => DOMMatrix | null; createSVGPoint?: () => DOMPoint };
    if (!geo || typeof svg.getScreenCTM !== 'function' || typeof svg.createSVGPoint !== 'function') return null;
    let w: Pt | undefined;
    if (kind === 'h') { const hx = geo.hexes[id]; w = hx ? px(hx.q, hx.r) : undefined; }
    else if (kind === 'i') w = geo.pos[id];
    else { const e = geo.topo.edges[id]; w = e ? { x: (geo.pos[e.a].x + geo.pos[e.b].x) / 2, y: (geo.pos[e.a].y + geo.pos[e.b].y) / 2 } : undefined; }
    const ctm = svg.getScreenCTM();
    if (!w || !ctm) return null;
    const p = svg.createSVGPoint();
    p.x = w.x; p.y = w.y;
    const out = p.matrixTransform(ctm);
    return { x: out.x, y: out.y };
  }

  // ---- gestures ----
  bindGestures(): void {
    const svg = this.svg;
    const rect = (): DOMRect => svg.getBoundingClientRect();
    const clamp = (vb: ViewBox, f: ViewBox): void => {
      vb.w = Math.min(Math.max(vb.w, f.w * 0.22), f.w * 1.25);
      vb.h = vb.w * (f.h / f.w);
    };
    const toWorld = (vb: ViewBox, cx: number, cy: number): Pt => {
      const r = rect();
      return { x: vb.x + ((cx - r.left) / (r.width || 1)) * vb.w, y: vb.y + ((cy - r.top) / (r.height || 1)) * vb.h };
    };
    const zoomAt = (cx: number, cy: number, factor: number): void => {
      const vb = this.vb, f = this.full;
      if (!vb || !f) return;
      const before = toWorld(vb, cx, cy);
      vb.w *= factor;
      clamp(vb, f);
      const r = rect();
      vb.x = before.x - ((cx - r.left) / (r.width || 1)) * vb.w;
      vb.y = before.y - ((cy - r.top) / (r.height || 1)) * vb.h;
      this.applyVb();
    };

    svg.addEventListener('pointerdown', (e: PointerEvent) => {
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { svg.setPointerCapture?.(e.pointerId); } catch { /* not capturable (synthetic event) */ }
      this.drag = { moved: false, sx: e.clientX, sy: e.clientY, target: e.target, pinch: this.pointers.size > 1 ? this.dist() : null };
    });
    svg.addEventListener('pointermove', (e: PointerEvent) => {
      const prev = this.pointers.get(e.pointerId);
      const vb = this.vb;
      if (!prev || !this.drag || !this.full || !vb) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (Math.hypot(e.clientX - this.drag.sx, e.clientY - this.drag.sy) > 8) this.drag.moved = true;
      if (!this.drag.moved) return;
      if (this.pointers.size >= 2) {
        const d = this.dist();
        if (this.drag.pinch) { const c = this.center(); zoomAt(c.x, c.y, this.drag.pinch / d); }
        this.drag.pinch = d;
      } else {
        const r = rect();
        vb.x -= ((e.clientX - prev.x) / (r.width || 1)) * vb.w;
        vb.y -= ((e.clientY - prev.y) / (r.height || 1)) * vb.h;
        this.applyVb();
      }
    });
    const end = (e: PointerEvent): void => {
      const d = this.drag;
      this.pointers.delete(e.pointerId);
      if (!d) return;
      if (!d.moved && e.type === 'pointerup') {
        // The SVG is rebuilt on every state update, so look up what is under the finger now.
        const under: Element | null | undefined = document.elementFromPoint?.(e.clientX, e.clientY);
        const find = (n: unknown): HTMLElement | SVGElement | null =>
          n instanceof Element ? (n.closest('[data-kind]') as HTMLElement | SVGElement | null) : null;
        const t = find(under) ?? find(e.target) ?? find(d.target);
        if (t) this.onTap({ kind: t.dataset.kind as Kind, id: Number(t.dataset.id) });
      }
      if (!this.pointers.size) this.drag = null;
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('wheel', (e: WheelEvent) => { e.preventDefault(); if (this.full) zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 1.12 : 1 / 1.12); }, { passive: false });
    svg.addEventListener('dblclick', () => this.resetZoom());
  }

  dist(): number {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y) || 1;
  }

  center(): Pt {
    const [a, b] = [...this.pointers.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
}
