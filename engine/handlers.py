"""
Action handlers — execute validated actions and mutate game state.

Each handler receives the current state and config, performs mutations,
and returns a list of events that occurred.
"""

from __future__ import annotations

import math
import random
import uuid
from typing import Any

from .config import GameConfig
from .state import GameState, GamePhase, PlacedBuilding, TradeOffer
from .actions import handler


@handler("roll_dice")
def handle_roll_dice(state: GameState, config: GameConfig, player_id: str,
                     params: dict[str, Any]) -> list[dict[str, Any]]:
    events = []

    # Roll dice
    dice = config.dice
    rolls = tuple(random.randint(1, dice.sides_per_die) for _ in range(dice.num_dice))
    total = sum(rolls)

    state.dice_rolled = True
    state.last_roll = rolls

    events.append({"type": "dice_rolled", "player": player_id, "rolls": rolls, "total": total})
    state.add_log("dice_rolled", player=player_id, rolls=list(rolls), total=total)

    # Process dice outcome handlers from config
    outcome_handlers = config.dice_outcomes.get(total, [])
    for oh in outcome_handlers:
        if oh.action == "produce_resources":
            events.extend(_produce_resources(state, config, total))
        elif oh.action == "activate_robber":
            events.extend(_activate_robber(state, config, player_id))

    # If no specific handlers, default: produce resources for non-robber rolls
    if not outcome_handlers:
        events.extend(_produce_resources(state, config, total))

    return events


def _produce_resources(state: GameState, config: GameConfig, roll: int) -> list[dict]:
    """Produce resources for all hexes matching the roll."""
    events = []
    for hid, hex_tile in state.board.hexes.items():
        if hex_tile.number_token != roll:
            continue
        if hex_tile.has_robber:
            continue

        terrain = config.terrain_types.get(hex_tile.terrain)
        if not terrain or not terrain.produces:
            continue

        resource_id = terrain.produces

        # Find all intersections adjacent to this hex with buildings
        for iid in state.board.hex_intersections.get(hid, []):
            intersection = state.board.intersections.get(iid)
            if not intersection or not intersection.building:
                continue

            building = intersection.building
            bt = config.building_types.get(building.building_type)
            if not bt or bt.production_multiplier <= 0:
                continue

            player = state.get_player(building.player_id)
            amount = bt.production_multiplier
            player.resources[resource_id] = player.resources.get(resource_id, 0) + amount

            events.append({
                "type": "resource_produced",
                "player": building.player_id,
                "resource": resource_id,
                "amount": amount,
                "hex": hid,
            })

    return events


def _activate_robber(state: GameState, config: GameConfig, player_id: str) -> list[dict]:
    """Activate the robber: force discards, then require robber move."""
    events = []

    if not config.robber.enabled:
        return events

    # Check for discards
    for pid, player in state.players.items():
        hand_size = sum(player.resources.values())
        if hand_size > config.robber.discard_threshold:
            discard_count = math.floor(hand_size * config.robber.discard_fraction)
            state.pending_discards[pid] = discard_count
            events.append({"type": "must_discard", "player": pid, "count": discard_count})

    # If no one needs to discard, go straight to robber move
    if not state.pending_discards:
        state.pending_robber_move = True
        events.append({"type": "must_move_robber", "player": player_id})
    # Otherwise, robber move will be triggered after all discards resolve

    return events


@handler("build")
def handle_build(state: GameState, config: GameConfig, player_id: str,
                 params: dict[str, Any]) -> list[dict[str, Any]]:
    events = []
    building_type_id = params["building_type"]
    bt = config.building_types[building_type_id]
    location = params["location"]
    player = state.get_player(player_id)

    is_setup = state.phase == GamePhase.SETUP

    # Deduct cost (skip during setup)
    if not is_setup:
        for res_id, amount in bt.cost.items():
            player.resources[res_id] -= amount

    # Place building
    if bt.placement.location_type == "intersection":
        intersection = state.board.intersections[location]

        # Handle upgrade (e.g. settlement -> city)
        old_type = None
        if bt.placement.upgrades_from and intersection.building:
            old_type = intersection.building.building_type
            player.buildings_placed[old_type] = player.buildings_placed.get(old_type, 0) - 1

        intersection.building = PlacedBuilding(
            building_type=building_type_id,
            player_id=player_id,
        )

        # Check for ports
        if intersection.port:
            if intersection.port not in player.ports:
                player.ports.append(intersection.port)

        events.append({
            "type": "building_placed",
            "player": player_id,
            "building": building_type_id,
            "location": location,
            "location_type": "intersection",
            "upgraded_from": old_type,
        })

    elif bt.placement.location_type == "edge":
        edge = state.board.edges[location]
        edge.building = PlacedBuilding(
            building_type=building_type_id,
            player_id=player_id,
        )
        events.append({
            "type": "building_placed",
            "player": player_id,
            "building": building_type_id,
            "location": location,
            "location_type": "edge",
        })

    player.buildings_placed[building_type_id] = player.buildings_placed.get(building_type_id, 0) + 1

    # Setup phase tracking
    if is_setup:
        if bt.placement.location_type == "intersection":
            state.setup_settlements_placed += 1
            state.setup_last_settlement = location

            # On second placement round, give starting resources
            if state.setup_round == 1 and config.setup_rules.last_placement_gives_resources:
                _give_setup_resources(state, config, player_id, location)
                events.append({"type": "setup_resources", "player": player_id, "location": location})

        elif bt.placement.location_type == "edge":
            state.setup_roads_placed += 1

    state.add_log("build", player=player_id, building=building_type_id, location=location)

    return events


