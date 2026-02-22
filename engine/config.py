"""
Configuration dataclasses for the dynamic game engine.

Every game concept is defined as a config object. The engine reads these
configs at runtime — nothing is hardcoded. To change a rule, change the
config. To add new content, register a new config object.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


# ---------------------------------------------------------------------------
# Resource types
# ---------------------------------------------------------------------------

@dataclass
class ResourceType:
    """A type of resource that can be produced and spent."""
    id: str
    name: str
    # Tile terrain type that produces this resource (e.g. "hills" -> "brick")
    terrain: Optional[str] = None


# ---------------------------------------------------------------------------
# Terrain / hex types
# ---------------------------------------------------------------------------

@dataclass
class TerrainType:
    """A type of terrain that appears on the board."""
    id: str
    name: str
    produces: Optional[str] = None   # resource_id it produces, None for desert
    color: str = "#cccccc"           # UI color


# ---------------------------------------------------------------------------
# Building types
# ---------------------------------------------------------------------------

@dataclass
class PlacementRule:
    """Defines where/how a building can be placed."""
    location_type: str               # "intersection" or "edge"
    must_be_empty: bool = True
    distance_rule: int = 0           # min distance from same-type (in edges)
    requires_connected_road: bool = False
    requires_adjacent_to_own: Optional[str] = None  # must be adjacent to this building id
    upgrades_from: Optional[str] = None  # replaces this building (e.g. city upgrades settlement)
    coastal_only: bool = False


@dataclass
class BuildingType:
    """A type of structure a player can build."""
    id: str
    name: str
    cost: dict[str, int]             # resource_id -> count
    vp: int = 0
    max_per_player: int = 99
    placement: PlacementRule = field(default_factory=PlacementRule)
    production_multiplier: int = 0   # resources received per production event
    # If this building counts toward road-length calculations
    counts_as_road: bool = False
    # If this building breaks opponent road continuity
    breaks_road: bool = False


# ---------------------------------------------------------------------------
# Port / harbor types
# ---------------------------------------------------------------------------

@dataclass
class PortType:
    """A trading port on the coast."""
    id: str
    name: str
    # What it accepts — None means "any resource" (generic port)
    resource: Optional[str] = None
    # Trade ratio: give this many of the accepted resource for 1 of anything
    ratio: int = 3


# ---------------------------------------------------------------------------
# Development card types
# ---------------------------------------------------------------------------

@dataclass
class DevCardEffect:
    """A single effect that a development card triggers."""
    type: str                        # e.g. "steal_resource", "gain_resources", "build_roads"
    params: dict[str, Any] = field(default_factory=dict)


@dataclass
class DevCardType:
    """A type of development card."""
    id: str
    name: str
    count_in_deck: int               # how many copies in the deck
    is_victory_point: bool = False   # revealed immediately? (kept secret until game end)
    playable: bool = True            # can be played on a turn?
    effects: list[DevCardEffect] = field(default_factory=list)
    # If true, card stays in front of player after playing (e.g. knight -> largest army)
    persistent: bool = False
    persistent_tag: Optional[str] = None  # tag for counting (e.g. "knight")


# ---------------------------------------------------------------------------
# Dice configuration
# ---------------------------------------------------------------------------

@dataclass
class DiceConfig:
    """How dice work in this game."""
    num_dice: int = 2
    sides_per_die: int = 6


@dataclass
class DiceOutcome:
    """What happens when a specific total is rolled."""
    total: int
    handlers: list[DiceOutcomeHandler] = field(default_factory=list)


@dataclass
class DiceOutcomeHandler:
    """A single handler for a dice outcome."""
    action: str                      # e.g. "produce_resources", "activate_robber"
    params: dict[str, Any] = field(default_factory=dict)
    # Optional condition — a string key into condition evaluators
    condition: Optional[str] = None


# ---------------------------------------------------------------------------
# Trade rules
# ---------------------------------------------------------------------------

@dataclass
class TradeRules:
    """Rules governing resource trading."""
    player_trading_enabled: bool = True
    bank_trading_enabled: bool = True
    default_bank_ratio: int = 4      # 4:1 without a port
    # Whether counter-offers are allowed in player trading
    counter_offers: bool = True


# ---------------------------------------------------------------------------
# Turn phases
# ---------------------------------------------------------------------------

@dataclass
class TurnPhase:
    """A phase within a player's turn."""
    id: str
    name: str
    allowed_actions: list[str]       # action type ids allowed in this phase
    # Phase auto-advances after this action (e.g. roll_dice -> main phase)
    auto_advance_after: Optional[str] = None
    # Max times a player can take actions in this phase (0 = unlimited)
    max_actions: int = 0


