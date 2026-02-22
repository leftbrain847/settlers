"""
Standard Settlers of Catan rules — defined entirely as config objects.

To create a variant, copy this and modify. Or override specific fields.
"""

from engine.config import (
    GameConfig, ResourceType, TerrainType, BuildingType, PlacementRule,
    PortType, DevCardType, DevCardEffect, DiceConfig, DiceOutcomeHandler,
    TradeRules, TurnPhase, WinCondition, Achievement, BoardTemplate,
    SetupRules, RobberRules,
)


def load_base_game() -> GameConfig:
    """Load the standard Catan game configuration."""

    # ---------------------------------------------------------------
    # Resources
    # ---------------------------------------------------------------
    resource_types = {
        "brick": ResourceType(id="brick", name="Brick", terrain="hills"),
        "lumber": ResourceType(id="lumber", name="Lumber", terrain="forest"),
        "ore": ResourceType(id="ore", name="Ore", terrain="mountains"),
        "grain": ResourceType(id="grain", name="Grain", terrain="fields"),
        "wool": ResourceType(id="wool", name="Wool", terrain="pasture"),
    }

    # ---------------------------------------------------------------
    # Terrains
    # ---------------------------------------------------------------
    terrain_types = {
        "hills": TerrainType(id="hills", name="Hills", produces="brick", color="#c0392b"),
        "forest": TerrainType(id="forest", name="Forest", produces="lumber", color="#27ae60"),
        "mountains": TerrainType(id="mountains", name="Mountains", produces="ore", color="#7f8c8d"),
        "fields": TerrainType(id="fields", name="Fields", produces="grain", color="#f1c40f"),
        "pasture": TerrainType(id="pasture", name="Pasture", produces="wool", color="#2ecc71"),
        "desert": TerrainType(id="desert", name="Desert", produces=None, color="#f0e68c"),
    }

    # ---------------------------------------------------------------
    # Buildings
    # ---------------------------------------------------------------
    building_types = {
        "settlement": BuildingType(
            id="settlement",
            name="Settlement",
            cost={"brick": 1, "lumber": 1, "grain": 1, "wool": 1},
            vp=1,
            max_per_player=5,
            placement=PlacementRule(
                location_type="intersection",
                must_be_empty=True,
                distance_rule=1,
                requires_connected_road=True,
            ),
            production_multiplier=1,
        ),
        "city": BuildingType(
            id="city",
            name="City",
            cost={"ore": 3, "grain": 2},
            vp=2,
            max_per_player=4,
            placement=PlacementRule(
                location_type="intersection",
                upgrades_from="settlement",
            ),
            production_multiplier=2,
        ),
        "road": BuildingType(
            id="road",
            name="Road",
            cost={"brick": 1, "lumber": 1},
            vp=0,
            max_per_player=15,
            placement=PlacementRule(
                location_type="edge",
                must_be_empty=True,
            ),
            counts_as_road=True,
        ),
        # Dev card as a purchasable "building" (cost only, no placement)
        "dev_card": BuildingType(
            id="dev_card",
            name="Development Card",
            cost={"ore": 1, "grain": 1, "wool": 1},
            vp=0,
            max_per_player=99,
            placement=PlacementRule(location_type="none"),
        ),
    }

    # ---------------------------------------------------------------
    # Ports
    # ---------------------------------------------------------------
    port_types = {
        "generic": PortType(id="generic", name="3:1 Port", resource=None, ratio=3),
        "brick_port": PortType(id="brick_port", name="Brick Port", resource="brick", ratio=2),
        "lumber_port": PortType(id="lumber_port", name="Lumber Port", resource="lumber", ratio=2),
        "ore_port": PortType(id="ore_port", name="Ore Port", resource="ore", ratio=2),
        "grain_port": PortType(id="grain_port", name="Grain Port", resource="grain", ratio=2),
        "wool_port": PortType(id="wool_port", name="Wool Port", resource="wool", ratio=2),
    }

    # ---------------------------------------------------------------
    # Development cards
    # ---------------------------------------------------------------
    dev_card_types = {
        "knight": DevCardType(
            id="knight",
            name="Knight",
            count_in_deck=14,
            effects=[DevCardEffect(type="activate_robber")],
            persistent=True,
            persistent_tag="knight",
        ),
        "road_building": DevCardType(
            id="road_building",
            name="Road Building",
            count_in_deck=2,
            effects=[DevCardEffect(type="build_roads", params={"count": 2})],
        ),
        "year_of_plenty": DevCardType(
            id="year_of_plenty",
            name="Year of Plenty",
            count_in_deck=2,
            effects=[DevCardEffect(type="gain_resources", params={"count": 2})],
        ),
        "monopoly": DevCardType(
            id="monopoly",
            name="Monopoly",
            count_in_deck=2,
            effects=[DevCardEffect(type="monopoly")],
        ),
        "victory_point": DevCardType(
            id="victory_point",
            name="Victory Point",
            count_in_deck=5,
            is_victory_point=True,
            playable=False,
        ),
    }

    # ---------------------------------------------------------------
    # Dice
    # ---------------------------------------------------------------
    dice = DiceConfig(num_dice=2, sides_per_die=6)

    # What happens on each roll total
    dice_outcomes = {
        7: [DiceOutcomeHandler(action="activate_robber")],
        # All other totals produce resources (handled by default in engine)
    }

    # ---------------------------------------------------------------
    # Trading
    # ---------------------------------------------------------------
    trade_rules = TradeRules(
        player_trading_enabled=True,
        bank_trading_enabled=True,
        default_bank_ratio=4,
        counter_offers=True,
    )

    # ---------------------------------------------------------------
    # Turn phases
    # ---------------------------------------------------------------
    turn_phases = [
        TurnPhase(
            id="pre_roll",
            name="Pre-Roll",
            allowed_actions=["roll_dice", "play_dev_card"],
            auto_advance_after="roll_dice",
        ),
        TurnPhase(
            id="main",
            name="Main Phase",
            allowed_actions=["build", "buy_dev_card", "play_dev_card",
                           "trade_bank", "trade_offer", "end_turn"],
        ),
    ]

    # ---------------------------------------------------------------
    # Win conditions
    # ---------------------------------------------------------------
    win_conditions = [
        WinCondition(type="vp_threshold", params={"threshold": 10}),
    ]

    # ---------------------------------------------------------------
    # Achievements
    # ---------------------------------------------------------------
    achievements = {
        "longest_road": Achievement(
            id="longest_road",
            name="Longest Road",
            vp=2,
            metric="road_length",
            min_value=5,
        ),
        "largest_army": Achievement(
            id="largest_army",
            name="Largest Army",
            vp=2,
            metric="knight_count",
            min_value=3,
        ),
    }

    # ---------------------------------------------------------------
    # Board template (standard 3-ring Catan board)
    # ---------------------------------------------------------------
    board_template = BoardTemplate(
        num_rings=3,
        terrain_counts={
            "hills": 3,
            "forest": 4,
            "mountains": 3,
            "fields": 4,
            "pasture": 4,
            "desert": 1,
        },
        number_tokens=[2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12],
        port_counts={
            "generic": 4,
            "brick_port": 1,
            "lumber_port": 1,
            "ore_port": 1,
            "grain_port": 1,
            "wool_port": 1,
        },
    )

    # ---------------------------------------------------------------
    # Setup rules
    # ---------------------------------------------------------------
    setup_rules = SetupRules(
        min_players=2,  # Allow 2 for testing, standard is 3
        max_players=4,
        initial_placements=2,
        placement_order="forward_reverse",
        last_placement_gives_resources=True,
    )

    # ---------------------------------------------------------------
    # Robber
    # ---------------------------------------------------------------
    robber = RobberRules(
        enabled=True,
        discard_threshold=7,
        discard_fraction=0.5,
        steal_on_place=True,
        steal_count=1,
        must_move=True,
    )

    return GameConfig(
        name="Standard Catan",
        resource_types=resource_types,
        terrain_types=terrain_types,
        building_types=building_types,
        port_types=port_types,
        dev_card_types=dev_card_types,
        dice=dice,
        dice_outcomes=dice_outcomes,
        trade_rules=trade_rules,
        turn_phases=turn_phases,
        win_conditions=win_conditions,
        achievements=achievements,
        board_template=board_template,
        setup_rules=setup_rules,
        robber=robber,
    )
