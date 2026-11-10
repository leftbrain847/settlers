// Piece visibility rules: player pieces must stand out from everything behind them, in every theme and board view.
// Colours are compared in OKLab (perceptual: a distance of 0.02 is barely visible, 0.1 is obvious), after applying the
// same dimming the board applies to its backdrop. tests/unit/contrast.test.ts holds every palette to these numbers.
import { BACKDROP_DIM } from './board3d/style.ts';

/** Minimum OKLab distance between a player colour and any backdrop colour (terrain, props, sea). */
export const MIN_PIECE_VS_BACKDROP = 0.15;
/** Minimum OKLab distance between any two player colours. */
export const MIN_PIECE_VS_PIECE = 0.15;
/** The flat board's terrain filter (style.css `.hexes > .hex`): kept here so the rule and the CSS agree. */
export const FLAT_TERRAIN_FILTER = { saturate: 0.55, brightness: 0.7 } as const;

type RGB = [number, number, number];
const hexRgb = (hex: string): RGB => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255) as RGB;
};
const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** sRGB (0..1) to OKLab. */
export function oklab(rgb: RGB): RGB {
  const [r, g, b] = rgb.map(toLinear) as RGB;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

export function distance(a: string | RGB, b: string | RGB): number {
  const [x, y] = [a, b].map((c) => oklab(typeof c === 'string' ? hexRgb(c) : c));
  return Math.hypot(x![0] - y![0], x![1] - y![1], x![2] - y![2]);
}

/** What a terrain colour looks like on the flat board: CSS saturate() then brightness(), per the Filter Effects spec. */
export function flatBackdrop(hex: string): RGB {
  const [r, g, b] = hexRgb(hex), s = FLAT_TERRAIN_FILTER.saturate, k = FLAT_TERRAIN_FILTER.brightness;
  const sat: RGB = [
    (0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * b,
    (0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * b,
    (0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * b,
  ];
  return sat.map((v) => clamp01(v * k)) as RGB;
}

/** Roughly what a backdrop colour looks like on the 3D board: its light scaled by BACKDROP_DIM (in linear light). */
export function litBackdrop(hex: string): RGB {
  return hexRgb(hex).map((c) => { const v = toLinear(c) * BACKDROP_DIM; return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055; }) as RGB;
}

export interface Violation { palette: string; piece: string; against: string; what: string; distance: number; min: number }

/** Every pair in one palette that breaks a rule. `backdrop` maps a label (e.g. "hills") to how it looks on the board. */
export function check(palette: string, players: string[], backdrop: Record<string, RGB>): Violation[] {
  const out: Violation[] = [];
  for (const p of players) {
    for (const [what, c] of Object.entries(backdrop)) {
      const d = distance(p, c);
      if (d < MIN_PIECE_VS_BACKDROP) out.push({ palette, piece: p, against: what, what: 'backdrop', distance: d, min: MIN_PIECE_VS_BACKDROP });
    }
  }
  players.forEach((a, i) => players.slice(i + 1).forEach((b) => {
    const d = distance(a, b);
    if (d < MIN_PIECE_VS_PIECE) out.push({ palette, piece: a, against: b, what: 'piece', distance: d, min: MIN_PIECE_VS_PIECE });
  }));
  return out;
}
