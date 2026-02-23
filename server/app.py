"""
FastAPI server — HTTP + WebSocket API for the game.

Supports multiple concurrent games, human + AI players,
and real-time updates via WebSocket.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import uuid
from typing import Any, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.config import GameConfig, WinCondition
from engine.engine import GameEngine
from engine.actions import Action
from engine.ai import RandomStrategy, SmartStrategy, AIStrategy
from definitions.base_game import load_base_game


app = FastAPI(title="Settlers Engine")

# ---------------------------------------------------------------------------
# Game manager — tracks active games
# ---------------------------------------------------------------------------

class GameManager:
    def __init__(self):
        self.games: dict[str, GameEngine] = {}
        self.ai_players: dict[str, dict[str, AIStrategy]] = {}  # game_id -> {player_id -> strategy}
        self.connections: dict[str, dict[str, WebSocket]] = {}  # game_id -> {player_id -> ws}
        self.ai_flags: dict[str, set[str]] = {}  # game_id -> set of AI player_ids
        self.game_settings: dict[str, dict] = {}  # game_id -> settings dict

    def create_game(self, config: Optional[GameConfig] = None) -> GameEngine:
        cfg = config or load_base_game()
        engine = GameEngine(cfg)
        self.games[engine.state.game_id] = engine
        self.connections[engine.state.game_id] = {}
        self.ai_players[engine.state.game_id] = {}
        self.ai_flags[engine.state.game_id] = set()
        return engine

    def get_game(self, game_id: str) -> Optional[GameEngine]:
        return self.games.get(game_id)

    def add_ai_player(self, game_id: str, player_id: str, strategy: Optional[AIStrategy] = None):
        self.ai_players[game_id][player_id] = strategy or SmartStrategy()
        self.ai_flags[game_id].add(player_id)

    def is_ai(self, game_id: str, player_id: str) -> bool:
        return player_id in self.ai_flags.get(game_id, set())


manager = GameManager()


# ---------------------------------------------------------------------------
# REST API
# ---------------------------------------------------------------------------

@app.post("/api/games")
async def create_game(body: dict = None):
    body = body or {}
    settings = body.get("settings", {})

    # Apply settings to config
    config = load_base_game()

    if settings.get("vp_to_win"):
        vp = int(settings["vp_to_win"])
        config.win_conditions = [WinCondition(type="vp_threshold", params={"threshold": vp})]

    if settings.get("board_rings") and int(settings["board_rings"]) != 3:
        rings = int(settings["board_rings"])
        config.board_template.num_rings = rings
        # Adjust terrain counts for smaller/larger boards
        if rings == 2:
            config.board_template.terrain_counts = {
                "hills": 1, "forest": 2, "mountains": 1,
                "fields": 1, "pasture": 1, "desert": 1,
            }
            config.board_template.number_tokens = [3, 4, 5, 6, 8, 9]
            config.board_template.port_counts = {"generic": 2, "brick_port": 1, "lumber_port": 1}

    if settings.get("friendly_robber"):
        config.robber.friendly_turns = 3  # store for engine to use

    engine = manager.create_game(config)
    manager.game_settings[engine.state.game_id] = settings

    num_ai = body.get("num_ai", 0)
    player_name = body.get("player_name", "Player 1")

    # Add human player
    human_id = engine.add_player(player_name)

    # Add AI players
    ai_ids = []
    for i in range(num_ai):
        ai_name = f"Bot {i + 1}"
        ai_id = engine.add_player(ai_name, is_ai=True)
        manager.add_ai_player(engine.state.game_id, ai_id)
        ai_ids.append(ai_id)

    return {
        "game_id": engine.state.game_id,
        "player_id": human_id,
        "ai_players": ai_ids,
        "players": [{"id": p.id, "name": p.name} for p in engine.state.players.values()],
    }


@app.post("/api/games/{game_id}/join")
async def join_game(game_id: str, body: dict = None):
    body = body or {}
    engine = manager.get_game(game_id)
    if not engine:
        raise HTTPException(404, "Game not found")

    name = body.get("player_name", f"Player {len(engine.state.players) + 1}")
    pid = engine.add_player(name)
    return {"player_id": pid, "game_id": game_id}


@app.post("/api/games/{game_id}/start")
async def start_game(game_id: str):
    engine = manager.get_game(game_id)
    if not engine:
        raise HTTPException(404, "Game not found")

    try:
        events = engine.start_game()
    except ValueError as e:
        raise HTTPException(400, str(e))

    # Apply starting resources if configured
    settings = manager.game_settings.get(game_id, {})
    starting_res = settings.get("starting_resources", "none")
    if starting_res != "none":
        import random
        res_types = list(engine.config.resource_types.keys())
        count = 5 if starting_res == "some" else 10
        for pid, player in engine.state.players.items():
            for _ in range(count):
                res = random.choice(res_types)
                player.resources[res] = player.resources.get(res, 0) + 1

    # Broadcast to all connected players
    await broadcast_state(game_id)

    # Run AI for setup if first player is AI
    await run_ai_turns(game_id)

    return {"events": events}


@app.post("/api/games/{game_id}/action")
async def do_action(game_id: str, body: dict):
    engine = manager.get_game(game_id)
    if not engine:
        raise HTTPException(404, "Game not found")

    action = Action(
        type=body["type"],
        player_id=body["player_id"],
        params=body.get("params", {}),
    )
    result = engine.do_action(action)

    if not result.success:
        raise HTTPException(400, result.error)

    # Broadcast updated state
    await broadcast_state(game_id)

    # Run AI turns if applicable
    await run_ai_turns(game_id)

    return {"events": result.events}


@app.get("/api/games/{game_id}/state/{player_id}")
async def get_state(game_id: str, player_id: str):
    engine = manager.get_game(game_id)
    if not engine:
        raise HTTPException(404, "Game not found")
    return engine.get_state_for_player(player_id)


@app.get("/api/games/{game_id}/legal-actions/{player_id}")
async def get_legal_actions(game_id: str, player_id: str):
    engine = manager.get_game(game_id)
    if not engine:
        raise HTTPException(404, "Game not found")
    return {"actions": engine.get_legal_actions(player_id)}


@app.get("/api/games/{game_id}/config")
async def get_config(game_id: str):
    engine = manager.get_game(game_id)
    if not engine:
        raise HTTPException(404, "Game not found")
    config = engine.config
    return {
        "name": config.name,
        "resource_types": {k: {"id": v.id, "name": v.name} for k, v in config.resource_types.items()},
        "terrain_types": {k: {"id": v.id, "name": v.name, "color": v.color, "produces": v.produces} for k, v in config.terrain_types.items()},
        "building_types": {k: {"id": v.id, "name": v.name, "cost": v.cost, "vp": v.vp} for k, v in config.building_types.items()},
        "port_types": {k: {"id": v.id, "name": v.name, "ratio": v.ratio, "resource": v.resource} for k, v in config.port_types.items()},
    }


# ---------------------------------------------------------------------------
# WebSocket for real-time updates
# ---------------------------------------------------------------------------

@app.websocket("/ws/{game_id}/{player_id}")
async def websocket_endpoint(websocket: WebSocket, game_id: str, player_id: str):
    engine = manager.get_game(game_id)
    if not engine:
        await websocket.close(code=4004, reason="Game not found")
        return

    await websocket.accept()
    manager.connections[game_id][player_id] = websocket

    try:
        # Send initial state (include legal_actions so client can render immediately)
        state = engine.get_state_for_player(player_id)
        legal = engine.get_legal_actions(player_id)
        config_data = {
            "resource_types": {k: {"id": v.id, "name": v.name} for k, v in engine.config.resource_types.items()},
            "terrain_types": {k: {"id": v.id, "name": v.name, "color": v.color, "produces": v.produces} for k, v in engine.config.terrain_types.items()},
            "building_types": {k: {"id": v.id, "name": v.name, "cost": v.cost, "vp": v.vp, "max_per_player": v.max_per_player} for k, v in engine.config.building_types.items()},
            "port_types": {k: {"id": v.id, "name": v.name, "ratio": v.ratio, "resource": v.resource} for k, v in engine.config.port_types.items()},
        }
        await websocket.send_json({"type": "init", "state": state, "config": config_data, "legal_actions": legal})

        # Listen for actions
        while True:
            data = await websocket.receive_json()

            if data.get("type") == "action":
                action = Action(
                    type=data["action_type"],
                    player_id=player_id,
                    params=data.get("params", {}),
                )
                result = engine.do_action(action)

                if result.success:
                    await broadcast_state(game_id)
                    # Let AI bots respond to trade offers
                    if data["action_type"] == "trade_offer":
                        await handle_ai_trade_responses(game_id)
                    await run_ai_turns(game_id)
                else:
                    await websocket.send_json({"type": "error", "message": result.error})

            elif data.get("type") == "get_legal_actions":
                actions = engine.get_legal_actions(player_id)
                await websocket.send_json({"type": "legal_actions", "actions": actions})

    except WebSocketDisconnect:
        if game_id in manager.connections:
            manager.connections[game_id].pop(player_id, None)


# ---------------------------------------------------------------------------
# Broadcasting
# ---------------------------------------------------------------------------

async def broadcast_state(game_id: str):
    """Send updated state to all connected players."""
    engine = manager.get_game(game_id)
    if not engine:
        return
    connections = manager.connections.get(game_id, {})
    for pid, ws in list(connections.items()):
        try:
            state = engine.get_state_for_player(pid)
            legal = engine.get_legal_actions(pid)
            await ws.send_json({
                "type": "state_update",
                "state": state,
                "legal_actions": legal,
            })
        except Exception:
            connections.pop(pid, None)


# ---------------------------------------------------------------------------
# AI turn execution
# ---------------------------------------------------------------------------

async def handle_ai_trade_responses(game_id: str):
    """Let AI players evaluate and respond to active trade offers."""
    engine = manager.get_game(game_id)
    if not engine:
        return

    # Copy trade offers since accepting modifies the dict
    for tid, offer in list(engine.state.trade_offers.items()):
        if tid not in engine.state.trade_offers:
            continue  # Already resolved
        for pid in engine.state.player_order:
            if pid == offer.from_player:
                continue
            if not manager.is_ai(game_id, pid):
                continue
            strategy = manager.ai_players[game_id][pid]
            if strategy.evaluate_trade(engine, pid, offer.offering, offer.requesting, offer.from_player):
                action = Action(type="trade_accept", player_id=pid,
                              params={"trade_id": tid})
                result = engine.do_action(action)
                if result.success:
                    await broadcast_state(game_id)
                    await asyncio.sleep(0.5)
                break  # Trade completed, move on


async def run_ai_turns(game_id: str):
    """Run AI player turns until it's a human player's turn."""
    engine = manager.get_game(game_id)
    if not engine:
        return

    max_iterations = 200  # safety limit
    iterations = 0

    while iterations < max_iterations:
        iterations += 1

        if engine.state.phase.value == "finished":
            break

        # Check for pending AI discards first
        if engine.state.pending_discards:
            handled_discard = False
            for pid in list(engine.state.pending_discards.keys()):
                if manager.is_ai(game_id, pid):
                    strategy = manager.ai_players[game_id][pid]
                    count = engine.state.pending_discards[pid]
                    resources = strategy.choose_discard(engine, pid, count)
                    action = Action(type="discard", player_id=pid, params={"resources": resources})
                    engine.do_action(action)
                    handled_discard = True
            if handled_discard:
                await broadcast_state(game_id)
                continue
            else:
                break  # Waiting for human to discard

        # Get current player
        if engine.state.phase.value == "setup":
            current = engine.state.player_order[engine.state.setup_player_idx]
        elif engine.state.phase.value == "playing":
            current = engine.state.current_player_id
        else:
            break

        if not manager.is_ai(game_id, current):
            break

        strategy = manager.ai_players[game_id][current]
        action = strategy.choose_action(engine, current)
        if not action:
            break

        # Handle special AI decisions
        if action.type == "move_robber" and "hex_id" not in action.params:
            action.params["hex_id"] = strategy.choose_robber_hex(engine, current)
        if action.type == "steal" and "target_player" not in action.params:
            target = strategy.choose_steal_target(engine, current)
            if target:
                action.params["target_player"] = target
        if action.type == "dev_card_action":
            pa = engine.state.pending_action
            if pa and pa["type"] == "choose_monopoly_resource":
                if "resource" not in action.params:
                    action.params["resource"] = strategy.choose_monopoly_resource(engine, current)
            elif pa and pa["type"] == "choose_resources":
                if "resources" not in action.params:
                    action.params["resources"] = strategy.choose_year_of_plenty(engine, current, pa["count"])
            elif pa and pa["type"] == "build_free_roads":
                # Location already in params from legal action; handle skip
                if action.params.get("skip") or action.params.get("location") == -1:
                    pass  # Will be handled by the handler

        result = engine.do_action(action)
        if not result.success:
            # AI made an invalid move — try to recover by clearing stuck state
            if engine.state.pending_action:
                engine.state.pending_action = None
            break

        # Check for error events that indicate the action didn't actually work
        has_error = any(e.get("type") == "error" for e in result.events)
        if has_error:
            # Clear stuck pending actions to prevent infinite loops
            if engine.state.pending_action:
                engine.state.pending_action = None
            break

        await broadcast_state(game_id)

        # Longer delay for visible actions so human can follow
        if action.type in ("roll_dice", "build", "end_turn", "buy_dev_card", "play_dev_card"):
            await asyncio.sleep(0.8)
        elif action.type in ("move_robber", "steal"):
            await asyncio.sleep(0.5)
        else:
            await asyncio.sleep(0.2)


# ---------------------------------------------------------------------------
# Static file serving
# ---------------------------------------------------------------------------

# Serve the web UI
web_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")

@app.get("/")
async def index():
    return FileResponse(os.path.join(web_dir, "index.html"))

# Mount static files
app.mount("/static", StaticFiles(directory=web_dir), name="static")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
