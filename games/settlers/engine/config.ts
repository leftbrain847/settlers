// Game rules as plain JSON-serializable data. See definitions/base_game.py (oracle) for the source.

/** @returns {import('./types.ts').GameConfig} */
import type { GameConfig, Settings } from './types.ts';

/** Seats per game, bots included. Six matches the six player colours in every theme. */
export const MAX_PLAYERS = 6;

export function baseGame(): GameConfig {
  return {
    name: 'Standard Catan',
    resource_types: {
      clay: { id: 'clay', name: 'Clay', terrain: 'hills' },
      wood: { id: 'wood', name: 'Wood', terrain: 'forest' },
      rock: { id: 'rock', name: 'Rock', terrain: 'mountains' },
      wheat: { id: 'wheat', name: 'Wheat', terrain: 'fields' },
      sheep: { id: 'sheep', name: 'Sheep', terrain: 'pasture' },
    },
    terrain_types: {
      hills: { id: 'hills', name: 'Clay', produces: 'clay', color: '#c0392b' },
      forest: { id: 'forest', name: 'Wood', produces: 'wood', color: '#27ae60' },
      mountains: { id: 'mountains', name: 'Rock', produces: 'rock', color: '#7f8c8d' },
      fields: { id: 'fields', name: 'Wheat', produces: 'wheat', color: '#f1c40f' },
      pasture: { id: 'pasture', name: 'Sheep', produces: 'sheep', color: '#2ecc71' },
      desert: { id: 'desert', name: 'Desert', produces: null, color: '#f0e68c' },
    },
    building_types: {
      settlement: {
        id: 'settlement', name: 'Settlement',
        cost: { clay: 1, wood: 1, wheat: 1, sheep: 1 },
        vp: 1, max_per_player: 5,
        placement: {
          location_type: 'intersection', must_be_empty: true, distance_rule: 1,
          requires_connected_road: true, upgrades_from: null,
        },
        production_multiplier: 1, counts_as_road: false,
      },
      city: {
        id: 'city', name: 'City',
        cost: { rock: 3, wheat: 2 },
        vp: 2, max_per_player: 4,
        placement: {
          location_type: 'intersection', must_be_empty: true, distance_rule: 0,
          requires_connected_road: false, upgrades_from: 'settlement',
        },
        production_multiplier: 2, counts_as_road: false,
      },
      road: {
        id: 'road', name: 'Road',
        cost: { clay: 1, wood: 1 },
        vp: 0, max_per_player: 15,
        placement: {
          location_type: 'edge', must_be_empty: true, distance_rule: 0,
          requires_connected_road: false, upgrades_from: null,
        },
        production_multiplier: 0, counts_as_road: true,
      },
      dev_card: {
        id: 'dev_card', name: 'Development Card',
        cost: { rock: 1, wheat: 1, sheep: 1 },
        vp: 0, max_per_player: 99,
        placement: {
          location_type: 'none', must_be_empty: true, distance_rule: 0,
          requires_connected_road: false, upgrades_from: null,
        },
        production_multiplier: 0, counts_as_road: false,
      },
    },
    port_types: {
      generic: { id: 'generic', name: '3:1 Port', resource: null, ratio: 3 },
      clay_port: { id: 'clay_port', name: 'Clay Port', resource: 'clay', ratio: 2 },
      wood_port: { id: 'wood_port', name: 'Wood Port', resource: 'wood', ratio: 2 },
      rock_port: { id: 'rock_port', name: 'Rock Port', resource: 'rock', ratio: 2 },
      wheat_port: { id: 'wheat_port', name: 'Wheat Port', resource: 'wheat', ratio: 2 },
      sheep_port: { id: 'sheep_port', name: 'Sheep Port', resource: 'sheep', ratio: 2 },
    },
    dev_card_types: {
      knight: {
        id: 'knight', name: 'Knight', count_in_deck: 14, is_victory_point: false, playable: true,
        effects: [{ type: 'activate_robber', params: {} }],
        persistent: true, persistent_tag: 'knight',
      },
      road_building: {
        id: 'road_building', name: 'Road Building', count_in_deck: 2, is_victory_point: false, playable: true,
        effects: [{ type: 'build_roads', params: { count: 2 } }],
        persistent: false, persistent_tag: null,
      },
      year_of_plenty: {
        id: 'year_of_plenty', name: 'Year of Plenty', count_in_deck: 2, is_victory_point: false, playable: true,
        effects: [{ type: 'gain_resources', params: { count: 2 } }],
        persistent: false, persistent_tag: null,
      },
      monopoly: {
        id: 'monopoly', name: 'Monopoly', count_in_deck: 2, is_victory_point: false, playable: true,
        effects: [{ type: 'monopoly', params: {} }],
        persistent: false, persistent_tag: null,
      },
      victory_point: {
        id: 'victory_point', name: 'Victory Point', count_in_deck: 5, is_victory_point: true, playable: false,
        effects: [], persistent: false, persistent_tag: null,
      },
    },
    dice: { num_dice: 2, sides_per_die: 6 },
    dice_outcomes: { 7: [{ action: 'activate_robber', params: {} }] },
    trade_rules: {
      player_trading_enabled: true,
      bank_trading_enabled: true,
      default_bank_ratio: 4,
      counter_offers: true,
      // Timers are enforced by the transport (trade_expire), never by the reducer.
      human_response_timer: 70, // seconds humans get to answer an offer; bots answer instantly
      counter_timer: 15,
      bot_offer_timer: 20,      // how long a bot's offer waits on humans before it is withdrawn
    },
    turn_phases: [
      { id: 'pre_roll', name: 'Pre-Roll', allowed_actions: ['roll_dice', 'play_dev_card'], auto_advance_after: 'roll_dice' },
      { id: 'main', name: 'Main Phase', allowed_actions: ['build', 'buy_dev_card', 'play_dev_card', 'trade_bank', 'trade_offer', 'end_turn'] },
    ],
    win_conditions: [{ type: 'vp_threshold', params: { threshold: 10 } }],
    achievements: {
      longest_road: { id: 'longest_road', name: 'Longest Road', vp: 2, metric: 'road_length', min_value: 5 },
      largest_army: { id: 'largest_army', name: 'Largest Army', vp: 2, metric: 'knight_count', min_value: 3 },
    },
    board_template: {
      num_rings: 3,
      terrain_counts: { hills: 3, forest: 4, mountains: 3, fields: 4, pasture: 4, desert: 1 },
      number_tokens: [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12],
      port_counts: { generic: 4, clay_port: 1, wood_port: 1, rock_port: 1, wheat_port: 1, sheep_port: 1 },
    },
    setup_rules: {
      min_players: 2, max_players: MAX_PLAYERS, initial_placements: 2,
      placement_order: 'forward_reverse', last_placement_gives_resources: true,
    },
    robber: {
      enabled: true, discard_threshold: 7, discard_fraction: 0.5,
      steal_on_place: true, steal_count: 1, must_move: true,
      friendly_turns: 0, // no stealing while turn_number <= friendly_turns
    },
  };
}