def _give_setup_resources(state: GameState, config: GameConfig, player_id: str, intersection_id: int):
    """Give starting resources for hexes adjacent to a settlement placed in setup."""
    player = state.get_player(player_id)
    intersection = state.board.intersections[intersection_id]
    for hid in intersection.hex_ids:
        hex_tile = state.board.hexes[hid]
        terrain = config.terrain_types.get(hex_tile.terrain)
        if terrain and terrain.produces:
            res_id = terrain.produces
            player.resources[res_id] = player.resources.get(res_id, 0) + 1


@handler("buy_dev_card")
def handle_buy_dev_card(state: GameState, config: GameConfig, player_id: str,
                        params: dict[str, Any]) -> list[dict[str, Any]]:
    events = []
    player = state.get_player(player_id)

    # Deduct cost
    dev_cost = config.building_types["dev_card"]
    for res_id, amount in dev_cost.cost.items():
        player.resources[res_id] -= amount

    # Draw from deck
    card_type_id = state.dev_card_deck.pop(0)
    dc = config.dev_card_types[card_type_id]

    player.dev_cards.append(card_type_id)
    player.dev_cards_bought_this_turn.append(card_type_id)

    if dc.is_victory_point:
        player.hidden_vp += 1
        events.append({"type": "dev_card_bought", "player": player_id, "card": card_type_id, "is_vp": True})
    else:
        events.append({"type": "dev_card_bought", "player": player_id, "card": card_type_id, "is_vp": False})

    state.add_log("buy_dev_card", player=player_id)
    return events


@handler("play_dev_card")
def handle_play_dev_card(state: GameState, config: GameConfig, player_id: str,
                         params: dict[str, Any]) -> list[dict[str, Any]]:
    events = []
    player = state.get_player(player_id)
    card_type = params["card_type"]
    dc = config.dev_card_types[card_type]

    # Remove from hand
    player.dev_cards.remove(card_type)
    player.has_played_dev_card_this_turn = True

    if dc.persistent:
        player.played_dev_cards.append(card_type)

    events.append({"type": "dev_card_played", "player": player_id, "card": card_type})
    state.add_log("play_dev_card", player=player_id, card=card_type)

    # Process effects
    for effect in dc.effects:
        events.extend(_process_dev_card_effect(state, config, player_id, effect, params))

    return events


def _process_dev_card_effect(state: GameState, config: GameConfig, player_id: str,
                              effect, params: dict) -> list[dict]:
    """Process a single dev card effect."""
    events = []

    if effect.type == "activate_robber":
        # Knight: move robber + steal
        state.pending_robber_move = True
        events.append({"type": "must_move_robber", "player": player_id})

    elif effect.type == "gain_resources":
        # Year of Plenty: choose 2 resources
        count = effect.params.get("count", 2)
        state.pending_action = {
            "type": "choose_resources",
            "count": count,
            "player": player_id,
        }
        events.append({"type": "choose_resources", "player": player_id, "count": count})

    elif effect.type == "monopoly":
        # Monopoly: choose a resource, steal all of that type from everyone
        state.pending_action = {
            "type": "choose_monopoly_resource",
            "player": player_id,
        }
        events.append({"type": "choose_monopoly_resource", "player": player_id})

    elif effect.type == "build_roads":
        # Road Building: place 2 roads for free
        count = effect.params.get("count", 2)
        state.pending_action = {
            "type": "build_free_roads",
            "count": count,
            "remaining": count,
            "player": player_id,
        }
        events.append({"type": "build_free_roads", "player": player_id, "count": count})

    return events


