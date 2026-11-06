import { h } from './dom.ts';
import { DEV_ICON, icon, resIcon } from './icons.ts';
import { bankRatio } from '../engine/state.ts';
import { describeLog } from './format.ts';
import { handOf, isLegal } from './ui-types.ts';
import type { GameConfig, ResMap, TradeOffer } from '../engine/types.ts';
import type { Snapshot } from './transport.ts';
import type { IncomingCtx, SheetCtx, WaitingCtx } from './ui-types.ts';

const sum = (m: ResMap): number => Object.values(m).reduce((a, b) => a + b, 0);
export const resName = (cfg: GameConfig, r: string): string => cfg.resource_types[r]?.name ?? r;

export function chip(cfg: GameConfig, r: string, n?: number, cls = ''): HTMLElement {
  return h('span.chip.res' + (cls ? '.' + cls : ''), { style: { '--c': `var(--r-${r})` }, 'aria-label': n === undefined ? resName(cfg, r) : `${n} ${resName(cfg, r)}`, title: resName(cfg, r) }, icon(resIcon(r), 16), n === undefined ? null : h('span.cn', n));
}

export const costChips = (cfg: GameConfig, cost: ResMap): HTMLElement =>
  h('span.costs', Object.entries(cost).map(([r, n]) => chip(cfg, r, n)));

// ctx is injected per render so sheet builders can stay plain functions.
let current: SheetCtx | null = null;
export function withCtx<T>(c: SheetCtx, fn: () => T): T { current = c; return fn(); }
const rerender = (): void => { current?.rerender(); };

function stepper(cfg: GameConfig, r: string, value: number, max: number, onChange: (v: number) => void): HTMLElement {
  return h('div.rcell' + (value ? '.has' : ''), { style: { '--c': `var(--r-${r})` } },
    h('span.rname', { title: resName(cfg, r), 'aria-label': resName(cfg, r) }, icon(resIcon(r), 22)),
    h('span.rval', value),
    h('div.pm',
      h('button.step', { disabled: value <= 0, onclick: () => onChange(value - 1), 'aria-label': `less ${resName(cfg, r)}` }, '−'),
      h('button.step', { disabled: value >= max, onclick: () => onChange(value + 1), 'aria-label': `more ${resName(cfg, r)}` }, '+')));
}

function steppers(cfg: GameConfig, draft: ResMap, kinds: string[], caps: ResMap): HTMLElement {
  return h('div.rgrid', kinds.map((r) => stepper(cfg, r, draft[r] ?? 0, caps[r] ?? 0, (v) => { if (v > 0) draft[r] = v; else delete draft[r]; rerender(); })));
}

interface BtnOpts { primary?: boolean; disabled?: boolean; cls?: string }
const btn = (label: string | Node, onclick: () => void, { primary, disabled, cls }: BtnOpts = {}): HTMLElement =>
  h('button.btn' + (primary ? '.primary' : '') + (cls ? '.' + cls : ''), { onclick, disabled }, label);

export function timerBar(snap: Snapshot, id: string): HTMLElement | null {
  const dl = snap.deadlines?.[id];
  if (!dl) return null;
  const left = Math.max(0.1, (dl - snap.now) / 1000);
  return h('div.timer', h('div.timer-fill', { style: { animationDuration: `${left}s` } }));
}

// ---------------- discard ----------------
export function discardSheet({ view, cfg, ui, send }: SheetCtx): HTMLElement {
  const need = view.pending_discards[view.me];
  const me = view.players[view.me];
  const d = (ui.draft.discard ??= {});
  const have = sum(d);
  return h('div', h('p.dim', `Choose ${need} cards to discard (${have}/${need}).`),
    steppers(cfg, d, Object.keys(cfg.resource_types), handOf(me)),
    btn('Discard', () => { send('discard', { resources: { ...d } }); ui.draft.discard = {}; }, { primary: true, disabled: have !== need }));
}

// ---------------- robber steal ----------------
export function stealSheet({ view, send }: SheetCtx): HTMLElement {
  return h('div', h('p.dim', 'Steal a card from:'), h('div.col', view.robber_steal_candidates.map((id) => {
    const p = view.players[id];
    return btn(`${p.name} (${p.resource_count} cards)`, () => send('steal', { target_player: id }), { primary: true });
  })));
}