function applyBoardSize(cfg: GameConfig, rings: number): void {
  const totalHexes = 3 * rings * (rings - 1) + 1;
  const numDeserts = Math.max(1, Math.floor(totalHexes / 19));
  const producing = totalHexes - numDeserts;

  const terrains = ['hills', 'forest', 'mountains', 'fields', 'pasture'];
  const base = Math.floor(producing / terrains.length);
  const rem = producing % terrains.length;
  const counts: Record<string, number> = {};
  terrains.forEach((t, i) => { counts[t] = base + (i < rem ? 1 : 0); });
  counts.desert = numDeserts;
  cfg.board_template.terrain_counts = counts;

  const standard = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];
  const tokens = [];
  while (tokens.length < producing) tokens.push(...standard);
  cfg.board_template.number_tokens = tokens.slice(0, producing);

  const targetPorts = Math.max(3, Math.round(9 * (totalHexes / 19)));
  const numGeneric = Math.max(1, Math.round((targetPorts * 4) / 9));
  const remaining = targetPorts - numGeneric;
  const specific = ['clay_port', 'wood_port', 'rock_port', 'wheat_port', 'sheep_port'];
  const per = Math.max(1, Math.floor(remaining / specific.length));
  const portCounts: Record<string, number> = { generic: numGeneric };
  for (const sp of specific) portCounts[sp] = per;
  cfg.board_template.port_counts = portCounts;
}

const int = (v: unknown): number => Math.trunc(Number(v));

/** Build a config from the lobby settings form. Unknown keys are ignored. */
export function configFromSettings(settings: Settings = {}): GameConfig {
  const cfg = baseGame();
  if (settings.vp_to_win) {
    cfg.win_conditions = [{ type: 'vp_threshold', params: { threshold: int(settings.vp_to_win) } }];
  }
  if (settings.board_rings) {
    const rings = int(settings.board_rings);
    cfg.board_template.num_rings = rings;
    if (rings !== 3) applyBoardSize(cfg, rings);
  }
  if (settings.friendly_robber) cfg.robber.friendly_turns = 3;
  if ('discard_threshold' in settings) cfg.robber.discard_threshold = int(settings.discard_threshold);
  if ('max_roads' in settings) cfg.building_types.road.max_per_player = int(settings.max_roads);
  if ('max_settlements' in settings) cfg.building_types.settlement.max_per_player = int(settings.max_settlements);
  if ('max_cities' in settings) cfg.building_types.city.max_per_player = int(settings.max_cities);
  if (settings.dev_cards) {
    for (const [id, n] of Object.entries(settings.dev_cards)) {
      if (cfg.dev_card_types[id]) cfg.dev_card_types[id].count_in_deck = int(n);
    }
  }
  if (settings.port_counts) {
    cfg.board_template.port_counts = Object.fromEntries(
      Object.entries(settings.port_counts).map(([k, v]) => [k, int(v)]));
  }
  if ('human_response_timer' in settings) cfg.trade_rules.human_response_timer = int(settings.human_response_timer);
  if ('counter_timer' in settings) cfg.trade_rules.counter_timer = int(settings.counter_timer);
  if ('bot_offer_timer' in settings) cfg.trade_rules.bot_offer_timer = int(settings.bot_offer_timer);
  return cfg;
}
