// Palettes carried over from the desktop UI: Sand, Nordic, Night, Pastel. Player colours are shared by every theme so
// pieces always stand out (client/contrast.ts holds the rules; tests/unit/contrast.test.ts checks every theme).
import { PLAYER_COLORS } from '../engine/state.ts';
export interface Theme {
  label: string;
  vars: Record<string, string>;
  terrain: Record<string, string>;
  players: string[];
  resources: Record<string, string>;
}

const chrome: Record<string, string> = {
  '--bg': '#141a2e', '--panel': '#1b2440', '--card': '#243157', '--text': '#e8ecf4',
  '--dim': '#93a0ba', '--border': '#33416b',
};

export const THEMES: Record<string, Theme> = {
  natural: {
    label: 'Natural',
    vars: { ...chrome, '--accent': '#d9822b', '--accent2': '#e0b840', '--good': '#79b04e', '--sea': '#2f86b3', '--sea2': '#154c78' },
    terrain: { hills: '#b8643f', forest: '#557f3c', mountains: '#8c9196', fields: '#cfae52', pasture: '#8fbf5e', desert: '#e3cb8f' },
    players: PLAYER_COLORS,
    resources: { clay: '#b8643f', wood: '#557f3c', rock: '#8c9196', wheat: '#cfae52', sheep: '#8fbf5e' },
  },
  ocean: {
    label: 'Sand',
    vars: { ...chrome, '--accent': '#00b4d8', '--accent2': '#f4a261', '--good': '#06d6a0', '--sea': '#5bb8d4', '--sea2': '#3aa8c5' },
    terrain: { hills: '#C8693F', forest: '#8B6842', mountains: '#7A8E99', fields: '#D8C4A0', pasture: '#20B2AA', desert: '#FFF0D0' },
    players: PLAYER_COLORS,
    resources: { clay: '#C8693F', wood: '#8B6842', rock: '#7A8E99', wheat: '#D8C4A0', sheep: '#20B2AA' },
  },
  nord: {
    label: 'Nordic',
    vars: { ...chrome, '--accent': '#bf616a', '--accent2': '#ebcb8b', '--good': '#a3be8c', '--sea': '#b8cad8', '--sea2': '#a0b8c8' },
    terrain: { hills: '#BF616A', forest: '#A3BE8C', mountains: '#81A1C1', fields: '#EBCB8B', pasture: '#8FBCBB', desert: '#D8DEE9' },
    players: PLAYER_COLORS,
    resources: { clay: '#BF616A', wood: '#A3BE8C', rock: '#81A1C1', wheat: '#EBCB8B', sheep: '#8FBCBB' },
  },
  night: {
    label: 'Night',
    vars: { '--bg': '#0a0e18', '--panel': '#111827', '--card': '#1a2338', '--text': '#dfe6f3', '--dim': '#8190ab', '--border': '#26324d',
      '--accent': '#7aa2f7', '--accent2': '#e0af68', '--good': '#9ece6a', '--sea': '#12213b', '--sea2': '#0a1528' },
    terrain: { hills: '#a4503f', forest: '#2f6d48', mountains: '#5f6e7e', fields: '#b39b42', pasture: '#3d8f7c', desert: '#a79b78' },
    players: PLAYER_COLORS,
    resources: { clay: '#c8624f', wood: '#3f8f5e', rock: '#7d8ea0', wheat: '#d4b94e', sheep: '#4fb39c' },
  },
  pastel: {
    label: 'Pastel',
    vars: { ...chrome, '--accent': '#e8956d', '--accent2': '#f0c878', '--good': '#88c890', '--sea': '#98c8dc', '--sea2': '#80b8d0' },
    terrain: { hills: '#E8A890', forest: '#80D868', mountains: '#B8C4CC', fields: '#F8E860', pasture: '#A8D8A0', desert: '#F0E0B8' },
    players: PLAYER_COLORS,
    resources: { clay: '#E8A890', wood: '#80D868', rock: '#B8C4CC', wheat: '#F8E860', sheep: '#A8D8A0' },
  },
};

export function applyTheme(name: string, root: HTMLElement = document.documentElement): string {
  const t = THEMES[name] ?? THEMES.ocean;
  const set = (k: string, v: string): void => root.style.setProperty(k, v);
  for (const [k, v] of Object.entries(t.vars)) set(k, v);
  for (const [k, v] of Object.entries(t.terrain)) set(`--t-${k}`, v);
  t.players.forEach((c, i) => set(`--p${i}`, c));
  for (const [k, v] of Object.entries(t.resources)) set(`--r-${k}`, v);
  return name in THEMES ? name : 'ocean';
}
