"""
AI player strategies.

Each strategy is a function that takes (engine, player_id) and returns
an Action to perform. The engine doesn't care if an action comes from
a human or an AI — it's all the same.

To create a custom AI: define a function with the same signature.
The AIStrategy base class is designed to be subclassed — including
by future RL-trained agents that learn from self-play.
"""

from __future__ import annotations

import random
from typing import Optional, TYPE_CHECKING

from .actions import Action

if TYPE_CHECKING:
    from .engine import GameEngine


class AIStrategy:
    """Base class for AI strategies."""

    def choose_action(self, engine: GameEngine, player_id: str) -> Optional[Action]:
        raise NotImplementedError

    def choose_discard(self, engine: GameEngine, player_id: str, count: int) -> dict[str, int]:
        """Choose which resources to discard."""
        raise NotImplementedError

    def evaluate_trade(self, engine: GameEngine, player_id: str,
                       offering: dict[str, int], requesting: dict[str, int],
                       from_player: str) -> bool:
        """Decide whether to accept a trade offer. Returns True to accept."""
        return False


class RandomStrategy(AIStrategy):
    """Simple AI that makes random legal moves. Good for testing."""

    def choose_action(self, engine: GameEngine, player_id: str) -> Optional[Action]:
        legal = engine.get_legal_actions(player_id)
        if not legal:
            return None

        # Prioritize certain actions for less chaotic play
        priority_order = [
            "build",        # always build if possible
            "buy_dev_card",
            "roll_dice",
            "move_robber",
            "steal",
            "dev_card_action",
            "discard",
            "end_turn",
        ]

        # Group by type
        by_type: dict[str, list] = {}
        for a in legal:
            by_type.setdefault(a["type"], []).append(a)

        # Pick from highest priority available type
        for ptype in priority_order:
            if ptype in by_type:
                chosen = random.choice(by_type[ptype])
                return self._legal_to_action(chosen, player_id)

        # Fallback
        chosen = random.choice(legal)
        return self._legal_to_action(chosen, player_id)

    def _legal_to_action(self, legal_action: dict, player_id: str) -> Action:
        action_type = legal_action["type"]
        params = {k: v for k, v in legal_action.items() if k != "type"}
        return Action(type=action_type, player_id=player_id, params=params)

    def choose_discard(self, engine: GameEngine, player_id: str, count: int) -> dict[str, int]:
        """Randomly discard resources."""
        player = engine.state.get_player(player_id)
        resources = []
        for res_id, amount in player.resources.items():
            resources.extend([res_id] * amount)
        random.shuffle(resources)
        to_discard = resources[:count]

        result: dict[str, int] = {}
        for r in to_discard:
            result[r] = result.get(r, 0) + 1
        return result

    def choose_robber_hex(self, engine: GameEngine, player_id: str) -> int:
        """Choose a random hex to move the robber to."""
        state = engine.state
        candidates = [
            hid for hid in state.board.hexes
            if hid != state.robber_hex
        ]
        # Prefer hexes with opponent buildings
        good_targets = []
        for hid in candidates:
            for iid in state.board.hex_intersections.get(hid, []):
                inter = state.board.intersections.get(iid)
                if inter and inter.building and inter.building.player_id != player_id:
                    good_targets.append(hid)
                    break
        if good_targets:
            return random.choice(good_targets)
        return random.choice(candidates) if candidates else state.robber_hex

    def choose_steal_target(self, engine: GameEngine, player_id: str) -> Optional[str]:
        """Choose a random steal target."""
        candidates = engine.state.robber_steal_candidates
        if candidates:
            return random.choice(candidates)
        return None

    def choose_monopoly_resource(self, engine: GameEngine, player_id: str) -> str:
        """Choose a resource for monopoly."""
        resources = list(engine.config.resource_types.keys())
        return random.choice(resources)

    def choose_year_of_plenty(self, engine: GameEngine, player_id: str, count: int) -> dict[str, int]:
        """Choose resources for year of plenty."""
        resources = list(engine.config.resource_types.keys())
        result: dict[str, int] = {}
        for _ in range(count):
            r = random.choice(resources)
            result[r] = result.get(r, 0) + 1
        return result

    def evaluate_trade(self, engine: GameEngine, player_id: str,
                       offering: dict[str, int], requesting: dict[str, int],
                       from_player: str) -> bool:
        """Random strategy: accept trades randomly (25% chance)."""
        # Check we can actually afford it
        player = engine.state.get_player(player_id)
        for res, amount in requesting.items():
            if player.resources.get(res, 0) < amount:
                return False
        return random.random() < 0.25


