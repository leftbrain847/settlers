// Visual presets for the 3D board. A style decides how things are built; a light decides time of day; a palette
// (the same four themes as the 2D board) decides colors.
import { THEMES } from '../theme.ts';

export type StyleId = 'civ' | 'realistic' | 'tabletop';
export type LightId = 'day' | 'dusk' | 'night';

export interface StylePreset {
  id: StyleId; label: string;
  flat: boolean;            // faceted low-poly shading
  shadows: boolean;
  relief: number;           // height of terrain undulation on tile tops
  topDetail: number;        // subdivisions of a tile top (more = smoother relief)
  lip: number;              // how much narrower the painted top is than the tile side
  propDensity: number;      // 0..1.5
  propScale: number;        // chunkier figurines for the tabletop look
  saturation: number;       // multiplies palette saturation
  jitter: number;           // per-tile color variation
  tray: boolean;            // wooden tray around the board
  felt: boolean;            // matte cloth sea instead of water
  tone: 'none' | 'aces';
  post: boolean;            // grade, vignette and tilt-shift through an HDR render target
}

export const STYLES: Record<StyleId, StylePreset> = {
  civ: { id: 'civ', label: 'Civ', flat: true, shadows: false, relief: 0, topDetail: 1, lip: 0.94, propDensity: 1, propScale: 1, saturation: 1.12, jitter: 0.03, tray: false, felt: false, tone: 'none', post: false },
  realistic: { id: 'realistic', label: 'Realistic', flat: false, shadows: true, relief: 0.07, topDetail: 5, lip: 1, propDensity: 1.4, propScale: 0.9, saturation: 0.82, jitter: 0.07, tray: false, felt: false, tone: 'aces', post: true },
  tabletop: { id: 'tabletop', label: 'Tabletop', flat: true, shadows: true, relief: 0, topDetail: 1, lip: 0.9, propDensity: 0.7, propScale: 1.45, saturation: 1.0, jitter: 0.02, tray: true, felt: true, tone: 'aces', post: false },
};

export interface LightPreset {
  id: LightId; label: string;
  sky: string; fog: string;
  /** fog starts/ends at these multiples of the camera distance, so it never veils the board itself */
  fogNear: number; fogFar: number;
  hemiSky: string; hemiGround: string; hemi: number;
  sun: string; sunPower: number; sunPos: [number, number, number];
  exposure: number; windows: number;
  /** multiplies the number chips and port badges (they are unlit, so they must be dimmed by hand at night) */
  chipTint: string;
  /** the sea is unlit (it mirrors the sky): this tints it for the time of day */
  waterTint: string;
}

export const LIGHTS: Record<LightId, LightPreset> = {
  day: { id: 'day', label: 'Day', sky: '#a9d6ee', fog: '#bfe0f0', fogNear: 1.05, fogFar: 3.2, hemiSky: '#ffffff', hemiGround: '#7d8a63', hemi: 1.15, sun: '#fff1d0', sunPower: 2.6, sunPos: [-6, 11, 7], exposure: 1.0, windows: 0, chipTint: '#ffffff', waterTint: '#ffffff' },
  dusk: { id: 'dusk', label: 'Dusk', sky: '#f0b48a', fog: '#e7a07c', fogNear: 1.2, fogFar: 3.0, hemiSky: '#ffe0c0', hemiGround: '#6a5580', hemi: 1.25, sun: '#ff9a48', sunPower: 2.6, sunPos: [-9, 4.2, 3], exposure: 1.05, windows: 0.5, chipTint: '#ffe6cc', waterTint: '#f0b8cc' },
  night: { id: 'night', label: 'Night', sky: '#0a1226', fog: '#0c1630', fogNear: 1.1, fogFar: 3.0, hemiSky: '#6a88cc', hemiGround: '#141c38', hemi: 1.35, sun: '#a9c0ff', sunPower: 1.9, sunPos: [6, 9, -5], exposure: 1.25, windows: 1, chipTint: '#aebbd8', waterTint: '#6d86c8' },
};

/** How bright the board (terrain, props, sea) is next to the player pieces, in every style and light. */
export const BACKDROP_DIM = 0.5;
/** Self-glow on player pieces, as a share of their colour, so dimming the backdrop does not dim them. */
export const PIECE_GLOW = 0.6;

export type PaletteId = 'natural' | 'ocean' | 'nord' | 'pastel' | 'night';

export interface Palette {
  terrain: Record<string, string>; players: string[]; sea: string; shore: string; deep: string;
  /** natural colors for what grows on the tiles, whatever the tile ground color is */
  foliage: string; grass: string; wheat: string;
}

type Extras = Pick<Palette, 'sea' | 'shore' | 'deep' | 'foliage' | 'grass' | 'wheat'>;
const EXTRAS: Record<Exclude<PaletteId, 'natural'>, Extras> = {
  ocean: { sea: '#2f9fc0', shore: '#7fdcd3', deep: '#16688f', foliage: '#3f8a45', grass: '#6fbf6a', wheat: '#e0b840' },
  nord: { sea: '#6f93ad', shore: '#b6d0dc', deep: '#456a86', foliage: '#5f8f62', grass: '#9cc08a', wheat: '#e6c46a' },
  pastel: { sea: '#6fb3cf', shore: '#b9e6e0', deep: '#4a8fb0', foliage: '#6cbf6a', grass: '#a3d99a', wheat: '#f2d964' },
  night: { sea: '#14335c', shore: '#2a5f8f', deep: '#0b1d3a', foliage: '#2c6a3e', grass: '#4d8a52', wheat: '#c9a23c' },
};

/** Earth tones for the 3D board: it reads as a landscape rather than a theme. */
const NATURAL: Palette = {
  terrain: { hills: '#b8643f', forest: '#557f3c', mountains: '#8c9196', fields: '#cfae52', pasture: '#8fbf5e', desert: '#e3cb8f' },
  players: ['#d94b4b', '#3b7dd8', '#f2f2f2', '#f0a030', '#8e5bd6', '#2fb58a'],
  sea: '#2f86b3', shore: '#8fe0d6', deep: '#154c78', foliage: '#3f7f3d', grass: '#79b04e', wheat: '#e0b840',
};

export function paletteOf(id: PaletteId): Palette {
  if (id === 'natural') return NATURAL;
  const t = THEMES[id];
  return { terrain: t.terrain, players: t.players, ...EXTRAS[id] };
}

export const PALETTE_IDS: PaletteId[] = ['natural', 'ocean', 'nord', 'pastel', 'night'];
