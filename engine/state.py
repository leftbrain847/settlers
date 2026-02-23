"""
Game state — pure data representing the current state of a game.

All state is serializable (no functions, no circular references).
This enables save/load, undo/redo, and network sync.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional
import json
import copy


class GamePhase(str, Enum):
    LOBBY = "lobby"
    SETUP = "setup"
    PLAYING = "playing"
    FINISHED = "finished"


@dataclass
class HexTile:
    """A single hex on the board."""
    id: int
    terrain: str                     # terrain_type id
    number_token: Optional[int] = None
    has_robber: bool = False
    # Axial coordinates (q, r)
    q: int = 0
    r: int = 0


@dataclass
class Intersection:
    """A corner/vertex where up to 3 hexes meet."""
    id: int
    # Adjacent hex ids
    hex_ids: list[int] = field(default_factory=list)
    # Building placed here, if any
    building: Optional[PlacedBuilding] = None
    # Port type id if this intersection is a port
    port: Optional[str] = None
    # Axial-like coordinates for the intersection
    q: float = 0
    r: float = 0


@dataclass
class Edge:
    """An edge between two intersections."""
    id: int
    # The two intersection ids this edge connects
    intersection_ids: tuple[int, int] = (0, 0)
    # Road/building placed here, if any
    building: Optional[PlacedBuilding] = None


@dataclass
class PlacedBuilding:
    """A building that has been placed on the board."""
    building_type: str               # building_type id
    player_id: str


@dataclass
class PlayerState:
    """State for a single player."""
    id: str
    name: str
    color: str
    # Resources in hand: resource_id -> count
    resources: dict[str, int] = field(default_factory=dict)
    # Development cards in hand (not yet played): list of dev_card_type ids
    dev_cards: list[str] = field(default_factory=list)
    # Played dev cards (persistent ones, e.g. knights)
    played_dev_cards: list[str] = field(default_factory=list)
    # Building counts: building_type_id -> count placed on board
    buildings_placed: dict[str, int] = field(default_factory=dict)
    # Achievement ids currently held
    achievements: list[str] = field(default_factory=list)
    # Has played a dev card this turn?
    has_played_dev_card_this_turn: bool = False
    # Dev cards bought this turn (can't be played same turn)
    dev_cards_bought_this_turn: list[str] = field(default_factory=list)
    # VP from dev cards (hidden until game end in standard rules)
    hidden_vp: int = 0
    # Ports this player has access to (port_type ids)
    ports: list[str] = field(default_factory=list)


@dataclass
class TradeOffer:
    """An active trade offer."""
    id: str
    from_player: str
    # What the offering player gives: resource_id -> count
    offering: dict[str, int] = field(default_factory=dict)
    # What the offering player wants: resource_id -> count
    requesting: dict[str, int] = field(default_factory=dict)
    # Player ids that have accepted
    accepted_by: list[str] = field(default_factory=list)
    # Player ids that have declined
    declined_by: list[str] = field(default_factory=list)


@dataclass
class Board:
    """The full board state."""
    hexes: dict[int, HexTile] = field(default_factory=dict)
    intersections: dict[int, Intersection] = field(default_factory=dict)
    edges: dict[int, Edge] = field(default_factory=dict)
    # Lookup: hex_id -> list of intersection_ids
    hex_intersections: dict[int, list[int]] = field(default_factory=dict)
    # Lookup: intersection_id -> list of adjacent intersection_ids
    adjacent_intersections: dict[int, list[int]] = field(default_factory=dict)
    # Lookup: intersection_id -> list of edge_ids
    intersection_edges: dict[int, list[int]] = field(default_factory=dict)
    # Lookup: (intersection_a, intersection_b) -> edge_id  (sorted tuple)
    edge_between: dict[tuple[int, int], int] = field(default_factory=dict)


@dataclass
class GameState:
    """Complete state of a game in progress."""
    game_id: str = ""
    phase: GamePhase = GamePhase.LOBBY
    config_name: str = ""            # which GameConfig was used

    board: Board = field(default_factory=Board)
    players: dict[str, PlayerState] = field(default_factory=dict)
    player_order: list[str] = field(default_factory=list)

    # Turn tracking
    current_player_idx: int = 0
    current_turn_phase: int = 0      # index into config turn_phases
    turn_number: int = 0
    dice_rolled: bool = False
    last_roll: Optional[tuple[int, ...]] = None

    # Setup tracking
    setup_round: int = 0             # which setup round (0-indexed)
    setup_player_idx: int = 0
    setup_forward: bool = True       # direction in forward_reverse
    setup_settlements_placed: int = 0  # for current setup player
    setup_roads_placed: int = 0
    setup_last_settlement: Optional[int] = None  # intersection id of last setup settlement

    # Dev card deck (list of dev_card_type ids, shuffled)
    dev_card_deck: list[str] = field(default_factory=list)

    # Active trade offers
    trade_offers: dict[str, TradeOffer] = field(default_factory=dict)

    # Robber state — which hex the robber is on
    robber_hex: Optional[int] = None
    # If we're waiting for robber placement or steal choice
    pending_robber_move: bool = False
    pending_robber_steal: bool = False
    robber_steal_candidates: list[str] = field(default_factory=list)

    # Pending discards: player_id -> number of cards they must discard
    pending_discards: dict[str, int] = field(default_factory=dict)

    # Pending special actions from dev cards
    pending_action: Optional[dict[str, Any]] = None

    # Winner
    winner: Optional[str] = None

    # Event log
    log: list[dict[str, Any]] = field(default_factory=list)

    @property
    def current_player_id(self) -> Optional[str]:
        if not self.player_order:
            return None
        return self.player_order[self.current_player_idx]

    def clone(self) -> GameState:
        return copy.deepcopy(self)

    def add_log(self, event_type: str, **kwargs):
        self.log.append({"type": event_type, "turn": self.turn_number, **kwargs})

    def get_player(self, player_id: str) -> PlayerState:
        return self.players[player_id]

    def total_resources(self, player_id: str) -> int:
        return sum(self.players[player_id].resources.values())

    def visible_vp(self, player_id: str, config, include_hidden: bool = True) -> int:
        """Calculate victory points for a player.

        Args:
            include_hidden: If True, includes VP from hidden dev cards.
                Use True for win-condition checks and for the owning player's UI.
                Use False when showing VP to opponents (they shouldn't see hidden VP cards).
        """
        player = self.players[player_id]
        vp = 0
        # VP from buildings on board
        for iid, intersection in self.board.intersections.items():
            if intersection.building and intersection.building.player_id == player_id:
                bt = config.building_types.get(intersection.building.building_type)
                if bt:
                    vp += bt.vp
        # VP from achievements
        for ach_id in player.achievements:
            ach = config.achievements.get(ach_id)
            if ach:
                vp += ach.vp
        # Hidden VP (dev card VPs) — only included for owner / win checks
        if include_hidden:
            vp += player.hidden_vp
        return vp
