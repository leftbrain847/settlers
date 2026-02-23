"""
Game engine — the core orchestrator.

Ties together config, state, actions, and handlers.
Manages game lifecycle: lobby -> setup -> playing -> finished.
"""

from __future__ import annotations

import random
import uuid
from typing import Any, Optional

from .config import GameConfig
from .state import GameState, GamePhase, PlayerState
from .board import generate_board
from .actions import Action, ActionResult, get_validator, get_handler

# Ensure handlers are registered by importing the module
from . import handlers as _handlers_module


PLAYER_COLORS = ["#e74c3c", "#3498db", "#ecf0f1", "#f39c12", "#9b59b6", "#1abc9c"]


class GameEngine:
    """
    Core game engine. Processes actions against a game config and state.

    Usage:
        config = load_base_game()
        engine = GameEngine(config)
        engine.add_player("Alice")
        engine.add_player("Bob")
        engine.start_game()

        result = engine.do_action(Action(type="roll_dice", player_id="p1"))
    """

    def __init__(self, config: GameConfig):
        self.config = config
        self.state = GameState(game_id=str(uuid.uuid4())[:8], config_name=config.name)
        self._action_log: list[Action] = []

    # -------------------------------------------------------------------
    # Lobby management
    # -------------------------------------------------------------------

    def add_player(self, name: str, player_id: Optional[str] = None, is_ai: bool = False) -> str:
        if self.state.phase != GamePhase.LOBBY:
            raise ValueError("Can only add players in lobby phase")
        if len(self.state.players) >= self.config.setup_rules.max_players:
            raise ValueError("Maximum players reached")

        pid = player_id or f"p{len(self.state.players) + 1}"
        color_idx = len(self.state.players) % len(PLAYER_COLORS)
        player = PlayerState(
            id=pid,
            name=name,
            color=PLAYER_COLORS[color_idx],
        )
        # Initialize resource counts to 0
        for res_id in self.config.resource_types:
            player.resources[res_id] = 0

        self.state.players[pid] = player
        self.state.player_order.append(pid)
        self.state.add_log("player_joined", player=pid, name=name, is_ai=is_ai)
        return pid

    def remove_player(self, player_id: str):
        if self.state.phase != GamePhase.LOBBY:
            raise ValueError("Can only remove players in lobby phase")
        if player_id in self.state.players:
            del self.state.players[player_id]
            self.state.player_order.remove(player_id)

    # -------------------------------------------------------------------
    # Game start
    # -------------------------------------------------------------------

    def start_game(self, seed: Optional[int] = None) -> list[dict[str, Any]]:
        if self.state.phase != GamePhase.LOBBY:
            raise ValueError("Game already started")
        if len(self.state.players) < self.config.setup_rules.min_players:
            raise ValueError(f"Need at least {self.config.setup_rules.min_players} players")

        events = []

        # Generate board
        board, desert_hex = generate_board(self.config, seed=seed)
        self.state.board = board
        self.state.robber_hex = desert_hex

        # Shuffle dev card deck
        deck = []
        for dc_id, dc in self.config.dev_card_types.items():
            deck.extend([dc_id] * dc.count_in_deck)
        random.shuffle(deck)
        self.state.dev_card_deck = deck

        # Start setup phase
        self.state.phase = GamePhase.SETUP
        self.state.setup_round = 0
        self.state.setup_player_idx = 0
        self.state.setup_forward = True

        events.append({"type": "game_started", "players": list(self.state.player_order)})
        events.append({"type": "setup_turn", "player": self.state.player_order[0], "round": 0})
        self.state.add_log("game_started")

        return events

    # -------------------------------------------------------------------
    # Action processing
    # -------------------------------------------------------------------

    def do_action(self, action: Action) -> ActionResult:
        """Validate and execute an action."""
        # Validate
        validator = get_validator(action.type)
        if validator:
            valid, error = validator(self.state, self.config, action)
            if not valid:
                return ActionResult(success=False, state=self.state, error=error)

        # Execute
        handler = get_handler(action.type)
        if not handler:
            return ActionResult(success=False, state=self.state, error=f"Unknown action: {action.type}")

        events = handler(self.state, self.config, action.player_id, action.params)
        self._action_log.append(action)

        # Post-action checks
        post_events = self._post_action(action)
        events.extend(post_events)

        return ActionResult(success=True, state=self.state, events=events)

    def _post_action(self, action: Action) -> list[dict]:
        """Run after every action: check win conditions, update achievements, advance setup."""
        events = []

        # Advance setup phase if needed
        if self.state.phase == GamePhase.SETUP:
            events.extend(self._advance_setup(action))
            return events

        # Update achievements (longest road, largest army)
        events.extend(self._update_achievements())

        # Check win conditions
        events.extend(self._check_win_conditions())

        return events

    # -------------------------------------------------------------------
    # Setup phase management
    # -------------------------------------------------------------------

    def _advance_setup(self, action: Action) -> list[dict]:
        """Advance setup state after a build action."""
        events = []
        if action.type != "build":
            return events

        setup = self.config.setup_rules

        # Each player places 1 settlement + 1 road per round
        if self.state.setup_settlements_placed >= 1 and self.state.setup_roads_placed >= 1:
            # This player is done for this round
            self.state.setup_settlements_placed = 0
            self.state.setup_roads_placed = 0

            # Advance to next player
            if setup.placement_order == "forward_reverse":
                events.extend(self._advance_setup_forward_reverse())
            else:
                # Simple forward
                self.state.setup_player_idx += 1
                if self.state.setup_player_idx >= len(self.state.player_order):
                    self.state.setup_round += 1
                    self.state.setup_player_idx = 0

            # Check if setup is complete
            if self.state.setup_round >= setup.initial_placements:
                self.state.phase = GamePhase.PLAYING
                self.state.current_player_idx = 0
                self.state.turn_number = 1
                events.append({"type": "setup_complete"})
                events.append({"type": "turn_started", "player": self.state.current_player_id})
                self.state.add_log("setup_complete")
            else:
                current_pid = self.state.player_order[self.state.setup_player_idx]
                events.append({"type": "setup_turn", "player": current_pid, "round": self.state.setup_round})

        return events

    def _advance_setup_forward_reverse(self) -> list[dict]:
        """Advance in 1,2,3,4,4,3,2,1 pattern."""
        events = []
        n = len(self.state.player_order)

        if self.state.setup_round == 0:
            # Forward pass
            self.state.setup_player_idx += 1
            if self.state.setup_player_idx >= n:
                # Switch to reverse pass (round 1, starting with last player)
                self.state.setup_round = 1
                self.state.setup_player_idx = n - 1
        elif self.state.setup_round == 1:
            # Reverse pass
            self.state.setup_player_idx -= 1
            if self.state.setup_player_idx < 0:
                # Setup complete
                self.state.setup_round = 2  # signals completion

        return events

    # -------------------------------------------------------------------
    # Achievements
    # -------------------------------------------------------------------

    def _update_achievements(self) -> list[dict]:
        """Recalculate achievements (longest road, largest army)."""
        events = []

        for ach_id, ach in self.config.achievements.items():
            if ach.metric == "road_length":
                events.extend(self._update_road_achievement(ach))
            elif ach.metric == "knight_count":
                events.extend(self._update_knight_achievement(ach))

        return events

    def _update_road_achievement(self, ach) -> list[dict]:
        events = []
        current_holder = None
        current_max = ach.min_value - 1

        # Find current holder
        for pid, player in self.state.players.items():
            if ach.id in player.achievements:
                current_holder = pid
                break

        # Calculate road lengths
        best_player = None
        best_length = current_max

        for pid in self.state.players:
            length = self._calculate_road_length(pid)
            if length > best_length:
                best_length = length
                best_player = pid

        # Update holder
        if best_player and best_player != current_holder:
            if current_holder:
                self.state.players[current_holder].achievements.remove(ach.id)
                events.append({"type": "achievement_lost", "player": current_holder, "achievement": ach.id})
            self.state.players[best_player].achievements.append(ach.id)
            events.append({"type": "achievement_gained", "player": best_player, "achievement": ach.id, "value": best_length})

        return events

    def _update_knight_achievement(self, ach) -> list[dict]:
        events = []
        current_holder = None

        for pid, player in self.state.players.items():
            if ach.id in player.achievements:
                current_holder = pid
                break

        best_player = None
        best_count = ach.min_value - 1

        for pid, player in self.state.players.items():
            count = sum(1 for c in player.played_dev_cards
                       if self.config.dev_card_types.get(c, None) and
                       self.config.dev_card_types[c].persistent_tag == "knight")
            if count > best_count:
                best_count = count
                best_player = pid

        if best_player and best_player != current_holder:
            if current_holder:
                self.state.players[current_holder].achievements.remove(ach.id)
                events.append({"type": "achievement_lost", "player": current_holder, "achievement": ach.id})
            self.state.players[best_player].achievements.append(ach.id)
            events.append({"type": "achievement_gained", "player": best_player, "achievement": ach.id, "value": best_count})

        return events

    def _calculate_road_length(self, player_id: str) -> int:
        """Calculate the longest contiguous road for a player using DFS."""
        # Build adjacency graph of player's roads
        player_edges = []
        for eid, edge in self.state.board.edges.items():
            if edge.building and edge.building.player_id == player_id:
                player_edges.append(edge)

        if not player_edges:
            return 0

        # Build graph: intersection -> list of connected intersections via this player's roads
        graph: dict[int, list[int]] = {}
        for edge in player_edges:
            a, b = edge.intersection_ids
            graph.setdefault(a, []).append(b)
            graph.setdefault(b, []).append(a)

        # Find intersections blocked by opponent buildings
        blocked = set()
        for iid, inter in self.state.board.intersections.items():
            if inter.building and inter.building.player_id != player_id:
                blocked.add(iid)

        # DFS from each node to find longest path
        max_length = 0

        def dfs(node: int, visited_edges: set, length: int):
            nonlocal max_length
            max_length = max(max_length, length)
            for neighbor in graph.get(node, []):
                edge_key = (min(node, neighbor), max(node, neighbor))
                if edge_key in visited_edges:
                    continue
                if neighbor in blocked:
                    # Can use the edge but can't continue through
                    max_length = max(max_length, length + 1)
                    continue
                visited_edges.add(edge_key)
                dfs(neighbor, visited_edges, length + 1)
                visited_edges.remove(edge_key)

        for start_node in graph:
            dfs(start_node, set(), 0)

        return max_length

    # -------------------------------------------------------------------
    # Win condition checking
    # -------------------------------------------------------------------

    def _check_win_conditions(self) -> list[dict]:
        events = []
        for wc in self.config.win_conditions:
            if wc.type == "vp_threshold":
                threshold = wc.params.get("threshold", 10)
                # Check current player first (they win on their turn)
                pid = self.state.current_player_id
                if pid:
                    vp = self.state.visible_vp(pid, self.config)
                    if vp >= threshold:
                        self.state.phase = GamePhase.FINISHED
                        self.state.winner = pid
                        events.append({"type": "game_won", "player": pid, "vp": vp})
                        self.state.add_log("game_won", player=pid, vp=vp)
                        break
        return events

    # -------------------------------------------------------------------
    # Query helpers
    # -------------------------------------------------------------------

    def get_legal_actions(self, player_id: str) -> list[dict]:
        """Get all legal actions for a player in the current state."""
        legal = []

        if self.state.phase == GamePhase.SETUP:
            legal.extend(self._get_setup_legal_actions(player_id))
            return legal

        if self.state.phase != GamePhase.PLAYING:
            return legal

        # Pending discards
        if player_id in self.state.pending_discards:
            legal.append({"type": "discard", "count": self.state.pending_discards[player_id]})
            return legal

        if player_id != self.state.current_player_id:
            # Other players can only respond to trade offers
            for tid, offer in self.state.trade_offers.items():
                if offer.from_player != player_id:
                    legal.append({"type": "trade_accept", "trade_id": tid})
            return legal

        # Pending robber
        if self.state.pending_robber_move:
            for hid in self.state.board.hexes:
                if hid != self.state.robber_hex or not self.config.robber.must_move:
                    legal.append({"type": "move_robber", "hex_id": hid})
            return legal

        if self.state.pending_robber_steal:
            for target in self.state.robber_steal_candidates:
                legal.append({"type": "steal", "target_player": target})
            return legal

        # Pending dev card action
        if self.state.pending_action:
            pa = self.state.pending_action
            if pa["type"] == "build_free_roads":
                # Provide specific legal edge locations for free road placement
                road_type = None
                for bt_id, bt in self.config.building_types.items():
                    if bt.counts_as_road:
                        road_type = bt
                        break
                if road_type:
                    # Check if player has reached max roads
                    player = self.state.get_player(player_id)
                    placed = player.buildings_placed.get(road_type.id, 0)
                    if placed >= road_type.max_per_player:
                        # No more roads can be placed — skip
                        legal.append({"type": "dev_card_action", "location": -1, "skip": True})
                        return legal
                    for eid, edge in self.state.board.edges.items():
                        if edge.building:
                            continue
                        # Check road connectivity
                        a, b = edge.intersection_ids
                        connected = False
                        for iid in (a, b):
                            inter = self.state.board.intersections.get(iid)
                            if inter and inter.building and inter.building.player_id == player_id:
                                connected = True
                                break
                            for adj_eid in self.state.board.intersection_edges.get(iid, []):
                                if adj_eid == eid:
                                    continue
                                adj_edge = self.state.board.edges.get(adj_eid)
                                if adj_edge and adj_edge.building and adj_edge.building.player_id == player_id:
                                    if inter and inter.building and inter.building.player_id != player_id:
                                        continue
                                    connected = True
                                    break
                            if connected:
                                break
                        if connected:
                            legal.append({"type": "dev_card_action", "location": eid})
                    # If no legal road locations, allow skip
                    if not legal:
                        legal.append({"type": "dev_card_action", "location": -1, "skip": True})
            elif pa["type"] == "choose_monopoly_resource":
                for res_id in self.config.resource_types:
                    legal.append({"type": "dev_card_action", "resource": res_id})
            elif pa["type"] == "choose_resources":
                # Year of Plenty — provide a generic action, params filled by UI/AI
                legal.append({"type": "dev_card_action", "pending": pa})
            else:
                legal.append({"type": "dev_card_action", "pending": pa})
            return legal

        # Normal turn
        if not self.state.dice_rolled:
            legal.append({"type": "roll_dice"})
            # Can play dev card before rolling
            player = self.state.get_player(player_id)
            if not player.has_played_dev_card_this_turn:
                for card in set(player.dev_cards):
                    dc = self.config.dev_card_types.get(card)
                    if dc and dc.playable and not dc.is_victory_point:
                        legal.append({"type": "play_dev_card", "card_type": card})
            return legal

        # After rolling
        legal.append({"type": "end_turn"})

        # Building
        player = self.state.get_player(player_id)
        for bt_id, bt in self.config.building_types.items():
            if bt_id == "dev_card":
                # Buy dev card
                can_afford = all(
                    player.resources.get(r, 0) >= a for r, a in bt.cost.items()
                )
                if can_afford and self.state.dev_card_deck:
                    legal.append({"type": "buy_dev_card"})
                continue

            placed = player.buildings_placed.get(bt_id, 0)
            if placed >= bt.max_per_player:
                continue
            can_afford = all(
                player.resources.get(r, 0) >= a for r, a in bt.cost.items()
            )
            if not can_afford:
                continue

            # Find valid locations
            if bt.placement.location_type == "intersection":
                for iid, inter in self.state.board.intersections.items():
                    test_action = Action(type="build", player_id=player_id,
                                        params={"building_type": bt_id, "location": iid})
                    valid, _ = get_validator("build")(self.state, self.config, test_action)
                    if valid:
                        legal.append({"type": "build", "building_type": bt_id, "location": iid})
            elif bt.placement.location_type == "edge":
                for eid in self.state.board.edges:
                    test_action = Action(type="build", player_id=player_id,
                                        params={"building_type": bt_id, "location": eid})
                    valid, _ = get_validator("build")(self.state, self.config, test_action)
                    if valid:
                        legal.append({"type": "build", "building_type": bt_id, "location": eid})

        # Bank trading
        if self.config.trade_rules.bank_trading_enabled:
            for give_res in self.config.resource_types:
                ratio = self.config.trade_rules.default_bank_ratio
                for port_id in player.ports:
                    pt = self.config.port_types.get(port_id)
                    if pt:
                        if pt.resource is None:
                            ratio = min(ratio, pt.ratio)
                        elif pt.resource == give_res:
                            ratio = min(ratio, pt.ratio)
                if player.resources.get(give_res, 0) >= ratio:
                    for want_res in self.config.resource_types:
                        if want_res != give_res:
                            legal.append({"type": "trade_bank", "give_resource": give_res, "want_resource": want_res})

        # Player trading
        if self.config.trade_rules.player_trading_enabled:
            legal.append({"type": "trade_offer"})

        # Dev cards
        if not player.has_played_dev_card_this_turn:
            for card in set(player.dev_cards):
                dc = self.config.dev_card_types.get(card)
                if dc and dc.playable and not dc.is_victory_point:
                    legal.append({"type": "play_dev_card", "card_type": card})

        return legal

    def _get_setup_legal_actions(self, player_id: str) -> list[dict]:
        """Get legal actions during setup."""
        legal = []
        expected = self.state.player_order[self.state.setup_player_idx]
        if player_id != expected:
            return legal

        if self.state.setup_settlements_placed < 1:
            # Need to place a settlement
            settlement_type = None
            for bt_id, bt in self.config.building_types.items():
                if bt.placement.location_type == "intersection" and not bt.placement.upgrades_from:
                    settlement_type = bt_id
                    break
            if settlement_type:
                bt = self.config.building_types[settlement_type]
                for iid, inter in self.state.board.intersections.items():
                    if inter.building is not None:
                        continue
                    # Distance rule
                    too_close = False
                    if bt.placement.distance_rule > 0:
                        for adj_iid in self.state.board.adjacent_intersections.get(iid, []):
                            adj = self.state.board.intersections.get(adj_iid)
                            if adj and adj.building is not None:
                                too_close = True
                                break
                    if not too_close:
                        legal.append({"type": "build", "building_type": settlement_type, "location": iid})

        elif self.state.setup_roads_placed < 1:
            # Need to place a road adjacent to last settlement
            road_type = None
            for bt_id, bt in self.config.building_types.items():
                if bt.counts_as_road:
                    road_type = bt_id
                    break
            if road_type:
                # Use the tracked last settlement placement
                last_settlement_iid = self.state.setup_last_settlement

                if last_settlement_iid is not None:
                    for eid in self.state.board.intersection_edges.get(last_settlement_iid, []):
                        edge = self.state.board.edges.get(eid)
                        if edge and edge.building is None:
                            legal.append({"type": "build", "building_type": road_type, "location": eid})

        return legal

    # -------------------------------------------------------------------
    # State serialization
    # -------------------------------------------------------------------

    def get_state_for_player(self, player_id: str) -> dict:
        """Get game state visible to a specific player (hides other players' dev cards)."""
        s = self.state
        data = {
            "game_id": s.game_id,
            "phase": s.phase.value,
            "config_name": s.config_name,
            "turn_number": s.turn_number,
            "current_player": s.current_player_id,
            "dice_rolled": s.dice_rolled,
            "last_roll": list(s.last_roll) if s.last_roll else None,
            "robber_hex": s.robber_hex,
            "pending_robber_move": s.pending_robber_move,
            "pending_robber_steal": s.pending_robber_steal,
            "robber_steal_candidates": s.robber_steal_candidates,
            "pending_discards": s.pending_discards,
            "pending_action": s.pending_action,
            "winner": s.winner,
            "dev_cards_remaining": len(s.dev_card_deck),
            "player_order": s.player_order,
            "setup": {
                "round": s.setup_round,
                "player_idx": s.setup_player_idx,
                "settlements_placed": s.setup_settlements_placed,
                "roads_placed": s.setup_roads_placed,
            },
        }

        # Board
        data["board"] = {
            "hexes": {str(hid): {
                "id": h.id, "terrain": h.terrain, "number_token": h.number_token,
                "has_robber": h.has_robber, "q": h.q, "r": h.r,
            } for hid, h in s.board.hexes.items()},
            "intersections": {str(iid): {
                "id": i.id, "hex_ids": i.hex_ids,
                "building": {"type": i.building.building_type, "player": i.building.player_id} if i.building else None,
                "port": i.port, "q": i.q, "r": i.r,
            } for iid, i in s.board.intersections.items()},
            "edges": {str(eid): {
                "id": e.id, "intersections": list(e.intersection_ids),
                "building": {"type": e.building.building_type, "player": e.building.player_id} if e.building else None,
            } for eid, e in s.board.edges.items()},
            "hex_intersections": {str(k): v for k, v in s.board.hex_intersections.items()},
        }

        # Players
        data["players"] = {}
        for pid, p in s.players.items():
            pdata = {
                "id": p.id, "name": p.name, "color": p.color,
                "buildings_placed": p.buildings_placed,
                "achievements": p.achievements,
                "played_dev_cards": p.played_dev_cards,
                "ports": p.ports,
            }
            if pid == player_id:
                pdata["resources"] = p.resources
                pdata["dev_cards"] = p.dev_cards
                pdata["hidden_vp"] = p.hidden_vp
            else:
                pdata["resource_count"] = sum(p.resources.values())
                pdata["dev_card_count"] = len(p.dev_cards)
            # Show full VP (including hidden dev card VP) only to the player themselves
            pdata["vp"] = s.visible_vp(pid, self.config, include_hidden=(pid == player_id))
            data["players"][pid] = pdata

        # Trade offers
        data["trade_offers"] = {
            tid: {
                "id": t.id, "from_player": t.from_player,
                "offering": t.offering, "requesting": t.requesting,
            } for tid, t in s.trade_offers.items()
        }

        # Recent log
        data["log"] = s.log[-20:]

        return data
