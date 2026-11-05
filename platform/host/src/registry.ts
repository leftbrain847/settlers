import { configureHost, type HostOverrides } from './config';
import type { GameModule } from './gameModule';

/** Each module is typed by its own config/state/input/view; the host only ever passes them back to the same module. */
export type AnyApp = GameModule<unknown, unknown, unknown, unknown>;

export interface AppSite {
  /** The path this Worker serves, e.g. `/settlers`. Requests outside it are 404. Empty = the whole hostname. */
  basePath: string;
}

let REGISTRY: Readonly<Record<string, AnyApp>> = {};
let SITE: AppSite = { basePath: '' };

const ID = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * Called once at the top of an app's Worker entry, before anything is served.
 * Every app is its own Worker, so there is normally exactly one module here,
 * and the base path defaults to `/<its id>`.
 */
export function register(modules: readonly AnyApp[], site: Partial<AppSite> & { host?: HostOverrides } = {}): void {
  configureHost(site.host);
  const next: Record<string, AnyApp> = {};
  for (const m of modules) {
    if (!ID.test(m.id)) throw new Error(`app id must match ${ID}: ${m.id}`);
    if (Object.hasOwn(next, m.id)) throw new Error(`duplicate app id: ${m.id}`);
    next[m.id] = m;
  }
  REGISTRY = next;
  const only = modules.length === 1 ? modules[0] : undefined;
  const basePath = site.basePath ?? (only ? `/${only.id}` : '');
  if (basePath !== '' && !/^\/[a-z][a-z0-9-]{0,39}$/.test(basePath)) throw new Error(`basePath must look like /my-app: ${basePath}`);
  SITE = { basePath };
}

export function gameById(id: string): AnyApp | null {
  return Object.hasOwn(REGISTRY, id) ? (REGISTRY[id] ?? null) : null;
}

export function site(): AppSite {
  return SITE;
}
