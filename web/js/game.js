/**
 * Game client — manages WebSocket connection, game state, and action dispatch.
 */

const Game = (() => {
    let ws = null;
    let gameId = null;
    let playerId = null;
    let state = null;
    let config = null;
    let legalActions = [];
    let buildMode = null;  // null, 'settlement', 'city', 'road'

    // Player color lookup
    let playerColors = {};

    // ---------------------------------------------------------------
    // Connection
    // ---------------------------------------------------------------

    async function createGame(playerName, numAI, settings) {
        const resp = await fetch('/api/games', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ player_name: playerName, num_ai: numAI, settings: settings || {} }),
        });
        const data = await resp.json();
        gameId = data.game_id;
        playerId = data.player_id;
        return data;
    }

    async function joinGame(gid, playerName) {
        const resp = await fetch(`/api/games/${gid}/join`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ player_name: playerName }),
        });
        const data = await resp.json();
        gameId = gid;
        playerId = data.player_id;
        return data;
    }

    async function startGame() {
        await fetch(`/api/games/${gameId}/start`, { method: 'POST' });
    }

    function connectWebSocket(onUpdate) {
        return new Promise((resolve) => {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${protocol}//${location.host}/ws/${gameId}/${playerId}`);

        ws.onopen = () => resolve();

        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);

            if (msg.type === 'init') {
                state = msg.state;
                config = msg.config;
                playerColors = {};
                for (const [pid, p] of Object.entries(state.players)) {
                    playerColors[pid] = p.color;
                }
                legalActions = msg.legal_actions || [];
                onUpdate('init');
            }
            else if (msg.type === 'state_update') {
                state = msg.state;
                legalActions = msg.legal_actions || [];
                // Update player colors
                for (const [pid, p] of Object.entries(state.players)) {
                    playerColors[pid] = p.color;
                }
                onUpdate('state_update');
            }
            else if (msg.type === 'lobby_update') {
                onUpdate('lobby_update', msg.players);
            }
            else if (msg.type === 'error') {
                onUpdate('error', msg.message);
            }
            else if (msg.type === 'legal_actions') {
                legalActions = msg.actions;
                onUpdate('legal_actions');
            }
        };

        ws.onerror = () => { onUpdate('error', 'WebSocket error'); resolve(); };
        ws.onclose = () => onUpdate('disconnected');
        });
    }

    // ---------------------------------------------------------------
    // Action dispatch
    // ---------------------------------------------------------------

    function sendAction(actionType, params) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({
            type: 'action',
            action_type: actionType,
            params: params || {},
        }));
    }

    function rollDice() {
        sendAction('roll_dice');
    }

    function endTurn() {
        sendAction('end_turn');
    }

    function buildSettlement(intersectionId) {
        sendAction('build', { building_type: 'settlement', location: intersectionId });
    }

    function buildCity(intersectionId) {
        sendAction('build', { building_type: 'city', location: intersectionId });
    }

    function buildRoad(edgeId) {
        sendAction('build', { building_type: 'road', location: edgeId });
    }

    function buyDevCard() {
        sendAction('buy_dev_card');
    }

    function playDevCard(cardType) {
        sendAction('play_dev_card', { card_type: cardType });
    }

    function tradeBank(giveResource, wantResource) {
        sendAction('trade_bank', { give_resource: giveResource, want_resource: wantResource });
    }

    function tradeOffer(offering, requesting) {
        sendAction('trade_offer', { offering, requesting });
    }

    function tradeAccept(tradeId) {
        sendAction('trade_accept', { trade_id: tradeId });
    }

    function discard(resources) {
        sendAction('discard', { resources });
    }

    function moveRobber(hexId) {
        sendAction('move_robber', { hex_id: hexId });
    }

    function steal(targetPlayer) {
        sendAction('steal', { target_player: targetPlayer });
    }

    function devCardAction(params) {
        sendAction('dev_card_action', params);
    }

    // ---------------------------------------------------------------
    // Build mode
    // ---------------------------------------------------------------

    function enterBuildMode(type) {
        buildMode = type;
    }

    function exitBuildMode() {
        buildMode = null;
        BoardRenderer.clearHighlights();
    }

    function getBuildMode() {
        return buildMode;
    }

    // ---------------------------------------------------------------
    // Legal action helpers
    // ---------------------------------------------------------------

    function canDoAction(actionType) {
        return legalActions.some(a => a.type === actionType);
    }

    function getLegalBuildLocations(buildingType) {
        return legalActions
            .filter(a => a.type === 'build' && a.building_type === buildingType)
            .map(a => a.location);
    }

    function getLegalRobberHexes() {
        return legalActions
            .filter(a => a.type === 'move_robber')
            .map(a => a.hex_id);
    }

    function getLegalStealTargets() {
        return legalActions
            .filter(a => a.type === 'steal')
            .map(a => a.target_player);
    }

    function getLegalBankTrades() {
        return legalActions.filter(a => a.type === 'trade_bank');
    }

    // ---------------------------------------------------------------
    // Getters
    // ---------------------------------------------------------------

    function getState() { return state; }
    function getConfig() { return config; }
    function getPlayerId() { return playerId; }
    function getGameId() { return gameId; }
    function getLegalActions() { return legalActions; }
    function getPlayerColor(pid) { return playerColors[pid] || '#666'; }
    function isMyTurn() {
        if (!state) return false;
        if (state.phase === 'setup') {
            return state.player_order[state.setup.player_idx] === playerId;
        }
        return state.current_player === playerId;
    }

    return {
        createGame, joinGame, startGame, connectWebSocket,
        sendAction, rollDice, endTurn,
        buildSettlement, buildCity, buildRoad,
        buyDevCard, playDevCard,
        tradeBank, tradeOffer, tradeAccept,
        discard, moveRobber, steal, devCardAction,
        enterBuildMode, exitBuildMode, getBuildMode,
        canDoAction, getLegalBuildLocations, getLegalRobberHexes,
        getLegalStealTargets, getLegalBankTrades,
        getState, getConfig, getPlayerId, getGameId,
        getLegalActions, getPlayerColor, isMyTurn,
    };
})();
