import { topology } from '../engine/topology.ts';
import type { Topology } from '../engine/topology.ts';
import type { RngSource } from '../engine/rng.ts';
import type { Action, GameConfig, GameView, LegalOf, ResMap } from '../engine/types.ts';
import type { OfferShape, Strategy } from './types.ts';
import { chance, choice, groupByType, legalToAction, maxBy, scoreIntersection, selfView, sumVals } from './util.ts';
import type { SelfView } from './util.ts';

const GOAL_CITY: ResMap = { rock: 3, wheat: 2 };
const GOAL_SETTLEMENT: ResMap = { clay: 1, wood: 1, wheat: 1, sheep: 1 };
const GOAL_ROAD: ResMap = { clay: 1, wood: 1 };
const GOAL_DEV: ResMap = { rock: 1, wheat: 1, sheep: 1 };

const maxOf = (cfg: GameConfig, id: string): number => cfg.building_types[id]?.max_per_player ?? 0;

/** What the bot saves for, best first. A city returns its settlement to the supply, so only settlements on the board count. */
export function goalsFor(cfg: GameConfig, p: SelfView): ResMap[] {
  const settlements = p.buildings_placed.settlement ?? 0;
  const cities = p.buildings_placed.city ?? 0;
  const goals: ResMap[] = [];
  if (settlements > 0 && cities < maxOf(cfg, 'city')) goals.push(GOAL_CITY);
  if (settlements < maxOf(cfg, 'settlement')) goals.push(GOAL_SETTLEMENT);
  goals.push(GOAL_ROAD, GOAL_DEV);
  return goals;
}

const openSpot = (view: GameView, topo: Topology, iid: number): boolean =>
  !view.board.buildings.i[iid] && !topo.adjInter[iid]!.some((n) => view.board.buildings.i[n]);

function nearbySpot(view: GameView, topo: Topology, start: number, depth: number): boolean {
  const visited = new Set([start]);
  let frontier = [start];
  for (let d = 0; d < depth; d++) {
    const next: number[] = [];
    for (const iid of frontier) {
      for (const adj of topo.adjInter[iid]!) {
        if (visited.has(adj)) continue;
        visited.add(adj);
        if (view.board.buildings.i[adj]) continue;
        if (openSpot(view, topo, adj)) return true;
        next.push(adj);
      }
    }
    frontier = next;
  }
  return false;
}

function roadScore(view: GameView, topo: Topology, a: LegalOf<'build'>): number {
  const e = topo.edges[a.location]!;
  let score = 0;
  for (const iid of [e.a, e.b]) if (openSpot(view, topo, iid)) score = Math.max(score, scoreIntersection(view, topo, iid));
  return score;
}

function chooseRoad(view: GameView, topo: Topology, roads: LegalOf<'build'>[], rng: RngSource): LegalOf<'build'> {
  let best: LegalOf<'build'> | null = null;
  let bestScore = -1;
  for (const a of roads) {
    const s = roadScore(view, topo, a);
    if (s > bestScore) { bestScore = s; best = a; }
  }
  return best ?? choice(rng, roads);
}

function roadHasValue(cfg: GameConfig, view: GameView, topo: Topology, me: SelfView, a: LegalOf<'build'>): boolean {
  if ((me.buildings_placed.road ?? 0) >= maxOf(cfg, 'road') - 2) return false;
  const e = topo.edges[a.location]!;
  return [e.a, e.b].some((i) => nearbySpot(view, topo, i, 2));
}

function chooseBankTrade(cfg: GameConfig, me: SelfView, trades: LegalOf<'trade_bank'>[]): LegalOf<'trade_bank'> | null {
  for (const goal of goalsFor(cfg, me)) {
    const missing: ResMap = {};
    for (const [r, need] of Object.entries(goal)) {
      const deficit = need - (me.resources[r] ?? 0);
      if (deficit > 0) missing[r] = deficit;
    }
    if (!Object.keys(missing).length) continue;
    for (const want of Object.keys(missing).sort((x, y) => missing[x]! - missing[y]!)) {
      const matching = trades.filter((t) => t.want_resource === want);
      if (!matching.length) continue;
      const value = (t: LegalOf<'trade_bank'>): number => (me.resources[t.give_resource] ?? 0) - (goal[t.give_resource] ?? 0);
      const best = maxBy(matching, value);
      if (best && value(best) > 0) return best;
    }
  }
  if (sumVals(me.resources) >= 7) {
    for (const t of trades) if ((me.resources[t.give_resource] ?? 0) >= 5) return t;
  }
  return null;
}