// ---------------- dev card choices ----------------
export function yopSheet({ view, cfg, ui, send }: SheetCtx): HTMLElement {
  const need = view.pending_action?.type === 'choose_resources' ? view.pending_action.count : 0;
  const d = (ui.draft.yop ??= {});
  const have = sum(d);
  return h('div', h('p.dim', `Year of Plenty: take ${need} resources from the bank (${have}/${need}).`),
    h('div.rgrid', Object.keys(cfg.resource_types).map((r) => stepper(cfg, r, d[r] ?? 0, need - (have - (d[r] ?? 0)), (v) => { if (v > 0) d[r] = v; else delete d[r]; rerender(); }))),
    btn('Take resources', () => { send('dev_card_action', { resources: { ...d } }); ui.draft.yop = {}; }, { primary: true, disabled: have !== need }));
}

export function monopolySheet({ cfg, send }: SheetCtx): HTMLElement {
  return h('div', h('p.dim', 'Monopoly: take every card of one resource from all other players.'),
    h('div.col', Object.keys(cfg.resource_types).map((r) => h('button.btn.res-btn', { style: { '--c': `var(--r-${r})` }, onclick: () => send('dev_card_action', { resource: r }), 'aria-label': resName(cfg, r) }, icon(resIcon(r), 26)))));
}

// ---------------- build ----------------
export function buildSheet({ view, cfg, ui, send }: SheetCtx): HTMLElement {
  const legal = view.legal_actions;
  const me = view.players[view.me];
  const hand = handOf(me);
  const rows: HTMLElement[] = [];
  for (const [id, bt] of Object.entries(cfg.building_types)) {
    if (id === 'dev_card') continue;
    const spots = legal.filter(isLegal('build')).filter((a) => a.building_type === id).length;
    const placed = me.buildings_placed[id] ?? 0;
    const affordable = Object.entries(bt.cost).every(([r, n]) => (hand[r] ?? 0) >= n);
    const why = placed >= bt.max_per_player ? `None left (${bt.max_per_player} max)` : !affordable ? 'Not enough resources' : !spots ? 'No legal spot' : '';
    rows.push(h('div.row' + (why ? '.off' : ''), h('div.row-main', h('strong', bt.name), h('span.dim', ` ${placed}/${bt.max_per_player}  ·  ${bt.vp ? bt.vp + ' VP' : ''}`), costChips(cfg, bt.cost)),
      why ? h('span.dim.small', why) : btn('Choose spot', () => { ui.buildMode = id; ui.sheet = null; rerender(); }, { primary: true })));
  }
  const dev = cfg.building_types.dev_card;
  if (dev) {
    const can = legal.some(isLegal('buy_dev_card'));
    rows.push(h('div.row' + (can ? '' : '.off'), h('div.row-main', h('strong', 'Development card'), h('span.dim', ` ${view.dev_cards_remaining} left`), costChips(cfg, dev.cost)),
      can ? btn('Buy', () => { send('buy_dev_card'); ui.sheet = null; }, { primary: true }) : h('span.dim.small', view.dev_cards_remaining ? 'Not enough resources' : 'Deck is empty')));
  }
  return h('div.list', rows);
}

// ---------------- development cards ----------------
const DEV_TEXT: Record<string, string> = {
  activate_robber: 'Move the robber and steal a card. Counts toward Largest Army.',
  build_roads: 'Build 2 roads for free.', gain_resources: 'Take 2 resources of your choice.', monopoly: 'Take all of one resource from every other player.',
};

export function devSheet({ view, cfg, send, ui }: SheetCtx): HTMLElement {
  const me = view.players[view.me];
  const cards = me.dev_cards ?? [];
  const counts: Record<string, number> = {};
  for (const c of cards) counts[c] = (counts[c] ?? 0) + 1;
  if (!cards.length && !me.played_dev_cards.length) return h('p.dim', 'You have no development cards.');
  const rows = Object.entries(counts).map(([id, n]) => {
    const dc = cfg.dev_card_types[id];
    const playable = view.legal_actions.filter(isLegal('play_dev_card')).some((a) => a.card_type === id);
    return h('div.row' + (playable || dc.is_victory_point ? '' : '.off'), h('div.row-main', h('strong.devname', icon(DEV_ICON[id] ?? 'card', 18), `${dc.name}${n > 1 ? ` ×${n}` : ''}`), h('span.dim.small', dc.is_victory_point ? '1 secret victory point' : DEV_TEXT[dc.effects[0]?.type ?? ''] ?? '')),
      dc.is_victory_point ? h('span.dim.small', 'Automatic') : btn('Play', () => { send('play_dev_card', { card_type: id }); ui.sheet = null; }, { primary: true, disabled: !playable }));
  });
  const played = me.played_dev_cards.length ? h('p.dim.small', `Played: ${me.played_dev_cards.map((c) => cfg.dev_card_types[c]?.name).join(', ')}`) : null;
  return h('div.list', rows, played, h('p.dim.small', 'One development card per turn; not the turn you bought it.'));
}

