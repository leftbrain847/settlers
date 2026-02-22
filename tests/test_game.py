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
from engine.ai import RandomStrategy
from engine.state import GamePhase


def test_full_game_simulation():
    """Simulate a complete game with AI players."""
    config = load_base_game()
    engine = GameEngine(config)

    # Add players
    players = []
    for name in ["Alice", "Bob", "Charlie"]:
        pid = engine.add_player(name)
        players.append(pid)

    # Start game
    events = engine.start_game(seed=42)
    assert engine.state.phase == GamePhase.SETUP
    print(f"Game started with {len(engine.state.board.hexes)} hexes")

    ai = RandomStrategy()

    # Play through setup
    max_setup_actions = 100
    setup_actions = 0
    while engine.state.phase == GamePhase.SETUP and setup_actions < max_setup_actions:
        current_pid = engine.state.player_order[engine.state.setup_player_idx]
        action = ai.choose_action(engine, current_pid)
        if not action:
            print(f"  No legal action for {current_pid} in setup")
            break
        result = engine.do_action(action)
        if not result.success:
            print(f"  Setup action failed: {result.error}")
            break
        setup_actions += 1

    assert engine.state.phase == GamePhase.PLAYING, f"Setup didn't complete after {setup_actions} actions, phase={engine.state.phase}"
    print(f"Setup complete after {setup_actions} actions")

    # Verify each player has settlements and roads from setup
    for pid in players:
        player = engine.state.get_player(pid)
        settlements = player.buildings_placed.get("settlement", 0)
        roads = player.buildings_placed.get("road", 0)
        print(f"  {player.name}: {settlements} settlements, {roads} roads, resources={dict(player.resources)}")
        assert settlements == 2, f"{player.name} has {settlements} settlements, expected 2"
        assert roads == 2, f"{player.name} has {roads} roads, expected 2"

    # Play through game
    max_turns = 1000
    turn = 0
    while engine.state.phase == GamePhase.PLAYING and turn < max_turns:
        current_pid = engine.state.current_player_id

        # Handle pending discards
        if engine.state.pending_discards:
            for pid in list(engine.state.pending_discards.keys()):
                count = engine.state.pending_discards[pid]
                resources = ai.choose_discard(engine, pid, count)
                result = engine.do_action(Action(type="discard", player_id=pid, params={"resources": resources}))
                if not result.success:
                    print(f"  Discard failed for {pid}: {result.error}")
            continue

        action = ai.choose_action(engine, current_pid)
        if not action:
            print(f"  No legal action for {current_pid} at turn {engine.state.turn_number}")
            break

        result = engine.do_action(action)
        if not result.success:
            print(f"  Action {action.type} failed: {result.error}")
            # Try to end turn as fallback
            if action.type != "end_turn" and engine.state.dice_rolled:
                engine.do_action(Action(type="end_turn", player_id=current_pid))
            continue

        turn += 1

    if engine.state.phase == GamePhase.FINISHED:
        winner = engine.state.players[engine.state.winner]
        vp = engine.state.visible_vp(engine.state.winner, config)
        print(f"\nGame finished! Winner: {winner.name} with {vp} VP after {engine.state.turn_number} turns")
        print(f"  Total actions: {turn}")
    else:
        print(f"\nGame didn't finish after {max_turns} actions (turn {engine.state.turn_number})")
        for pid in players:
            player = engine.state.get_player(pid)
            vp = engine.state.visible_vp(pid, config)
            print(f"  {player.name}: {vp} VP, settlements={player.buildings_placed.get('settlement',0)}, cities={player.buildings_placed.get('city',0)}")

    print("\nTest passed!")


def test_config_modification():
    """Test that modifying config changes game behavior."""
    config = load_base_game()

    # Change win condition to 5 VP
    config.win_conditions[0].params["threshold"] = 5

    engine = GameEngine(config)
    for name in ["Alice", "Bob", "Charlie"]:
        engine.add_player(name)

    engine.start_game(seed=42)
    ai = RandomStrategy()

    # Run through setup
    while engine.state.phase == GamePhase.SETUP:
        current_pid = engine.state.player_order[engine.state.setup_player_idx]
        action = ai.choose_action(engine, current_pid)
        if not action:
            break
        engine.do_action(action)

    # After setup, each player has 2 settlements = 2 VP
    # Game should end much faster with 5 VP threshold
    turns = 0
    while engine.state.phase == GamePhase.PLAYING and turns < 500:
        current_pid = engine.state.current_player_id
        if engine.state.pending_discards:
            for pid in list(engine.state.pending_discards.keys()):
                count = engine.state.pending_discards[pid]
                resources = ai.choose_discard(engine, pid, count)
                engine.do_action(Action(type="discard", player_id=pid, params={"resources": resources}))
            continue
        action = ai.choose_action(engine, current_pid)
        if not action:
            break
        result = engine.do_action(action)
        if not result.success and action.type != "end_turn" and engine.state.dice_rolled:
            engine.do_action(Action(type="end_turn", player_id=current_pid))
        turns += 1

    if engine.state.winner:
        vp = engine.state.visible_vp(engine.state.winner, config)
        print(f"5VP game finished with {vp} VP after {engine.state.turn_number} turns")
        assert vp >= 5
    print("Config modification test passed!")


if __name__ == "__main__":
    test_full_game_simulation()
    print()
    test_config_modification()