@handler("dev_card_action")
def handle_dev_card_action(state: GameState, config: GameConfig, player_id: str,
                           params: dict[str, Any]) -> list[dict[str, Any]]:
    """Handle follow-up actions from dev cards."""
    events = []
    pa = state.pending_action

    if pa["type"] == "choose_resources":
        # Year of Plenty
        resources = params.get("resources", {})
        total = sum(resources.values())
        if total != pa["count"]:
            return [{"type": "error", "message": f"Must choose exactly {pa['count']} resources"}]
        player = state.get_player(player_id)
        for res_id, amount in resources.items():
            player.resources[res_id] = player.resources.get(res_id, 0) + amount
        state.pending_action = None
        events.append({"type": "resources_gained", "player": player_id, "resources": resources})
        state.add_log("dev_card_action", player=player_id, action_type="choose_resources")

    elif pa["type"] == "choose_monopoly_resource":
        resource = params.get("resource")
        if not resource:
            return [{"type": "error", "message": "Must choose a resource"}]
        player = state.get_player(player_id)
        total_stolen = 0
        for pid, p in state.players.items():
            if pid == player_id:
                continue
            amount = p.resources.get(resource, 0)
            if amount > 0:
                p.resources[resource] = 0
                player.resources[resource] = player.resources.get(resource, 0) + amount
                total_stolen += amount
        state.pending_action = None
        events.append({"type": "monopoly", "player": player_id, "resource": resource, "stolen": total_stolen})
        state.add_log("dev_card_action", player=player_id, action_type="choose_monopoly_resource")

    elif pa["type"] == "build_free_roads":
        location = params.get("location")
        road_type = None
        for bt_id, bt in config.building_types.items():
            if bt.counts_as_road:
                road_type = bt
                break
        if not road_type:
            state.pending_action = None
            return events

        # If skip flag set (max roads reached) or no legal locations, end early
        if params.get("skip") or location == -1:
            state.pending_action = None
            events.append({"type": "free_roads_skipped", "player": player_id, "reason": "max_roads"})
            return events

        # Check max roads
        player = state.get_player(player_id)
        placed = player.buildings_placed.get(road_type.id, 0)
        if placed >= road_type.max_per_player:
            state.pending_action = None
            events.append({"type": "free_roads_skipped", "player": player_id, "reason": "max_roads"})
            return events

        edge = state.board.edges.get(location)
        if not edge or edge.building:
            return [{"type": "error", "message": "Invalid road location"}]

        edge.building = PlacedBuilding(building_type=road_type.id, player_id=player_id)
        player.buildings_placed[road_type.id] = player.buildings_placed.get(road_type.id, 0) + 1

        pa["remaining"] -= 1
        events.append({"type": "free_road_built", "player": player_id, "location": location})

        # Check if max roads reached after this placement
        if player.buildings_placed.get(road_type.id, 0) >= road_type.max_per_player:
            state.pending_action = None
        elif pa["remaining"] <= 0:
            state.pending_action = None

    state.add_log("dev_card_action", player=player_id, action_type=pa["type"] if pa else "unknown")
    return events


@handler("trade_bank")
def handle_trade_bank(state: GameState, config: GameConfig, player_id: str,
                      params: dict[str, Any]) -> list[dict[str, Any]]:
    events = []
    player = state.get_player(player_id)
    give_resource = params["give_resource"]
    want_resource = params["want_resource"]

    # Determine ratio
    ratio = config.trade_rules.default_bank_ratio
    for port_id in player.ports:
        pt = config.port_types.get(port_id)
        if pt:
            if pt.resource is None:
                ratio = min(ratio, pt.ratio)
            elif pt.resource == give_resource:
                ratio = min(ratio, pt.ratio)

    player.resources[give_resource] -= ratio
    player.resources[want_resource] = player.resources.get(want_resource, 0) + 1

    events.append({
        "type": "bank_trade",
        "player": player_id,
        "gave": {give_resource: ratio},
        "received": {want_resource: 1},
    })
    state.add_log("trade_bank", player=player_id, give=give_resource, want=want_resource, ratio=ratio)
    return events


@handler("trade_offer")
def handle_trade_offer(state: GameState, config: GameConfig, player_id: str,
                       params: dict[str, Any]) -> list[dict[str, Any]]:
    trade_id = str(uuid.uuid4())[:8]
    offer = TradeOffer(
        id=trade_id,
        from_player=player_id,
        offering=params["offering"],
        requesting=params["requesting"],
    )
    state.trade_offers[trade_id] = offer
    state.add_log("trade_offer", player=player_id, trade_id=trade_id)
    return [{"type": "trade_offered", "player": player_id, "trade_id": trade_id, "offer": params}]