// ---------------- trade ----------------
export function tradeSheet(ctx: SheetCtx): HTMLElement {
  const { view, cfg, ui, send } = ctx;
  const me = view.players[view.me];
  const kinds = Object.keys(cfg.resource_types);
  const tab = (ui.draft.tradeTab ??= 'players');
  const tabs = h('div.tabs', (['players', 'bank'] as const).map((t) => h('button.tab' + (tab === t ? '.on' : ''), { onclick: () => { ui.draft.tradeTab = t; rerender(); } }, t === 'players' ? 'Players' : 'Bank')));
  if (tab === 'bank') return h('div', tabs, bankPane(ctx));
  const t = (ui.draft.trade ??= { give: {}, want: {} });
  const canSend = sum(t.give) > 0 && sum(t.want) > 0;
  const cap9: ResMap = Object.fromEntries(kinds.map((r) => [r, 9]));
  const others = view.player_order.filter((p) => p !== view.me).map((p) => view.players[p].name).join(', ');
  return h('div', tabs, h('p.dim.small', `To ${others}. Bots answer at once; people get ${cfg.trade_rules.human_response_timer}s.`),
    h('h4', 'Give'), steppers(cfg, t.give, kinds, handOf(me)),
    h('h4', 'Receive'), steppers(cfg, t.want, kinds, cap9),
    btn('Send offer', () => { send('trade_offer', { offering: { ...t.give }, requesting: { ...t.want } }); ui.draft.trade = { give: {}, want: {} }; ui.sheet = null; }, { primary: true, disabled: !canSend }));
}

function bankPane({ view, cfg, ui, send }: SheetCtx): HTMLElement {
  const me = view.players[view.me];
  const kinds = Object.keys(cfg.resource_types);
  const b = (ui.draft.bank ??= { give: null, want: null });
  const legal = view.legal_actions.filter(isLegal('trade_bank'));
  const gives = new Set(legal.map((a) => a.give_resource));
  if (b.give && !gives.has(b.give)) b.give = null;
  const wants = b.give ? legal.filter((a) => a.give_resource === b.give).map((a) => a.want_resource) : [];
  if (b.want && !wants.includes(b.want)) b.want = null;
  const pick = (key: 'give' | 'want', set: Set<string>, r: string): HTMLElement =>
    h('button.btn.res-btn' + (b[key] === r ? '.on' : ''), { style: { '--c': `var(--r-${r})` }, disabled: !set.has(r), 'aria-label': resName(cfg, r), onclick: () => { b[key] = r; rerender(); } }, icon(resIcon(r), 24));
  const ratio = b.give ? bankRatio(cfg, { ports: me.ports }, b.give) : null;
  const give = b.give, want = b.want;
  return h('div', h('h4', 'Give'), h('div.pickrow', kinds.map((r) => pick('give', gives, r))),
    h('h4', 'Get'), h('div.pickrow', kinds.map((r) => pick('want', new Set(wants), r))),
    h('p.dim.small', gives.size ? 'Ports improve your ratio.' : 'You do not have enough of any resource to trade with the bank.'),
    btn(give && want ? h('span.tradeline', String(ratio), icon(resIcon(give), 20), icon('swap', 18), '1', icon(resIcon(want), 20)) : 'Choose resources', () => {
      if (!give || !want) return;
      send('trade_bank', { give_resource: give, want_resource: want });
      ui.draft.bank = { give: null, want: null };
      ui.sheet = null;
    }, { primary: true, disabled: !(give && want) }));
}