def _hex_production_value(engine: GameEngine, hid: int) -> float:
    """Score a hex by its production probability."""
    hex_tile = engine.state.board.hexes.get(hid)
    if not hex_tile or not hex_tile.number_token:
        return 0
    if hex_tile.has_robber:
        return 0
    # Dots system: probability proportional to 6 - |7 - token|
    return max(0, 6 - abs(7 - hex_tile.number_token))


def _score_intersection(engine: GameEngine, iid: int) -> float:
    """Score an intersection by total production value of adjacent hexes."""
    inter = engine.state.board.intersections.get(iid)
    if not inter:
        return 0
    return sum(_hex_production_value(engine, hid) for hid in inter.hex_ids)


class SmartStrategy(AIStrategy):
    """
    Rule-based AI that plays a reasonable game of Catan.
    Prioritizes: cities > settlements > roads toward good spots > dev cards.
    Keeps the AIStrategy interface clean for future RL replacement.
    """

    def __init__(self):
        self._fallback = RandomStrategy()

    def choose_action(self, engine: GameEngine, player_id: str) -> Optional[Action]:
        legal = engine.get_legal_actions(player_id)
        if not legal:
            return None

        by_type: dict[str, list] = {}
        for a in legal:
            by_type.setdefault(a["type"], []).append(a)

        # Must-do actions first
        for must_do in ("roll_dice", "move_robber", "steal", "discard", "dev_card_action"):
            if must_do in by_type:
                if must_do == "move_robber":
                    return self._choose_robber_action(engine, player_id, by_type[must_do])
                if must_do == "steal":
                    return self._choose_steal_action(engine, player_id, by_type[must_do])
                return self._fallback._legal_to_action(
                    random.choice(by_type[must_do]), player_id)

        # Building priority: city > settlement > road (with smarts)
        if "build" in by_type:
            builds = by_type["build"]
            cities = [a for a in builds if a.get("building_type") == "city"]
            settlements = [a for a in builds if a.get("building_type") == "settlement"]
            roads = [a for a in builds if a.get("building_type") == "road"]

            # Always build cities first (best ROI)
            if cities:
                best = max(cities, key=lambda a: _score_intersection(engine, a["location"]))
                return self._fallback._legal_to_action(best, player_id)

            # Build settlements on best production spots
            if settlements:
                best = max(settlements, key=lambda a: _score_intersection(engine, a["location"]))
                return self._fallback._legal_to_action(best, player_id)

            # Only build roads if they lead toward valid settlement spots
            if roads:
                chosen = self._choose_road(engine, player_id, roads)
                # Check if chosen road actually leads somewhere useful
                if chosen and self._road_has_value(engine, player_id, chosen):
                    return self._fallback._legal_to_action(chosen, player_id)
                # Otherwise skip road building — save resources for cities/dev cards

        # Play dev cards if beneficial (before buying more)
        if "play_dev_card" in by_type:
            chosen = random.choice(by_type["play_dev_card"])
            return self._fallback._legal_to_action(chosen, player_id)

        # Buy dev cards — good source of VP and knights
        if "buy_dev_card" in by_type:
            player = engine.state.get_player(player_id)
            total_res = sum(player.resources.values())
            # Buy if we have surplus resources or no other building options
            has_build_options = any(a.get("building_type") in ("settlement", "city")
                                   for a in by_type.get("build", []))
            if not has_build_options or total_res >= 5 or random.random() < 0.4:
                return self._fallback._legal_to_action(by_type["buy_dev_card"][0], player_id)

        # Strategic bank trading — trade surplus for what we need
        if "trade_bank" in by_type:
            trade = self._choose_bank_trade(engine, player_id, by_type["trade_bank"])
            if trade:
                return self._fallback._legal_to_action(trade, player_id)

        # Build road as last resort (if we skipped it earlier but have nothing else to do)
        if "build" in by_type:
            roads = [a for a in by_type["build"] if a.get("building_type") == "road"]
            if roads and random.random() < 0.2:
                chosen = self._choose_road(engine, player_id, roads)
                if chosen:
                    return self._fallback._legal_to_action(chosen, player_id)

        # End turn
        if "end_turn" in by_type:
            return self._fallback._legal_to_action(by_type["end_turn"][0], player_id)

        return self._fallback._legal_to_action(random.choice(legal), player_id)

    def _choose_robber_action(self, engine: GameEngine, player_id: str,
                               actions: list) -> Action:
        """Move robber to hex that hurts the leader most."""
        state = engine.state

        # Find the player with most VP (not us)
        leader = None
        leader_vp = -1
        for pid in state.player_order:
            if pid == player_id:
                continue
            vp = state.visible_vp(pid, engine.config)
            if vp > leader_vp:
                leader_vp = vp
                leader = pid

        # Prefer hexes adjacent to the leader's buildings with high production
        best_action = None
        best_score = -1
        for a in actions:
            hid = a["hex_id"]
            score = 0
            hex_tile = state.board.hexes.get(hid)
            if not hex_tile or not hex_tile.number_token:
                continue
            prod = max(0, 6 - abs(7 - hex_tile.number_token))
            for iid in state.board.hex_intersections.get(hid, []):
                inter = state.board.intersections.get(iid)
                if inter and inter.building:
                    if inter.building.player_id == leader:
                        score += prod * 2
                    elif inter.building.player_id != player_id:
                        score += prod
            if score > best_score:
                best_score = score
                best_action = a

        if best_action:
            return self._fallback._legal_to_action(best_action, player_id)
        return self._fallback._legal_to_action(random.choice(actions), player_id)

    def _choose_steal_action(self, engine: GameEngine, player_id: str,
                              actions: list) -> Action:
        """Steal from player with most resources."""
        best = None
        most_res = -1
        for a in actions:
            target = a["target_player"]
            res_count = sum(engine.state.players[target].resources.values())
            if res_count > most_res:
                most_res = res_count
                best = a
        if best:
            return self._fallback._legal_to_action(best, player_id)
        return self._fallback._legal_to_action(random.choice(actions), player_id)

    def _choose_road(self, engine: GameEngine, player_id: str, roads: list) -> dict:
        """Build road toward the best unoccupied intersection."""
        state = engine.state
        board = state.board

        # Score each road by the quality of intersections it leads toward
        best = None
        best_score = -1
        for a in roads:
            eid = a["location"]
            edge = board.edges.get(eid)
            if not edge:
                continue
            ia, ib = edge.intersection_ids
            # Score = best adjacent open intersection production
            score = 0
            for iid in (ia, ib):
                inter = board.intersections.get(iid)
                if not inter:
                    continue
                if inter.building:
                    continue  # Already built
                # Check distance rule — any adjacent building?
                too_close = False
                for adj in board.adjacent_intersections.get(iid, []):
                    adj_inter = board.intersections.get(adj)
                    if adj_inter and adj_inter.building:
                        too_close = True
                        break
                if too_close:
                    continue
                score = max(score, _score_intersection(engine, iid))
            if score > best_score:
                best_score = score
                best = a

        return best or random.choice(roads)

    def _choose_bank_trade(self, engine: GameEngine, player_id: str,
                            trades: list) -> Optional[dict]:
        """Choose a bank trade that helps us toward a goal (dev card or city)."""
        player = engine.state.get_player(player_id)

        # Determine what we need most — prioritize city, then dev card, then settlement
        goals = [
            {"ore": 3, "grain": 2},           # city
            {"ore": 1, "grain": 1, "wool": 1},  # dev card
            {"brick": 1, "lumber": 1, "grain": 1, "wool": 1},  # settlement
        ]

        for goal in goals:
            # Find resources we're missing for this goal
            missing = {}
            for res, need in goal.items():
                deficit = need - player.resources.get(res, 0)
                if deficit > 0:
                    missing[res] = deficit

            if not missing:
                continue  # We can already afford this, skip

            # Find trades that give us a missing resource
            for want_res in missing:
                matching = [t for t in trades if t["want_resource"] == want_res]
                if matching:
                    # Prefer trading away resources we have the most of
                    best_trade = max(matching,
                                     key=lambda t: player.resources.get(t["give_resource"], 0))
                    return best_trade

        return None

    def _road_has_value(self, engine: GameEngine, player_id: str, road_action: dict) -> bool:
        """Check if building a road leads toward a valid, reachable settlement spot."""
        state = engine.state
        board = state.board
        player = state.get_player(player_id)

        # If we already have max roads, no value
        road_count = player.buildings_placed.get("road", 0)
        if road_count >= 13:  # Save last couple roads for when we find a spot
            return False

        eid = road_action["location"]
        edge = board.edges.get(eid)
        if not edge:
            return False

        # Check if either endpoint is a valid settlement spot (or leads toward one
        # within 2 hops)
        ia, ib = edge.intersection_ids
        for start_iid in (ia, ib):
            if self._has_nearby_settlement_spot(engine, player_id, start_iid, depth=2):
                return True

        return False

    def _has_nearby_settlement_spot(self, engine: GameEngine, player_id: str,
                                     start_iid: int, depth: int) -> bool:
        """BFS to find a valid settlement spot within `depth` hops."""
        board = engine.state.board
        visited = {start_iid}
        frontier = [start_iid]

        for _ in range(depth):
            next_frontier = []
            for iid in frontier:
                for adj_iid in board.adjacent_intersections.get(iid, []):
                    if adj_iid in visited:
                        continue
                    visited.add(adj_iid)
                    inter = board.intersections.get(adj_iid)
                    if not inter:
                        continue
                    # Check if this is a valid settlement spot
                    if inter.building is not None:
                        continue  # Occupied
                    # Distance rule: no adjacent buildings
                    too_close = False
                    for neighbor_iid in board.adjacent_intersections.get(adj_iid, []):
                        neighbor = board.intersections.get(neighbor_iid)
                        if neighbor and neighbor.building is not None:
                            too_close = True
                            break
                    if not too_close:
                        return True  # Found a valid spot
                    next_frontier.append(adj_iid)
            frontier = next_frontier

        return False

    def choose_discard(self, engine: GameEngine, player_id: str, count: int) -> dict[str, int]:
        """Discard resources we have the most of, keeping diverse ones."""
        player = engine.state.get_player(player_id)
        resources = []
        for res_id, amount in player.resources.items():
            resources.extend([res_id] * amount)
        # Sort by count descending so we discard from our biggest pile
        resources.sort(key=lambda r: -player.resources.get(r, 0))
        to_discard = resources[:count]
        result: dict[str, int] = {}
        for r in to_discard:
            result[r] = result.get(r, 0) + 1
        return result

    def choose_robber_hex(self, engine: GameEngine, player_id: str) -> int:
        return self._fallback.choose_robber_hex(engine, player_id)

    def choose_steal_target(self, engine: GameEngine, player_id: str) -> Optional[str]:
        return self._fallback.choose_steal_target(engine, player_id)

    def choose_monopoly_resource(self, engine: GameEngine, player_id: str) -> str:
        """Choose the resource opponents have the most of."""
        state = engine.state
        totals: dict[str, int] = {}
        for pid, p in state.players.items():
            if pid == player_id:
                continue
            for res, amt in p.resources.items():
                totals[res] = totals.get(res, 0) + amt
        if totals:
            return max(totals, key=totals.get)
        return random.choice(list(engine.config.resource_types.keys()))

    def choose_year_of_plenty(self, engine: GameEngine, player_id: str, count: int) -> dict[str, int]:
        """Choose resources we're closest to being able to build with."""
        player = engine.state.get_player(player_id)
        # Find what we need most for city (ore, grain) or settlement
        needs: dict[str, int] = {}
        # Try to complete a city first
        city_cost = {"ore": 3, "grain": 2}
        for res, need in city_cost.items():
            deficit = need - player.resources.get(res, 0)
            if deficit > 0:
                needs[res] = deficit
        # If city needs are small, fill those
        if sum(needs.values()) <= count and needs:
            result: dict[str, int] = {}
            remaining = count
            for res, deficit in sorted(needs.items(), key=lambda x: -x[1]):
                take = min(deficit, remaining)
                if take > 0:
                    result[res] = take
                    remaining -= take
            # Fill remaining with something useful
            if remaining > 0:
                for res in engine.config.resource_types:
                    if remaining <= 0:
                        break
                    result[res] = result.get(res, 0) + 1
                    remaining -= 1
            return result
        # Otherwise pick what we have least of
        resources = sorted(engine.config.resource_types.keys(),
                          key=lambda r: player.resources.get(r, 0))
        result: dict[str, int] = {}
        for i in range(count):
            r = resources[i % len(resources)]
            result[r] = result.get(r, 0) + 1
        return result

    def evaluate_trade(self, engine: GameEngine, player_id: str,
                       offering: dict[str, int], requesting: dict[str, int],
                       from_player: str) -> bool:
        """Accept trade if we get more total value than we give."""
        player = engine.state.get_player(player_id)
        # Can we even afford it?
        for res, amount in requesting.items():
            if player.resources.get(res, 0) < amount:
                return False
        # Simple heuristic: accept if we get more cards than we give
        give_total = sum(requesting.values())
        get_total = sum(offering.values())
        if get_total > give_total:
            return True
        if get_total == give_total:
            return random.random() < 0.4
        return False