function choosePlayerTrade(cfg: GameConfig, me: SelfView): OfferShape | null {
  for (const goal of goalsFor(cfg, me)) {
    const missing: ResMap = {};
    const surplus: ResMap = {};
    for (const r of Object.keys(cfg.resource_types)) {
      const have = me.resources[r] ?? 0;
      const need = goal[r] ?? 0;
      if (need > have) missing[r] = need - have;
      else if (have > need + 1) surplus[r] = have - need - 1;
    }
    if (!Object.keys(missing).length || !Object.keys(surplus).length) continue;
    const want = maxBy(Object.keys(missing), (r) => missing[r]!);
    const give = maxBy(Object.keys(surplus), (r) => surplus[r]!);
    if (!want || !give || give === want) continue;
    return { offering: { [give]: 1 }, requesting: { [want]: 1 } };
  }
  return null;
}

function chooseRobberHex(view: GameView, topo: Topology, actions: LegalOf<'move_robber'>[], rng: RngSource): LegalOf<'move_robber'> {
  let leader: string | null = null;
  let leaderVp = -1;
  for (const pid of view.player_order) {
    if (pid === view.me) continue;
    const vp = view.players[pid]!.vp; // public VP only: a fair bot never sees hidden VP cards
    if (vp > leaderVp) { leaderVp = vp; leader = pid; }
  }
  let best: LegalOf<'move_robber'> | null = null;
  let bestScore = -1;
  for (const a of actions) {
    const hex = view.board.hexes[a.hex_id];
    if (!hex?.number_token) continue;
    const prod = Math.max(0, 6 - Math.abs(7 - hex.number_token));
    let score = 0;
    for (const iid of topo.hexIntersections[a.hex_id]!) {
      const b = view.board.buildings.i[iid];
      if (!b) continue;
      if (b.player === leader) score += prod * 2;
      else if (b.player !== view.me) score += prod;
    }
    if (score > bestScore) { bestScore = score; best = a; }
  }
  return best ?? choice(rng, actions);
}

