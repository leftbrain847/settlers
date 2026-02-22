"""
AI player strategies.

Each strategy is a function that takes (engine, player_id) and returns
an Action to perform. The engine doesn't care if an action comes from
a human or an AI — it's all the same.

To create a custom AI: define a function with the same signature.
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


class SmartStrategy(AIStrategy):
    """
    Slightly smarter AI that considers game state.
    Placeholder for future enhancement.
    """

    def __init__(self):
        self._fallback = RandomStrategy()

    def choose_action(self, engine: GameEngine, player_id: str) -> Optional[Action]:
        legal = engine.get_legal_actions(player_id)
        if not legal:
            return None

        # Group by type
        by_type: dict[str, list] = {}
        for a in legal:
            by_type.setdefault(a["type"], []).append(a)

        # If can build a city, do it
        if "build" in by_type:
            cities = [a for a in by_type["build"] if a.get("building_type") == "city"]
            if cities:
                chosen = random.choice(cities)
                return self._fallback._legal_to_action(chosen, player_id)

            settlements = [a for a in by_type["build"] if a.get("building_type") == "settlement"]
            if settlements:
                chosen = random.choice(settlements)
                return self._fallback._legal_to_action(chosen, player_id)

        return self._fallback.choose_action(engine, player_id)

    def choose_discard(self, engine: GameEngine, player_id: str, count: int) -> dict[str, int]:
        return self._fallback.choose_discard(engine, player_id, count)