// ---------------- incoming offer ----------------
export function incomingSheet({ view, cfg, ui, send, snap, offer }: IncomingCtx): HTMLElement {
  const me = view.players[view.me];
  const hand = handOf(me);
  const from = view.players[offer.from_player];
  const afford = Object.entries(offer.requesting).every(([r, n]) => (hand[r] ?? 0) >= n);
  const side = (label: string, m: ResMap): HTMLElement => h('div.side', h('div.side-label', label), h('div.costs', Object.entries(m).map(([r, n]) => chip(cfg, r, n))));
  const counterDraft = ui.draft.counter;
  if (counterDraft && counterDraft.for === offer.id) {
    const kinds = Object.keys(cfg.resource_types);
    return h('div', h('h4', `Counter ${from.name}`),
      h('p.dim.small', 'Receive'), steppers(cfg, counterDraft.they, kinds, Object.fromEntries(kinds.map((r) => [r, 9]))),
      h('p.dim.small', 'Give'), steppers(cfg, counterDraft.you, kinds, hand),
      h('div.btnrow', btn('Send counter', () => { send('trade_offer', { offering: { ...counterDraft.you }, requesting: { ...counterDraft.they }, counter_to: offer.id }); ui.draft.counter = null; }, { primary: true, disabled: !(sum(counterDraft.they) && sum(counterDraft.you)) }),
        btn('Back', () => { ui.draft.counter = null; rerender(); })));
  }
  const rounds: [number, string][] = [[1, '1 round'], [3, '3 rounds'], [5, '5 rounds'], [999, 'Rest of game']];
  return h('div', h('p', h('strong', from.name), ' offers a trade'),
    h('div.trade', side('Receive', offer.offering), h('span.arrow', '⇄'), side('Give', offer.requesting)),
    timerBar(snap, offer.id),
    h('div.btnrow', btn('Accept', () => send('trade_respond', { trade_id: offer.id, response: 'accept' }), { primary: true, disabled: !afford }),
      cfg.trade_rules.counter_offers ? btn('Counter', () => { ui.draft.counter = { for: offer.id, they: { ...offer.offering }, you: { ...offer.requesting } }; rerender(); }) : null,
      btn('Decline', () => send('trade_respond', { trade_id: offer.id, response: 'decline' }))),
    !afford ? h('p.dim.small', "You don't have the cards to accept.") : null,
    h('details.mute', h('summary', 'Decline all offers for…'), h('div.btnrow', rounds.map(([n, l]) => btn(l, () => { ui.muteUntilTurn = view.turn_number + n * view.player_order.length; rerender(); })))));
}

// ---------------- my pending offer ----------------
export function waitingSheet({ view, cfg, send, snap, offer, counters }: WaitingCtx): HTMLElement {
  const rows = view.player_order.filter((p) => p !== view.me).map((pid) => {
    const r = offer.responses[pid];
    const p = view.players[pid];
    const status = r === 'accepted' ? 'Accepted' : r === 'declined' ? 'Declined' : r === 'countered' ? 'Counter-offer' : 'Thinking…';
    return h('div.row', h('div.row-main', h('strong', p.name), h('span.dim', ` ${status}`)),
      r === 'accepted' ? btn('Confirm trade', () => send('trade_accept', { trade_id: offer.id, accepter_id: pid }), { primary: true }) : null);
  });
  const side = (label: string, m: ResMap): HTMLElement => h('div.side', h('div.side-label', label), h('div.costs', Object.entries(m).map(([r, n]) => chip(cfg, r, n))));
  const counterRows = counters.map((c) => h('div.row', h('div.row-main', h('strong', `${view.players[c.from_player].name} counters`), h('div.costs', h('span.dim.small', 'gives '), Object.entries(c.offering).map(([r, n]) => chip(cfg, r, n)), h('span.dim.small', ' for '), Object.entries(c.requesting).map(([r, n]) => chip(cfg, r, n)))),
    btn('Accept', () => send('trade_respond', { trade_id: c.id, response: 'accept' }), { primary: true }), btn('Decline', () => send('trade_respond', { trade_id: c.id, response: 'decline' }))));
  return h('div', h('div.trade', side('Give', offer.offering), h('span.arrow', '⇄'), side('Receive', offer.requesting)),
    h('div.list', rows, counterRows), timerBar(snap, offer.id),
    btn('Withdraw offer', () => send('trade_cancel', { trade_id: offer.id })));
}

// ---------------- log ----------------
export function logSheet({ view, cfg }: SheetCtx): HTMLElement {
  const lines = view.log.map((e) => describeLog(e, view, cfg)).filter((l): l is string => l !== null).reverse();
  return h('ul.log', lines.map((l) => h('li', l)));
}

export function tradeSummary(cfg: GameConfig, o: TradeOffer): string {
  return `${Object.entries(o.offering).map(([r, n]) => `${n} ${resName(cfg, r)}`).join(', ')} for ${Object.entries(o.requesting).map(([r, n]) => `${n} ${resName(cfg, r)}`).join(', ')}`;
}