export const smartStrategy: Strategy = {
  newMemory: () => ({ offeredTradeThisTurn: false }),

  chooseAction(cfg, view, rng, mem): Action | null {
    const legal = view.legal_actions;
    if (!legal.length) return null;
    const topo = topology(view.board.rings);
    const by = groupByType(legal);
    const me = selfView(view);
    const act = (la: Parameters<typeof legalToAction>[0]): Action => legalToAction(la, view.me);

    if (by.roll_dice?.length) { mem.offeredTradeThisTurn = false; return act(choice(rng, by.roll_dice)); }
    if (by.move_robber?.length) return act(chooseRobberHex(view, topo, by.move_robber, rng));
    if (by.steal?.length) {
      const best = maxBy(by.steal, (a) => view.players[a.target_player]!.resource_count);
      return act(best ?? choice(rng, by.steal));
    }
    if (by.discard?.length) return act(choice(rng, by.discard));
    if (by.dev_card_action?.length) return act(choice(rng, by.dev_card_action));

    if (by.play_dev_card?.length) return act(choice(rng, by.play_dev_card));

    const builds = by.build ?? [];
    const cities = builds.filter((a) => a.building_type === 'city');
    const settlements = builds.filter((a) => a.building_type === 'settlement');
    const roads = builds.filter((a) => a.building_type === 'road');
    const settlementCount = me.buildings_placed.settlement ?? 0;
    const roadCount = me.buildings_placed.road ?? 0;

    const bestCity = maxBy(cities, (a) => scoreIntersection(view, topo, a.location));
    if (bestCity) return act(bestCity);
    const bestSettlement = maxBy(settlements, (a) => scoreIntersection(view, topo, a.location));
    if (bestSettlement) return act(bestSettlement);

    if (roads.length) {
      const chosen = chooseRoad(view, topo, roads, rng);
      if (roadHasValue(cfg, view, topo, me, chosen)) {
        if (settlementCount < maxOf(cfg, 'settlement') - 1 || roadCount < 5) return act(chosen);
        if (chance(rng, 0.6)) return act(chosen);
      }
    }

    if (by.trade_bank?.length) {
      const t = chooseBankTrade(cfg, me, by.trade_bank);
      if (t) return act(t);
    }

    if (by.buy_dev_card?.length) {
      const knights = me.played_dev_cards.filter((c) => cfg.dev_card_types[c]?.persistent_tag === 'knight').length;
      if (knights >= 1 || sumVals(me.resources) >= 7 || (!roads.length && !settlements.length && !cities.length)) {
        return act(by.buy_dev_card[0]!);
      }
    }

    if (roads.length) return act(chooseRoad(view, topo, roads, rng));

    if (by.trade_offer?.length && !mem.offeredTradeThisTurn) {
      const t = choosePlayerTrade(cfg, me);
      if (t) {
        mem.offeredTradeThisTurn = true;
        return { type: 'trade_offer', player_id: view.me, params: t };
      }
    }

    if (by.end_turn?.length) return act(by.end_turn[0]!);
    return act(choice(rng, legal));
  },

  chooseDiscard(_cfg, view, count) {
    const me = selfView(view);
    const cards = Object.entries(me.resources).flatMap(([k, n]) => Array<string>(n).fill(k));
    cards.sort((a, b) => me.resources[b]! - me.resources[a]!);
    const out: ResMap = {};
    for (const c of cards.slice(0, count)) out[c] = (out[c] ?? 0) + 1;
    return out;
  },

  chooseYearOfPlenty(cfg, view, count) {
    const me = selfView(view);
    const needs: ResMap = {};
    for (const [r, need] of Object.entries(GOAL_CITY)) {
      const d = need - (me.resources[r] ?? 0);
      if (d > 0) needs[r] = d;
    }
    const out: ResMap = {};
    if (Object.keys(needs).length && sumVals(needs) <= count) {
      let remaining = count;
      for (const [r, d] of Object.entries(needs).sort((a, b) => b[1] - a[1])) {
        const take = Math.min(d, remaining);
        if (take > 0) { out[r] = take; remaining -= take; }
      }
      for (const r of Object.keys(cfg.resource_types)) {
        if (remaining <= 0) break;
        out[r] = (out[r] ?? 0) + 1;
        remaining--;
      }
      return out;
    }
    const kinds = Object.keys(cfg.resource_types).sort((a, b) => (me.resources[a] ?? 0) - (me.resources[b] ?? 0));
    for (let i = 0; i < count; i++) { const r = kinds[i % kinds.length]!; out[r] = (out[r] ?? 0) + 1; }
    return out;
  },

  // Fair version: the Python bot read opponents' exact hands. Here it targets what it needs most.
  chooseMonopoly(cfg, view, rng) {
    const me = selfView(view);
    const want: ResMap = {};
    for (const goal of goalsFor(cfg, me).slice(0, 2)) {
      for (const [r, need] of Object.entries(goal)) want[r] = (want[r] ?? 0) + Math.max(0, need - (me.resources[r] ?? 0));
    }
    const kinds = Object.keys(cfg.resource_types);
    const top = Math.max(...kinds.map((r) => want[r] ?? 0));
    return choice(rng, kinds.filter((r) => (want[r] ?? 0) === top));
  },

  evaluateTrade(_cfg, view, offer, rng) {
    const me = selfView(view);
    for (const [r, n] of Object.entries(offer.requesting)) if ((me.resources[r] ?? 0) < n) return false;
    const give = sumVals(offer.requesting);
    const get = sumVals(offer.offering);
    if (get > give) return true;
    if (get === give) return chance(rng, 0.4);
    return false;
  },

  counterOffer(_cfg, view, offer) {
    const me = selfView(view);
    const theyGive = Object.keys(offer.offering).sort((a, b) => offer.offering[b]! - offer.offering[a]!)[0];
    const theyWant = Object.keys(offer.requesting).sort((a, b) => offer.requesting[b]! - offer.requesting[a]!)[0];
    if (!theyGive || !theyWant || (me.resources[theyWant] ?? 0) < 1) return null;
    return { offering: { [theyWant]: 1 }, requesting: { [theyGive]: 1 } };
  },
};
