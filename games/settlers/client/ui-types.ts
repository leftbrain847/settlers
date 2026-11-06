import type { ActionParams, ActionType, GameConfig, GameView, LegalAction, LegalOf, PlayerView, ResMap, TradeOffer } from '../engine/types.ts';
import type { Snapshot } from './transport.ts';

export type Kind = 'i' | 'e' | 'h';
export type SheetName = 'build' | 'trade' | 'dev' | 'log' | 'menu';
export type Move = { [K in ActionType]: [K, ActionParams[K]] }[ActionType];
export type SendFn = <T extends ActionType>(type: T, params?: ActionParams[T]) => void;

export interface Draft {
  discard?: ResMap;
  yop?: ResMap;
  tradeTab?: 'players' | 'bank';
  trade?: { give: ResMap; want: ResMap };
  bank?: { give: string | null; want: string | null };
  counter?: { for: string; they: ResMap; you: ResMap } | null;
}
export interface Toast { text: string; bad: boolean; id: number }
export interface UiState {
  sheet: SheetName | null;
  draft: Draft;
  pending: { kind: Kind; id: number } | null;
  buildMode: string | null;
  toasts: Toast[];
  muteUntilTurn: number;
  lastSaved: number;
  confirmLeave?: boolean;
}

/** What the board should highlight, and the piece to preview for a tapped spot. */
export interface BoardTargets {
  i?: Set<number>; e?: Set<number>; h?: Set<number>;
  /** pieces that just appeared (they pop in once instead of replaying on every redraw) */
  fresh?: { i: Map<number, number>; e: Map<number, number> };
  /** draw picture tiles (the Pastel look) */
  pictures?: boolean;
  ghost?: { kind: Kind; id: number; type?: string; player: string } | null;
}
export interface Mode { kind: Kind; ids: Set<number>; piece?: string; apply(id: number): Move; label: string }

export interface SheetCtx { view: GameView; cfg: GameConfig; ui: UiState; snap: Snapshot; send: SendFn; rerender: () => void }
export interface IncomingCtx extends SheetCtx { offer: TradeOffer }
export interface WaitingCtx extends SheetCtx { offer: TradeOffer; counters: TradeOffer[] }

/** Type guard factory: legal.filter(isLegal('build')) yields the build entries, fully typed. */
export const isLegal = <T extends LegalAction['type']>(t: T) => (a: LegalAction): a is LegalOf<T> => a.type === t;

/** Own-seat hands are always present in a view; this makes the optional field safe to read. */
export const handOf = (p: PlayerView): ResMap => p.resources ?? {};

/** Either board renderer (SVG or 3D): draws a view, reports taps through its constructor callback, and maps board spots to screen points. */
export interface BoardRenderer {
  el: HTMLElement | SVGElement;
  update(view: GameView, cfg: GameConfig, targets?: BoardTargets): void;
  clientPoint(kind: Kind, id: number): { x: number; y: number } | null;
  resetZoom(): void;
  destroy(): void;
}
