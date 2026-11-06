import { configureTurn, type TurnOverrides } from './config.ts';
import type { ErasedGame } from './game.ts';

let GAMES: Readonly<Record<string, ErasedGame>> = {};
let DEFAULT_ID = '';
let BASE_PATH = '';

const ID = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * Called once at the top of an invite-mode app's Worker entry, before anything
 * is served. The first game is the default; the base path defaults to `/<its id>`.
 */
export function registerTurn(games: readonly ErasedGame[], site: { basePath?: string; host?: TurnOverrides } = {}): void {
  if (games.length === 0) throw new Error('registerTurn needs at least one game');
  configureTurn(site.host);
  const next: Record<string, ErasedGame> = {};
  for (const g of games) {
    if (!ID.test(g.id)) throw new Error(`game id must match ${ID}: ${g.id}`);
    if (Object.hasOwn(next, g.id)) throw new Error(`duplicate game id: ${g.id}`);
    next[g.id] = g;
  }
  const basePath = site.basePath ?? `/${games[0]!.id}`;
  if (basePath !== '' && !/^\/[a-z][a-z0-9-]{0,39}$/.test(basePath)) throw new Error(`basePath must look like /my-app: ${basePath}`);
  GAMES = next;
  DEFAULT_ID = games[0]!.id;
  BASE_PATH = basePath;
}

export function turnGame(id: unknown): ErasedGame | null {
  return typeof id === 'string' && Object.hasOwn(GAMES, id) ? (GAMES[id] ?? null) : null;
}

export const defaultTurnGame = (): string => DEFAULT_ID;
export const turnBasePath = (): string => BASE_PATH;