@handler("trade_accept")
def handle_trade_accept(state: GameState, config: GameConfig, player_id: str,
                        params: dict[str, Any]) -> list[dict[str, Any]]:
    events = []
    trade_id = params["trade_id"]
    offer = state.trade_offers[trade_id]

    offerer = state.get_player(offer.from_player)
    accepter = state.get_player(player_id)

    # Swap resources
    for res_id, amount in offer.offering.items():
        offerer.resources[res_id] -= amount
        accepter.resources[res_id] = accepter.resources.get(res_id, 0) + amount
    for res_id, amount in offer.requesting.items():
        accepter.resources[res_id] -= amount
        offerer.resources[res_id] = offerer.resources.get(res_id, 0) + amount

    # Remove the trade offer
    del state.trade_offers[trade_id]

    events.append({"type": "trade_completed", "from": offer.from_player, "to": player_id, "trade_id": trade_id})
    state.add_log("trade_accept", player=player_id, from_player=offer.from_player, trade_id=trade_id)
    return events


@handler("discard")
def handle_discard(state: GameState, config: GameConfig, player_id: str,
                   params: dict[str, Any]) -> list[dict[str, Any]]:
    events = []
    player = state.get_player(player_id)
    resources = params["resources"]

    for res_id, amount in resources.items():
        player.resources[res_id] -= amount

    del state.pending_discards[player_id]
    events.append({"type": "discarded", "player": player_id, "resources": resources})
    state.add_log("discard", player=player_id, resources=resources)

    # If all discards are done, trigger robber move
    if not state.pending_discards:
        state.pending_robber_move = True
        events.append({"type": "must_move_robber", "player": state.current_player_id})

    return events


@handler("move_robber")
def handle_move_robber(state: GameState, config: GameConfig, player_id: str,
                       params: dict[str, Any]) -> list[dict[str, Any]]:
    events = []
    hex_id = params["hex_id"]

    # Move robber
    if state.robber_hex is not None:
        state.board.hexes[state.robber_hex].has_robber = False
    state.board.hexes[hex_id].has_robber = True
    state.robber_hex = hex_id
    state.pending_robber_move = False

    events.append({"type": "robber_moved", "player": player_id, "hex": hex_id})
    state.add_log("move_robber", player=player_id, hex=hex_id)

    # Determine steal candidates
    if config.robber.steal_on_place:
        candidates = set()
        for iid in state.board.hex_intersections.get(hex_id, []):
            inter = state.board.intersections.get(iid)
            if inter and inter.building and inter.building.player_id != player_id:
                target = inter.building.player_id
                if sum(state.players[target].resources.values()) > 0:
                    candidates.add(target)

        if len(candidates) == 0:
            # No one to steal from
            pass
        elif len(candidates) == 1:
            # Auto-steal
            target = list(candidates)[0]
            events.extend(_steal_resource(state, config, player_id, target))
        else:
            # Player must choose
            state.pending_robber_steal = True
            state.robber_steal_candidates = list(candidates)
            events.append({"type": "choose_steal_target", "player": player_id, "candidates": list(candidates)})

    return events


@handler("steal")
def handle_steal(state: GameState, config: GameConfig, player_id: str,
                 params: dict[str, Any]) -> list[dict[str, Any]]:
    target = params["target_player"]
    state.pending_robber_steal = False
    state.robber_steal_candidates = []
    return _steal_resource(state, config, player_id, target)


def _steal_resource(state: GameState, config: GameConfig, stealer_id: str, target_id: str) -> list[dict]:
    """Steal a random resource from target."""
    events = []
    target = state.get_player(target_id)
    stealer = state.get_player(stealer_id)

    # Build list of stealable resources
    stealable = []
    for res_id, amount in target.resources.items():
        stealable.extend([res_id] * amount)

    if stealable:
        for _ in range(config.robber.steal_count):
            if not stealable:
                break
            stolen_res = random.choice(stealable)
            stealable.remove(stolen_res)
            target.resources[stolen_res] -= 1
            stealer.resources[stolen_res] = stealer.resources.get(stolen_res, 0) + 1
            events.append({"type": "resource_stolen", "stealer": stealer_id, "target": target_id, "resource": stolen_res})

    state.add_log("steal", stealer=stealer_id, target=target_id)
    return events


@handler("end_turn")
def handle_end_turn(state: GameState, config: GameConfig, player_id: str,
                    params: dict[str, Any]) -> list[dict[str, Any]]:
    events = []

    # Clear turn state
    state.dice_rolled = False
    state.last_roll = None
    state.trade_offers.clear()
    player = state.get_player(player_id)
    player.has_played_dev_card_this_turn = False
    player.dev_cards_bought_this_turn.clear()

    # Advance to next player
    state.current_player_idx = (state.current_player_idx + 1) % len(state.player_order)
    state.turn_number += 1
    state.current_turn_phase = 0

    events.append({"type": "turn_ended", "player": player_id})
    events.append({"type": "turn_started", "player": state.current_player_id})
    state.add_log("end_turn", player=player_id, next_player=state.current_player_id)

    return events
