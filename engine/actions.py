"""
Action definitions and processing.

Every game mutation flows through the action system:
1. Player submits an Action
2. Engine validates preconditions
3. Engine applies effects (state mutations)
4. Engine returns the updated state + events
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

from .config import GameConfig
from .state import GameState, GamePhase


@dataclass
class Action:
    """A player action."""
    type: str
    player_id: str
    params: dict[str, Any] = field(default_factory=dict)


@dataclass
class ActionResult:
    """Result of processing an action."""
    success: bool
    state: GameState
    error: Optional[str] = None
    events: list[dict[str, Any]] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Action validator registry
# ---------------------------------------------------------------------------

# Map of action_type -> validator function
# Each validator returns (is_valid, error_message)
_validators: dict[str, Any] = {}


def validator(action_type: str):
    """Decorator to register an action validator."""
    def decorator(fn):
        _validators[action_type] = fn
        return fn
    return decorator


def get_validator(action_type: str):
    return _validators.get(action_type)


# ---------------------------------------------------------------------------
# Action handler registry
# ---------------------------------------------------------------------------

_handlers: dict[str, Any] = {}


def handler(action_type: str):
    """Decorator to register an action handler."""
    def decorator(fn):
        _handlers[action_type] = fn
        return fn
    return decorator


def get_handler(action_type: str):
    return _handlers.get(action_type)


# ---------------------------------------------------------------------------
# Core validators
# ---------------------------------------------------------------------------

@validator("roll_dice")
def validate_roll_dice(state: GameState, config: GameConfig, action: Action) -> tuple[bool, str]:
    if state.phase != GamePhase.PLAYING:
        return False, "Game is not in playing phase"
    if action.player_id != state.current_player_id:
        return False, "Not your turn"
    if state.dice_rolled:
        return False, "Dice already rolled this turn"
    if state.pending_discards:
        return False, "Waiting for players to discard"
    if state.pending_robber_move:
        return False, "Must move robber first"
    return True, ""


@validator("build")
def validate_build(state: GameState, config: GameConfig, action: Action) -> tuple[bool, str]:
    if state.phase == GamePhase.SETUP:
        return _validate_setup_build(state, config, action)

    if state.phase != GamePhase.PLAYING:
        return False, "Game is not in playing phase"
    if action.player_id != state.current_player_id:
        return False, "Not your turn"
    if not state.dice_rolled:
        return False, "Must roll dice first"
    if state.pending_discards:
        return False, "Waiting for players to discard"
    if state.pending_robber_move or state.pending_robber_steal:
        return False, "Must resolve robber first"

    building_type_id = action.params.get("building_type")
    bt = config.building_types.get(building_type_id)
    if not bt:
        return False, f"Unknown building type: {building_type_id}"

    player = state.get_player(action.player_id)

    # Check max per player
    placed = player.buildings_placed.get(building_type_id, 0)
    if placed >= bt.max_per_player:
        return False, f"Maximum {bt.name}s reached ({bt.max_per_player})"

    # Check cost
    for res_id, amount in bt.cost.items():
        if player.resources.get(res_id, 0) < amount:
            return False, f"Not enough {res_id} (need {amount}, have {player.resources.get(res_id, 0)})"

    # Check placement
    location = action.params.get("location")
    if location is None:
        return False, "No location specified"

    valid, msg = _validate_placement(state, config, action.player_id, bt, location)
    if not valid:
        return False, msg

    return True, ""


def _validate_setup_build(state: GameState, config: GameConfig, action: Action) -> tuple[bool, str]:
    """Validate building during setup phase."""
    building_type_id = action.params.get("building_type")
    bt = config.building_types.get(building_type_id)
    if not bt:
        return False, f"Unknown building type: {building_type_id}"

    expected_player = state.player_order[state.setup_player_idx]
    if action.player_id != expected_player:
        return False, "Not your turn in setup"

    location = action.params.get("location")
    if location is None:
        return False, "No location specified"

    # During setup, check placement rules but skip cost and road-connection requirements
    if bt.placement.location_type == "intersection":
        iid = location
        intersection = state.board.intersections.get(iid)
        if not intersection:
            return False, "Invalid intersection"
        if intersection.building is not None:
            return False, "Intersection already occupied"
        # Distance rule — no adjacent settlements
        if bt.placement.distance_rule > 0:
            for adj_iid in state.board.adjacent_intersections.get(iid, []):
                adj = state.board.intersections.get(adj_iid)
                if adj and adj.building is not None:
                    return False, "Too close to another building"
    elif bt.placement.location_type == "edge":
        eid = location
        edge = state.board.edges.get(eid)
        if not edge:
            return False, "Invalid edge"
        if edge.building is not None:
            return False, "Edge already occupied"
        # During setup, road must be adjacent to the just-placed settlement
        # This is enforced at the handler level
    return True, ""


def _validate_placement(state: GameState, config: GameConfig, player_id: str,
                         bt, location: int) -> tuple[bool, str]:
    """Validate building placement rules (non-setup)."""
    placement = bt.placement

    if placement.location_type == "intersection":
        intersection = state.board.intersections.get(location)
        if not intersection:
            return False, "Invalid intersection"

        # Check if upgrading
        if placement.upgrades_from:
            if not intersection.building:
                return False, f"Must upgrade from {placement.upgrades_from}"
            if intersection.building.building_type != placement.upgrades_from:
                return False, f"Must upgrade from {placement.upgrades_from}"
            if intersection.building.player_id != player_id:
                return False, "Can only upgrade your own buildings"
            return True, ""

        if placement.must_be_empty and intersection.building is not None:
            return False, "Intersection already occupied"

        # Distance rule
        if placement.distance_rule > 0:
            for adj_iid in state.board.adjacent_intersections.get(location, []):
                adj = state.board.intersections.get(adj_iid)
                if adj and adj.building is not None:
                    return False, "Too close to another building"

        # Road connection required
        if placement.requires_connected_road:
            has_road = False
            for eid in state.board.intersection_edges.get(location, []):
                edge = state.board.edges.get(eid)
                if edge and edge.building and edge.building.player_id == player_id:
                    has_road = True
                    break
            if not has_road:
                return False, "Must be connected to your road network"

    elif placement.location_type == "edge":
        edge = state.board.edges.get(location)
        if not edge:
            return False, "Invalid edge"
        if placement.must_be_empty and edge.building is not None:
            return False, "Edge already occupied"

        # Road must connect to player's existing network
        a, b = edge.intersection_ids
        connected = False
        for iid in (a, b):
            # Connected if player has a building at either end
            inter = state.board.intersections.get(iid)
            if inter and inter.building and inter.building.player_id == player_id:
                connected = True
                break
            # Or if player has a road on an adjacent edge
            for adj_eid in state.board.intersection_edges.get(iid, []):
                if adj_eid == location:
                    continue
                adj_edge = state.board.edges.get(adj_eid)
                if adj_edge and adj_edge.building and adj_edge.building.player_id == player_id:
                    # Check that the shared intersection doesn't have an opponent's building
                    if inter and inter.building and inter.building.player_id != player_id:
                        continue  # blocked by opponent's building
                    connected = True
                    break
            if connected:
                break

        if not connected:
            return False, "Road must connect to your network"

    return True, ""


@validator("buy_dev_card")
def validate_buy_dev_card(state: GameState, config: GameConfig, action: Action) -> tuple[bool, str]:
    if state.phase != GamePhase.PLAYING:
        return False, "Game is not in playing phase"
    if action.player_id != state.current_player_id:
        return False, "Not your turn"
    if not state.dice_rolled:
        return False, "Must roll dice first"
    if not state.dev_card_deck:
        return False, "No development cards left"

    # Find dev card cost from config — look for a special "dev_card" pseudo-building cost
    # or define it in trade_rules. For flexibility, we store it in building_types as "dev_card".
    dev_cost = config.building_types.get("dev_card")
    if dev_cost:
        player = state.get_player(action.player_id)
        for res_id, amount in dev_cost.cost.items():
            if player.resources.get(res_id, 0) < amount:
                return False, f"Not enough {res_id}"
    return True, ""


@validator("play_dev_card")
def validate_play_dev_card(state: GameState, config: GameConfig, action: Action) -> tuple[bool, str]:
    if state.phase != GamePhase.PLAYING:
        return False, "Game is not in playing phase"
    if action.player_id != state.current_player_id:
        return False, "Not your turn"

    player = state.get_player(action.player_id)
    card_type = action.params.get("card_type")
    if card_type not in player.dev_cards:
        return False, "You don't have that card"

    dc = config.dev_card_types.get(card_type)
    if not dc:
        return False, f"Unknown dev card: {card_type}"
    if not dc.playable:
        return False, "This card cannot be played"
    if dc.is_victory_point:
        return False, "Victory point cards are revealed automatically"
    if player.has_played_dev_card_this_turn:
        return False, "Already played a dev card this turn"

    # Can't play a dev card the same turn it was bought
    if card_type in player.dev_cards_bought_this_turn:
        return False, "Cannot play a dev card the same turn you bought it"

    return True, ""


@validator("trade_bank")
def validate_trade_bank(state: GameState, config: GameConfig, action: Action) -> tuple[bool, str]:
    if state.phase != GamePhase.PLAYING:
        return False, "Game is not in playing phase"
    if action.player_id != state.current_player_id:
        return False, "Not your turn"
    if not state.dice_rolled:
        return False, "Must roll dice first"
    if not config.trade_rules.bank_trading_enabled:
        return False, "Bank trading is disabled"

    give_resource = action.params.get("give_resource")
    want_resource = action.params.get("want_resource")
    if not give_resource or not want_resource:
        return False, "Must specify give and want resources"
    if give_resource == want_resource:
        return False, "Cannot trade same resource"

    player = state.get_player(action.player_id)

    # Determine trade ratio
    ratio = config.trade_rules.default_bank_ratio
    for port_id in player.ports:
        pt = config.port_types.get(port_id)
        if pt:
            if pt.resource is None:  # generic port
                ratio = min(ratio, pt.ratio)
            elif pt.resource == give_resource:
                ratio = min(ratio, pt.ratio)

    if player.resources.get(give_resource, 0) < ratio:
        return False, f"Need {ratio} {give_resource} to trade"

    return True, ""


@validator("trade_offer")
def validate_trade_offer(state: GameState, config: GameConfig, action: Action) -> tuple[bool, str]:
    if state.phase != GamePhase.PLAYING:
        return False, "Game is not in playing phase"
    if action.player_id != state.current_player_id:
        return False, "Not your turn"
    if not state.dice_rolled:
        return False, "Must roll dice first"
    if not config.trade_rules.player_trading_enabled:
        return False, "Player trading is disabled"

    offering = action.params.get("offering", {})
    requesting = action.params.get("requesting", {})
    if not offering or not requesting:
        return False, "Must specify what you offer and request"

    player = state.get_player(action.player_id)
    for res_id, amount in offering.items():
        if player.resources.get(res_id, 0) < amount:
            return False, f"Not enough {res_id} to offer"

    return True, ""


@validator("trade_accept")
def validate_trade_accept(state: GameState, config: GameConfig, action: Action) -> tuple[bool, str]:
    if state.phase != GamePhase.PLAYING:
        return False, "Game is not in playing phase"

    trade_id = action.params.get("trade_id")
    offer = state.trade_offers.get(trade_id)
    if not offer:
        return False, "Trade offer not found"
    if action.player_id == offer.from_player:
        return False, "Cannot accept your own trade"

    # Check that acceptor has the requested resources
    player = state.get_player(action.player_id)
    for res_id, amount in offer.requesting.items():
        if player.resources.get(res_id, 0) < amount:
            return False, f"Not enough {res_id}"

    return True, ""


@validator("end_turn")
def validate_end_turn(state: GameState, config: GameConfig, action: Action) -> tuple[bool, str]:
    if state.phase != GamePhase.PLAYING:
        return False, "Game is not in playing phase"
    if action.player_id != state.current_player_id:
        return False, "Not your turn"
    if not state.dice_rolled:
        return False, "Must roll dice first"
    if state.pending_discards:
        return False, "Waiting for players to discard"
    if state.pending_robber_move or state.pending_robber_steal:
        return False, "Must resolve robber first"
    if state.pending_action:
        return False, "Must resolve pending action first"
    return True, ""


@validator("discard")
def validate_discard(state: GameState, config: GameConfig, action: Action) -> tuple[bool, str]:
    player_id = action.player_id
    if player_id not in state.pending_discards:
        return False, "You don't need to discard"

    cards = action.params.get("resources", {})
    total = sum(cards.values())
    expected = state.pending_discards[player_id]
    if total != expected:
        return False, f"Must discard exactly {expected} cards, discarding {total}"

    player = state.get_player(player_id)
    for res_id, amount in cards.items():
        if player.resources.get(res_id, 0) < amount:
            return False, f"Not enough {res_id} to discard"

    return True, ""


@validator("move_robber")
def validate_move_robber(state: GameState, config: GameConfig, action: Action) -> tuple[bool, str]:
    if not state.pending_robber_move:
        return False, "Not waiting for robber move"
    if action.player_id != state.current_player_id:
        return False, "Not your turn"

    hex_id = action.params.get("hex_id")
    if hex_id is None:
        return False, "Must specify hex"
    if hex_id not in state.board.hexes:
        return False, "Invalid hex"
    if config.robber.must_move and hex_id == state.robber_hex:
        return False, "Must move robber to a different hex"

    return True, ""


@validator("steal")
def validate_steal(state: GameState, config: GameConfig, action: Action) -> tuple[bool, str]:
    if not state.pending_robber_steal:
        return False, "Not waiting for steal"
    if action.player_id != state.current_player_id:
        return False, "Not your turn"

    target = action.params.get("target_player")
    if target is None:
        return False, "Must specify target player"
    if target not in state.robber_steal_candidates:
        return False, "Cannot steal from that player"

    return True, ""


@validator("dev_card_action")
def validate_dev_card_action(state: GameState, config: GameConfig, action: Action) -> tuple[bool, str]:
    """Validate actions triggered by development cards (e.g. choosing resources for year of plenty)."""
    if not state.pending_action:
        return False, "No pending action"
    if action.player_id != state.current_player_id:
        return False, "Not your turn"
    return True, ""
