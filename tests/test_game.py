"""
End-to-end game simulation test.
Runs a full game with AI players to verify the entire engine works.
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from definitions.base_game import load_base_game
from engine.engine import GameEngine
from engine.actions import Action
from engine.ai import RandomStrategy, SmartStrategy
from engine.state import GamePhase


def _run_setup(engine, ai):
    """Helper: run through setup phase."""
    while engine.state.phase == GamePhase.SETUP:
        current_pid = engine.state.player_order[engine.state.setup_player_idx]
        action = ai.choose_action(engine, current_pid)
        if not action:
            break
        result = engine.do_action(action)
        if not result.success:
            break


def _run_game(engine, ai, max_actions=1000):
    """Helper: run through playing phase handling discards and dev card actions."""
    actions = 0
    while engine.state.phase == GamePhase.PLAYING and actions < max_actions:
        if engine.state.pending_discards:
            for pid in list(engine.state.pending_discards.keys()):
                count = engine.state.pending_discards[pid]
                resources = ai.choose_discard(engine, pid, count)
                engine.do_action(Action(type="discard", player_id=pid,
                                        params={"resources": resources}))
            continue

        current_pid = engine.state.current_player_id
        action = ai.choose_action(engine, current_pid)
        if not action:
            break

        if action.type == "dev_card_action":
            pa = engine.state.pending_action
            if pa and pa["type"] == "choose_monopoly_resource" and "resource" not in action.params:
                action.params["resource"] = ai.choose_monopoly_resource(engine, current_pid)
            elif pa and pa["type"] == "choose_resources" and "resources" not in action.params:
                action.params["resources"] = ai.choose_year_of_plenty(engine, current_pid, pa["count"])

        result = engine.do_action(action)
        if not result.success:
            if engine.state.pending_action:
                engine.state.pending_action = None
            if action.type != "end_turn" and engine.state.dice_rolled:
                engine.do_action(Action(type="end_turn", player_id=current_pid))
        actions += 1
    return actions


def test_full_game_simulation():
    """Simulate a complete game with AI players."""
    config = load_base_game()
    engine = GameEngine(config)

    players = []
    for name in ["Alice", "Bob", "Charlie"]:
        pid = engine.add_player(name)
        players.append(pid)

    events = engine.start_game(seed=42)
    assert engine.state.phase == GamePhase.SETUP

    ai = RandomStrategy()
    _run_setup(engine, ai)

    assert engine.state.phase == GamePhase.PLAYING

    for pid in players:
        player = engine.state.get_player(pid)
        assert player.buildings_placed.get("settlement", 0) == 2
        assert player.buildings_placed.get("road", 0) == 2

    _run_game(engine, ai)

    if engine.state.phase == GamePhase.FINISHED:
        winner = engine.state.players[engine.state.winner]
        vp = engine.state.visible_vp(engine.state.winner, config)
        assert vp >= 10


def test_config_modification():
    """Test that modifying config changes game behavior."""
    config = load_base_game()
    config.win_conditions[0].params["threshold"] = 5

    engine = GameEngine(config)
    for name in ["Alice", "Bob", "Charlie"]:
        engine.add_player(name)

    engine.start_game(seed=42)
    ai = RandomStrategy()
    _run_setup(engine, ai)
    _run_game(engine, ai, max_actions=500)

    if engine.state.winner:
        vp = engine.state.visible_vp(engine.state.winner, config)
        assert vp >= 5


def test_hidden_vp_not_leaked_to_opponents():
    """Victory point dev cards should be hidden from other players."""
    config = load_base_game()
    engine = GameEngine(config)

    p1 = engine.add_player("Alice")
    p2 = engine.add_player("Bob")
    p3 = engine.add_player("Charlie")

    engine.start_game(seed=42)
    ai = RandomStrategy()
    _run_setup(engine, ai)

    # Give player 1 some hidden VP
    engine.state.players[p1].hidden_vp = 3

    # Player 1 should see their own full VP (including hidden)
    state_for_p1 = engine.get_state_for_player(p1)
    p1_vp_self = state_for_p1["players"][p1]["vp"]

    # Player 2 should NOT see player 1's hidden VP
    state_for_p2 = engine.get_state_for_player(p2)
    p1_vp_from_p2 = state_for_p2["players"][p1]["vp"]

    assert p1_vp_self == p1_vp_from_p2 + 3, (
        f"Hidden VP leak: p1 sees {p1_vp_self} VP for themselves, "
        f"but p2 sees {p1_vp_from_p2} VP for p1 (should be 3 less)"
    )


def test_smart_strategy_no_stalemate():
    """SmartStrategy should finish games without road-building stalemates."""
    import random
    ai = SmartStrategy()

    finished = 0
    total = 10
    for seed in range(total):
        random.seed(seed * 17)
        config = load_base_game()
        engine = GameEngine(config)
        for name in ["Alice", "Bob", "Charlie"]:
            engine.add_player(name)
        engine.start_game(seed=seed)

        _run_setup(engine, ai)
        _run_game(engine, ai, max_actions=800)

        if engine.state.phase == GamePhase.FINISHED:
            finished += 1

    # At least 80% of games should finish
    assert finished >= total * 0.8, (
        f"Only {finished}/{total} games finished — SmartStrategy may be stalling"
    )


def test_setup_phase_forward_reverse():
    """Setup should follow forward-reverse pattern (1,2,3,3,2,1)."""
    config = load_base_game()
    engine = GameEngine(config)

    p1 = engine.add_player("Alice")
    p2 = engine.add_player("Bob")
    p3 = engine.add_player("Charlie")

    engine.start_game(seed=42)
    ai = RandomStrategy()

    # Track placement order
    placement_order = []
    while engine.state.phase == GamePhase.SETUP:
        current_pid = engine.state.player_order[engine.state.setup_player_idx]
        action = ai.choose_action(engine, current_pid)
        if not action:
            break
        result = engine.do_action(action)
        if result.success and action.params.get("building_type") == "settlement":
            placement_order.append(current_pid)

    # Forward: p1, p2, p3; Reverse: p3, p2, p1
    assert placement_order == [p1, p2, p3, p3, p2, p1], (
        f"Expected forward-reverse order, got: {placement_order}"
    )


def test_robber_on_seven():
    """Rolling a 7 should activate robber mechanics."""
    import random
    config = load_base_game()
    engine = GameEngine(config)

    p1 = engine.add_player("Alice")
    p2 = engine.add_player("Bob")
    p3 = engine.add_player("Charlie")

    engine.start_game(seed=42)
    ai = RandomStrategy()
    _run_setup(engine, ai)

    # Force a 7 roll by monkey-patching random
    old_randint = random.randint

    def mock_roll(a, b):
        # Return values that sum to 7: 3 + 4
        if a == 1 and b == 6:
            mock_roll.call_count = getattr(mock_roll, 'call_count', 0) + 1
            return 3 if mock_roll.call_count % 2 == 1 else 4
        return old_randint(a, b)

    random.randint = mock_roll
    try:
        result = engine.do_action(Action(type="roll_dice", player_id=p1))
        assert result.success
        assert sum(engine.state.last_roll) == 7

        # Should either have pending discards or pending robber move
        has_robber_event = any(
            e.get("type") in ("must_move_robber", "must_discard")
            for e in result.events
        )
        assert has_robber_event, "Rolling 7 should trigger robber mechanics"
    finally:
        random.randint = old_randint


def test_action_validation():
    """Test that invalid actions are properly rejected."""
    config = load_base_game()
    engine = GameEngine(config)

    p1 = engine.add_player("Alice")
    p2 = engine.add_player("Bob")
    p3 = engine.add_player("Charlie")

    engine.start_game(seed=42)
    ai = RandomStrategy()
    _run_setup(engine, ai)

    # Can't roll dice if it's not your turn
    wrong_player = p2 if engine.state.current_player_id == p1 else p1
    result = engine.do_action(Action(type="roll_dice", player_id=wrong_player))
    assert not result.success
    assert "Not your turn" in result.error

    # Roll dice for current player
    current = engine.state.current_player_id
    result = engine.do_action(Action(type="roll_dice", player_id=current))
    assert result.success

    # Can't roll twice
    result = engine.do_action(Action(type="roll_dice", player_id=current))
    assert not result.success
    assert "already rolled" in result.error.lower()

    # Can't end turn without rolling (for next player)
    result = engine.do_action(Action(type="end_turn", player_id=current))
    # This should succeed since we DID roll
    # The validation checks dice_rolled=True for end_turn


def test_two_player_game():
    """Game should work with just 2 players."""
    config = load_base_game()
    engine = GameEngine(config)

    p1 = engine.add_player("Alice")
    p2 = engine.add_player("Bob")

    engine.start_game(seed=42)
    ai = SmartStrategy()

    _run_setup(engine, ai)
    assert engine.state.phase == GamePhase.PLAYING

    for pid in [p1, p2]:
        player = engine.state.get_player(pid)
        assert player.buildings_placed.get("settlement", 0) == 2
        assert player.buildings_placed.get("road", 0) == 2


def test_board_generation():
    """Test board generation produces valid topology."""
    config = load_base_game()
    engine = GameEngine(config)
    engine.add_player("Alice")
    engine.add_player("Bob")
    engine.start_game(seed=42)

    board = engine.state.board

    # Standard board: 19 hexes, 54 intersections, 72 edges
    assert len(board.hexes) == 19
    assert len(board.intersections) == 54
    assert len(board.edges) == 72

    # Every intersection should have at least 1 adjacent hex
    for iid, inter in board.intersections.items():
        assert len(inter.hex_ids) >= 1
        assert len(inter.hex_ids) <= 3

    # Every edge connects exactly 2 intersections
    for eid, edge in board.edges.items():
        a, b = edge.intersection_ids
        assert a != b
        assert a in board.intersections
        assert b in board.intersections

    # Adjacency should be symmetric
    for iid, adjs in board.adjacent_intersections.items():
        for adj_iid in adjs:
            assert iid in board.adjacent_intersections[adj_iid], (
                f"Asymmetric adjacency: {iid} -> {adj_iid} but not reverse"
            )

    # Exactly one hex should have the robber
    robber_hexes = [h for h in board.hexes.values() if h.has_robber]
    assert len(robber_hexes) == 1


def test_distance_rule():
    """Settlements must be at least 2 intersections apart."""
    config = load_base_game()
    engine = GameEngine(config)

    p1 = engine.add_player("Alice")
    p2 = engine.add_player("Bob")

    engine.start_game(seed=42)

    # Find a legal settlement spot
    legal = engine.get_legal_actions(p1)
    settlement_actions = [a for a in legal if a.get("building_type") == "settlement"]
    assert len(settlement_actions) > 0

    # Place first settlement
    first_loc = settlement_actions[0]["location"]
    result = engine.do_action(Action(
        type="build", player_id=p1,
        params={"building_type": "settlement", "location": first_loc}
    ))
    assert result.success

    # Adjacent intersections should NOT be legal settlement spots
    adjacent = engine.state.board.adjacent_intersections.get(first_loc, [])
    legal_after = engine.get_legal_actions(p1)
    settlement_locs = [a["location"] for a in legal_after if a.get("building_type") == "settlement"]

    for adj in adjacent:
        assert adj not in settlement_locs, (
            f"Adjacent intersection {adj} should not be a legal settlement location"
        )


def test_bank_trade_with_ports():
    """Port access should reduce bank trade ratios."""
    config = load_base_game()
    engine = GameEngine(config)

    p1 = engine.add_player("Alice")
    p2 = engine.add_player("Bob")

    engine.start_game(seed=42)
    ai = RandomStrategy()
    _run_setup(engine, ai)

    # Give player 1 a generic port (3:1 ratio)
    engine.state.players[p1].ports.append("generic")
    # Give lots of brick
    engine.state.players[p1].resources["brick"] = 10

    # Force it to be p1's turn and rolled
    engine.state.current_player_idx = engine.state.player_order.index(p1)
    engine.state.dice_rolled = True

    legal = engine.get_legal_actions(p1)
    bank_trades = [a for a in legal if a["type"] == "trade_bank" and a["give_resource"] == "brick"]

    # Should be able to trade brick for other resources
    assert len(bank_trades) > 0

    # Execute a bank trade
    trade = bank_trades[0]
    result = engine.do_action(Action(
        type="trade_bank", player_id=p1,
        params={"give_resource": trade["give_resource"],
                "want_resource": trade["want_resource"]}
    ))
    assert result.success


def test_dev_card_same_turn_rule():
    """Dev cards cannot be played the same turn they are bought."""
    config = load_base_game()
    engine = GameEngine(config)

    p1 = engine.add_player("Alice")
    p2 = engine.add_player("Bob")
    engine.start_game(seed=42)
    ai = RandomStrategy()
    _run_setup(engine, ai)

    # Set up: give player resources to buy a dev card
    player = engine.state.get_player(p1)
    player.resources = {"ore": 5, "grain": 5, "wool": 5, "brick": 5, "lumber": 5}

    # Force p1's turn and roll dice
    engine.state.current_player_idx = engine.state.player_order.index(p1)
    engine.state.dice_rolled = True

    # Buy a dev card
    result = engine.do_action(Action(type="buy_dev_card", player_id=p1, params={}))
    assert result.success, "Should be able to buy dev card"

    bought_card = player.dev_cards_bought_this_turn[-1]
    dc = config.dev_card_types.get(bought_card)

    # If the card is playable (not a VP card), trying to play it should fail
    if dc and dc.playable and not dc.is_victory_point:
        result = engine.do_action(Action(
            type="play_dev_card", player_id=p1,
            params={"card_type": bought_card}
        ))
        assert not result.success, "Should NOT be able to play dev card same turn it was bought"
        assert "same turn" in result.error.lower()

    # Verify it also doesn't appear in legal actions
    legal = engine.get_legal_actions(p1)
    playable = [a for a in legal if a["type"] == "play_dev_card"
                and a["card_type"] == bought_card]
    if dc and dc.playable and not dc.is_victory_point:
        assert len(playable) == 0, "Same-turn card should not appear in legal actions"

    # End turn, then it should be playable on the next turn
    engine.do_action(Action(type="end_turn", player_id=p1, params={}))

    # Now it's p2's turn - advance back to p1
    engine.state.dice_rolled = True
    engine.do_action(Action(type="end_turn", player_id=p2, params={}))
    engine.state.dice_rolled = True

    # Now p1 should be able to play the card
    if dc and dc.playable and not dc.is_victory_point:
        legal = engine.get_legal_actions(p1)
        playable = [a for a in legal if a["type"] == "play_dev_card"
                    and a["card_type"] == bought_card]
        assert len(playable) > 0, "Should be able to play dev card on next turn"


if __name__ == "__main__":
    test_full_game_simulation()
    print("test_full_game_simulation passed")
    test_config_modification()
    print("test_config_modification passed")
    test_hidden_vp_not_leaked_to_opponents()
    print("test_hidden_vp_not_leaked_to_opponents passed")
    test_smart_strategy_no_stalemate()
    print("test_smart_strategy_no_stalemate passed")
    test_setup_phase_forward_reverse()
    print("test_setup_phase_forward_reverse passed")
    test_robber_on_seven()
    print("test_robber_on_seven passed")
    test_action_validation()
    print("test_action_validation passed")
    test_two_player_game()
    print("test_two_player_game passed")
    test_board_generation()
    print("test_board_generation passed")
    test_distance_rule()
    print("test_distance_rule passed")
    test_bank_trade_with_ports()
    print("test_bank_trade_with_ports passed")
    test_dev_card_same_turn_rule()
    print("test_dev_card_same_turn_rule passed")
    print("\nAll tests passed!")
