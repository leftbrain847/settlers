/**
 * The browser side of the platform: the solo-run and scores API, and a room
 * connection that reconnects on its own, sends inputs only when they change,
 * and buffers views for interpolation. Same-origin only: the Access cookie
 * rides along automatically and nothing else is contacted.
 */
import type { ClientMessage, ScoresResponse, ServerMessage, SoloSegmentResponse, SoloStartResponse, UsageResponse } from '@app-builder/host/protocol';

export type { ScoresResponse, SoloSegmentResponse, SoloStartResponse, UsageResponse } from '@app-builder/host/protocol';

export interface ClientConfig {
  /** The app's path on the shared hostname, e.g. `/settlers` (no trailing slash). The template sets it from Vite's base. */
  basePath: string;
  /** API calls give up after this long, in ms. */
  requestTimeoutMs: number;
  reconnect: { baseMs: number; factor: number; maxMs: number };
  /** Views are drawn this far behind the newest one, so there is always a pair to blend between, in ms. */
  interpolationDelayMs: number;
  /** Views kept for interpolation. */
  bufferSize: number;
}

export const CLIENT_CONFIG: ClientConfig = {
  basePath: '',
  requestTimeoutMs: 8000,
  reconnect: { baseMs: 500, factor: 2, maxMs: 15_000 },
  interpolationDelayMs: 100,
  bufferSize: 8,
};

async function call<T>(path: string, init: RequestInit, cfg: ClientConfig): Promise<T | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.requestTimeoutMs);
  try {
    const res = await fetch(`${cfg.basePath}${path}`, { ...init, signal: ctl.signal, credentials: 'same-origin', cache: 'no-store' });
    const type = res.headers.get('Content-Type') ?? '';
    if (!type.includes('application/json')) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const enc = encodeURIComponent;

/** Set once at startup, e.g. `configureClient({ basePath: '/settlers' })`. */
export function configureClient(o: Partial<ClientConfig>): void {
  Object.assign(CLIENT_CONFIG, o);
}

/** `null` whenever the host isn't there (local dev, offline, out of budget): callers carry on unranked. */
export const api = {
  soloStart: (gameId: string, cfg = CLIENT_CONFIG) => call<SoloStartResponse>(`/api/solo/${enc(gameId)}/start`, { method: 'POST' }, cfg),
  soloSegment: (gameId: string, runId: string, segment: unknown, cfg = CLIENT_CONFIG) =>
    call<SoloSegmentResponse>(`/api/solo/${enc(gameId)}/${enc(runId)}/segment`, { method: 'POST', body: JSON.stringify(segment), headers: { 'Content-Type': 'application/json' } }, cfg),
  scores: (gameId: string, cfg = CLIENT_CONFIG) => call<ScoresResponse>(`/api/solo/${enc(gameId)}/scores`, { method: 'GET' }, cfg),
  usage: (cfg = CLIENT_CONFIG) => call<UsageResponse>('/api/usage', { method: 'GET' }, cfg),
  createRoom: (gameId: string, cfg = CLIENT_CONFIG) => call<{ roomId: string }>(`/api/rooms/${enc(gameId)}`, { method: 'POST' }, cfg),
};

/** Delay before reconnect attempt `n` (0-based). */
export const backoffMs = (n: number, cfg = CLIENT_CONFIG): number => Math.min(cfg.reconnect.maxMs, cfg.reconnect.baseMs * cfg.reconnect.factor ** n);

/** Sends an input only when it differs from the last one sent under the same key (e.g. a held direction). */
export class InputOnChange<T> {
  private last = new Map<string, string>();
  constructor(private readonly send: (input: T) => void) {}
  offer(key: string, input: T): boolean {
    const text = JSON.stringify(input);
    if (this.last.get(key) === text) return false;
    this.last.set(key, text);
    this.send(input);
    return true;
  }
  /** One-off inputs (a throw, a snap) always go. */
  always(input: T): void {
    this.send(input);
  }
  reset(): void {
    this.last.clear();
  }
}

/** Views by arrival time; `at(t)` gives the pair around `t − delay` and how far between them. */
export class SnapshotBuffer<V> {
  private items: { atMs: number; view: V }[] = [];
  constructor(private readonly cfg = CLIENT_CONFIG) {}
  push(atMs: number, view: V): void {
    this.items.push({ atMs, view });
    if (this.items.length > this.cfg.bufferSize) this.items.shift();
  }
  at(nowMs: number): { from: V; to: V; t: number } | null {
    const target = nowMs - this.cfg.interpolationDelayMs;
    const items = this.items;
    if (items.length === 0) return null;
    for (let i = items.length - 1; i > 0; i--) {
      const a = items[i - 1]!;
      const b = items[i]!;
      if (a.atMs <= target) {
        const span = b.atMs - a.atMs;
        return { from: a.view, to: b.view, t: span > 0 ? Math.min(1, Math.max(0, (target - a.atMs) / span)) : 1 };
      }
    }
    const first = items[0]!;
    return { from: first.view, to: first.view, t: 1 };
  }
}

export interface RoomHandlers<V> {
  onView(view: V, atMs: number): void;
  onOver?(view: V): void;
  onStatus?(status: 'connecting' | 'open' | 'closed'): void;
}

/**
 * A room socket that reconnects with backoff and reclaims its seat (the
 * server knows us by our Access identity). Stops for good once the match is
 * over or `close()` is called.
 */
export class RoomConnection<V, I> {
  private ws: WebSocket | null = null;
  private seq = 0;
  private attempts = 0;
  private closed = false;
  readonly inputs: InputOnChange<I>;

  constructor(
    private readonly roomId: string,
    private readonly handlers: RoomHandlers<V>,
    private readonly cfg = CLIENT_CONFIG,
  ) {
    this.inputs = new InputOnChange<I>((input) => this.send({ t: 'input', s: ++this.seq, d: input }));
    this.open();
  }

  private open(): void {
    if (this.closed) return;
    this.handlers.onStatus?.('connecting');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}${this.cfg.basePath}/api/rooms/${encodeURIComponent(this.roomId)}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.inputs.reset();
      this.handlers.onStatus?.('open');
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(e.data) as ServerMessage;
      } catch {
        return;
      }
      if (msg.t === 'view') this.handlers.onView(msg.d as V, performance.now());
      if (msg.t === 'over') {
        this.closed = true;
        this.handlers.onOver?.(msg.d as V);
      }
    };
    ws.onclose = () => {
      this.handlers.onStatus?.('closed');
      if (this.closed) return;
      setTimeout(() => this.open(), backoffMs(this.attempts++, this.cfg));
    };
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