# ---------------------------------------------------------------------------
# Win conditions
# ---------------------------------------------------------------------------

@dataclass
class WinCondition:
    """A condition that ends the game with a winner."""
    type: str                        # e.g. "vp_threshold"
    params: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Special achievements (longest road, largest army, etc.)
# ---------------------------------------------------------------------------

@dataclass
class Achievement:
    """A special achievement that awards bonus VP."""
    id: str
    name: str
    vp: int = 2
    # What metric to track
    metric: str = ""                 # e.g. "road_length", "knight_count"
    # Minimum value to claim
    min_value: int = 0
    # Can be stolen by another player exceeding the current holder?
    stealable: bool = True


# ---------------------------------------------------------------------------
# Board template
# ---------------------------------------------------------------------------

@dataclass
class BoardTemplate:
    """Defines the board layout."""
    # Ring count for hexagonal board (standard Catan = 3 rings)
    num_rings: int = 3
    # Terrain distribution: terrain_id -> count
    terrain_counts: dict[str, int] = field(default_factory=dict)
    # Number tokens to place (in order of spiral placement)
    number_tokens: list[int] = field(default_factory=list)
    # Port configuration: list of (port_type_id, edge_position)
    ports: list[dict[str, Any]] = field(default_factory=list)
    # Port type distribution: port_type_id -> count
    port_counts: dict[str, int] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Setup rules
# ---------------------------------------------------------------------------

@dataclass
class SetupRules:
    """Rules for the initial game setup / placement phase."""
    min_players: int = 3
    max_players: int = 4
    # Number of initial settlement+road placements per player
    initial_placements: int = 2
    # Order pattern: "forward_reverse" = 1,2,3,4,4,3,2,1
    placement_order: str = "forward_reverse"
    # Does the last placement give starting resources?
    last_placement_gives_resources: bool = True


# ---------------------------------------------------------------------------
# Robber rules
# ---------------------------------------------------------------------------

@dataclass
class RobberRules:
    """Configuration for the robber mechanic."""
    enabled: bool = True
    # Max hand size before forced discard
    discard_threshold: int = 7
    # How many cards to discard (as a fraction of hand, rounded down)
    discard_fraction: float = 0.5
    # Can steal from adjacent player?
    steal_on_place: bool = True
    # Number of resources to steal
    steal_count: int = 1
    # Must move robber to a different hex?
    must_move: bool = True


# ---------------------------------------------------------------------------
# Full game config — bundles everything together
# ---------------------------------------------------------------------------

@dataclass
class GameConfig:
    """Complete game configuration. This single object defines all rules."""
    name: str = "Custom Game"

    resource_types: dict[str, ResourceType] = field(default_factory=dict)
    terrain_types: dict[str, TerrainType] = field(default_factory=dict)
    building_types: dict[str, BuildingType] = field(default_factory=dict)
    port_types: dict[str, PortType] = field(default_factory=dict)
    dev_card_types: dict[str, DevCardType] = field(default_factory=dict)

    dice: DiceConfig = field(default_factory=DiceConfig)
    dice_outcomes: dict[int, list[DiceOutcomeHandler]] = field(default_factory=dict)

    trade_rules: TradeRules = field(default_factory=TradeRules)
    turn_phases: list[TurnPhase] = field(default_factory=list)
    win_conditions: list[WinCondition] = field(default_factory=list)
    achievements: dict[str, Achievement] = field(default_factory=dict)

    board_template: BoardTemplate = field(default_factory=BoardTemplate)
    setup_rules: SetupRules = field(default_factory=SetupRules)
    robber: RobberRules = field(default_factory=RobberRules)
