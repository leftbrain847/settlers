/**
 * UI controller — ties Game + BoardRenderer together,
 * handles user interactions, modals, and display updates.
 */

(function () {
    // ---------------------------------------------------------------
    // Lobby
    // ---------------------------------------------------------------

    const btnStart = document.getElementById('btn-start-game');
    const btnJoin = document.getElementById('btn-join-game');

    // Settings toggle
    document.getElementById('settings-toggle').addEventListener('click', () => {
        const panel = document.getElementById('settings-panel');
        const arrow = document.getElementById('toggle-arrow');
        const visible = panel.style.display !== 'none';
        panel.style.display = visible ? 'none' : 'flex';
        arrow.classList.toggle('open', !visible);
    });

    btnStart.addEventListener('click', async () => {
        const name = document.getElementById('player-name').value || 'Player 1';
        const numAI = parseInt(document.getElementById('num-ai').value);

        // Gather settings
        const settings = {
            vp_to_win: parseInt(document.getElementById('setting-vp').value) || 10,
            board_rings: parseInt(document.getElementById('setting-rings').value) || 3,
            starting_resources: document.getElementById('setting-starting-res').value,
            friendly_robber: document.getElementById('setting-friendly-robber').checked,
        };

        btnStart.disabled = true;
        btnStart.textContent = 'Starting...';

        try {
            await Game.createGame(name, numAI, settings);

            // Switch to game screen and init renderer BEFORE starting
            // so WebSocket state updates can render immediately
            document.getElementById('lobby').style.display = 'none';
            document.getElementById('game').classList.add('active');
            document.getElementById('game-id-display').textContent = `ID: ${Game.getGameId()}`;
            BoardRenderer.init(document.getElementById('board-svg'));

            await Game.connectWebSocket(onGameUpdate);
            await Game.startGame();

            // Re-render in case state arrived before WebSocket onmessage fired
            renderAll();
        } catch (e) {
            console.error(e);
            btnStart.disabled = false;
            btnStart.textContent = 'Start Game';
        }
    });

    btnJoin.addEventListener('click', async () => {
        const gid = document.getElementById('join-game-id').value.trim();
        const name = document.getElementById('player-name').value || 'Player';
        if (!gid) return;

        try {
            await Game.joinGame(gid, name);

            document.getElementById('lobby').style.display = 'none';
            document.getElementById('game').classList.add('active');
            document.getElementById('game-id-display').textContent = `ID: ${gid}`;
            BoardRenderer.init(document.getElementById('board-svg'));

            await Game.connectWebSocket(onGameUpdate);
        } catch (e) {
            console.error(e);
        }
    });

    // ---------------------------------------------------------------
    // Game update handler
    // ---------------------------------------------------------------

    let prevState = null;

    function onGameUpdate(type, data) {
        if (type === 'init') {
            const config = Game.getConfig();
            BoardRenderer.setTerrainColors(config);
            renderAll();
        }
        else if (type === 'state_update') {
            const newState = Game.getState();
            checkNotifications(prevState, newState);
            prevState = newState ? JSON.parse(JSON.stringify(newState)) : null;
            renderAll();
            checkModals();
        }
        else if (type === 'error') {
            addLog(`Error: ${data}`);
        }
        else if (type === 'disconnected') {
            addLog('Disconnected from server.');
        }
    }

    // ---------------------------------------------------------------
    // Notifications
    // ---------------------------------------------------------------

    function showNotification(text, type) {
        const banner = document.getElementById('notification-banner');
        const div = document.createElement('div');
        div.className = 'notif ' + (type || '');
        div.textContent = text;
        banner.appendChild(div);
        setTimeout(() => div.remove(), 3200);
    }

    function checkNotifications(prev, next) {
        if (!next) return;

        // Robber activated — a 7 was rolled and it's your turn
        if (next.pending_robber_move && Game.isMyTurn()) {
            if (!prev || !prev.pending_robber_move) {
                showNotification('A 7 was rolled! Move the robber to a new hex.', 'robber');
            }
        }

        // Discard needed
        if (next.pending_discards && next.pending_discards[Game.getPlayerId()]) {
            if (!prev || !prev.pending_discards || !prev.pending_discards[Game.getPlayerId()]) {
                const count = next.pending_discards[Game.getPlayerId()];
                showNotification('You must discard ' + count + ' cards!', 'warning');
            }
        }
    }

    function renderAll() {
        const state = Game.getState();
        const config = Game.getConfig();
        if (!state) return;

        renderBoard(state, config);
        renderPlayers(state);
        renderResources(state);
        renderActions(state);
        renderDevCards(state);
        renderBankTrades(state);
        renderTopBar(state);
        renderLog(state);
        checkWinner(state);
    }

    // ---------------------------------------------------------------
    // Board rendering
    // ---------------------------------------------------------------

    function renderBoard(state, config) {
        // Enrich board data with player colors for buildings
        const boardData = JSON.parse(JSON.stringify(state.board));

        // Set player colors on buildings
        for (const [iid, inter] of Object.entries(boardData.intersections)) {
            if (inter.building) {
                inter.building.player = Game.getPlayerColor(inter.building.player);
            }
        }
        for (const [eid, edge] of Object.entries(boardData.edges)) {
            if (edge.building) {
                edge.building.player = Game.getPlayerColor(edge.building.player);
            }
        }

        BoardRenderer.render(boardData, config, {
            onHexClick: handleHexClick,
            onIntersectionClick: handleIntersectionClick,
            onEdgeClick: handleEdgeClick,
        });

        // If in build mode, highlight legal locations
        const buildMode = Game.getBuildMode();
        if (buildMode === 'settlement') {
            BoardRenderer.highlightIntersections(Game.getLegalBuildLocations('settlement'));
        } else if (buildMode === 'city') {
            BoardRenderer.highlightIntersections(Game.getLegalBuildLocations('city'));
        } else if (buildMode === 'road') {
            BoardRenderer.highlightEdges(Game.getLegalBuildLocations('road'));
        }

        // Highlight robber-movable hexes
        const state2 = Game.getState();
        if (state2 && state2.pending_robber_move && Game.isMyTurn()) {
            BoardRenderer.highlightHexes(Game.getLegalRobberHexes());
        }
    }

    // ---------------------------------------------------------------
    // Click handlers
    // ---------------------------------------------------------------

    function handleHexClick(hexId) {
        const state = Game.getState();
        if (state && state.pending_robber_move && Game.isMyTurn()) {
            Game.moveRobber(hexId);
            return;
        }
    }

    function handleIntersectionClick(iid) {
        const buildMode = Game.getBuildMode();
        if (buildMode === 'settlement') {
            const legal = Game.getLegalBuildLocations('settlement');
            if (legal.includes(iid)) {
                Game.buildSettlement(iid);
                Game.exitBuildMode();
            }
        } else if (buildMode === 'city') {
            const legal = Game.getLegalBuildLocations('city');
            if (legal.includes(iid)) {
                Game.buildCity(iid);
                Game.exitBuildMode();
            }
        } else {
            // During setup, auto-detect what's needed
            const state = Game.getState();
            if (state && state.phase === 'setup' && Game.isMyTurn()) {
                const settlementLocs = Game.getLegalBuildLocations('settlement');
                if (settlementLocs.includes(iid)) {
                    Game.buildSettlement(iid);
                }
            }
        }
    }

    function handleEdgeClick(eid) {
        const buildMode = Game.getBuildMode();
        if (buildMode === 'road') {
            const legal = Game.getLegalBuildLocations('road');
            if (legal.includes(eid)) {
                Game.buildRoad(eid);
                Game.exitBuildMode();
            }
        } else {
            // During setup, auto-build road
            const state = Game.getState();
            if (state && state.phase === 'setup' && Game.isMyTurn()) {
                const roadLocs = Game.getLegalBuildLocations('road');
                if (roadLocs.includes(eid)) {
                    Game.buildRoad(eid);
                }
            }
            // Free roads from road building card
            const pendingAction = state ? state.pending_action : null;
            if (pendingAction && pendingAction.type === 'build_free_roads') {
                const freeRoadLocs = Game.getLegalActions()
                    .filter(a => a.type === 'dev_card_action' && a.location >= 0)
                    .map(a => a.location);
                if (freeRoadLocs.includes(eid)) {
                    Game.devCardAction({ location: eid });
                }
            }
        }
    }

    // ---------------------------------------------------------------
    // Players panel
    // ---------------------------------------------------------------

    function renderPlayers(state) {
        const panel = document.getElementById('players-panel');
        panel.innerHTML = '<div class="panel-title">Players</div>';

        for (const pid of state.player_order) {
            const p = state.players[pid];
            const isMe = pid === Game.getPlayerId();
            const isCurrent = state.phase === 'setup'
                ? state.player_order[state.setup.player_idx] === pid
                : state.current_player === pid;

            const card = document.createElement('div');
            card.className = 'player-card' + (isCurrent ? ' current-turn' : '') + (isMe ? ' is-you' : '');

            let resourceHTML = '';
            if (isMe && p.resources) {
                for (const [res, count] of Object.entries(p.resources)) {
                    if (count > 0) {
                        resourceHTML += `<span class="resource-badge ${res}">${count}</span>`;
                    }
                }
            } else if (p.resource_count !== undefined) {
                resourceHTML = `<span style="font-size:0.8em;color:var(--text-dim);">${p.resource_count} cards</span>`;
            }

            let achieveHTML = '';
            if (p.achievements && p.achievements.length > 0) {
                for (const a of p.achievements) {
                    const name = a.replace('_', ' ');
                    achieveHTML += `<span class="achievement-badge">${name}</span>`;
                }
            }

            // Build stats line: knights, settlements, cities, roads, dev cards
            const knightsPlayed = (p.played_dev_cards || []).filter(c => c === 'knight').length;
            const settlements = (p.buildings_placed || {}).settlement || 0;
            const cities = (p.buildings_placed || {}).city || 0;
            const roads = (p.buildings_placed || {}).road || 0;
            const devCards = isMe ? (p.dev_cards || []).length : (p.dev_card_count || 0);

            let statsHTML = '<div class="player-stats">';
            statsHTML += `<span title="Settlements">${settlements}/5 stl</span>`;
            statsHTML += `<span title="Cities">${cities}/4 cty</span>`;
            statsHTML += `<span title="Roads">${roads}/15 rd</span>`;
            if (knightsPlayed > 0) {
                statsHTML += `<span title="Knights played" class="stat-knights">${knightsPlayed} knt</span>`;
            }
            statsHTML += `<span title="Dev cards held">${devCards} dev</span>`;
            statsHTML += '</div>';

            card.innerHTML = `
                <div class="player-name">
                    <span class="player-color-dot" style="background:${p.color}"></span>
                    ${p.name}${isMe ? ' (You)' : ''}
                    ${isCurrent ? ' ◄' : ''}
                </div>
                <div class="player-vp">${p.vp} VP</div>
                <div class="player-resources">${resourceHTML}</div>
                ${achieveHTML ? `<div class="player-achievements">${achieveHTML}</div>` : ''}
                ${statsHTML}
            `;

            panel.appendChild(card);
        }
    }

    // ---------------------------------------------------------------
    // Resources display
    // ---------------------------------------------------------------

    function renderResources(state) {
        const container = document.getElementById('your-resources');
        const me = state.players[Game.getPlayerId()];
        if (!me || !me.resources) { container.innerHTML = ''; return; }

        const config = Game.getConfig();
        const resourceList = config ? Object.keys(config.resource_types) : Object.keys(me.resources);
        const colorMap = {
            brick: 'var(--brick)', lumber: '#1a7a42', ore: 'var(--ore)',
            grain: '#c9a800', wool: 'var(--wool)',
        };

        container.innerHTML = resourceList.map(res => `
            <div class="resource-card" style="border-color:${colorMap[res] || 'var(--border)'}">
                <div class="count" style="color:${colorMap[res] || 'var(--text)'}">${me.resources[res] || 0}</div>
                <div class="label">${res.slice(0, 3)}</div>
            </div>
        `).join('');
    }

    // ---------------------------------------------------------------
    // Action buttons
    // ---------------------------------------------------------------

    function renderActions(state) {
        const container = document.getElementById('action-buttons');
        container.innerHTML = '';

        const isSetup = state.phase === 'setup';
        const myTurn = Game.isMyTurn();

        // During setup, show guidance
        if (isSetup) {
            if (myTurn) {
                const settlementLocs = Game.getLegalBuildLocations('settlement');
                const roadLocs = Game.getLegalBuildLocations('road');
                if (settlementLocs.length > 0) {
                    addInfoText(container, 'Click a highlighted spot to place your settlement');
                    BoardRenderer.highlightIntersections(settlementLocs);
                } else if (roadLocs.length > 0) {
                    addInfoText(container, 'Click an edge to place your road');
                    BoardRenderer.highlightEdges(roadLocs);
                }
            } else {
                addInfoText(container, 'Waiting for other players...');
            }
            return;
        }

        if (!myTurn) {
            // Check for trade offers I can respond to
            const tradeActions = Game.getLegalActions().filter(a => a.type === 'trade_accept');
            if (tradeActions.length > 0) {
                addInfoText(container, 'You have incoming trade offers!');
            } else {
                addInfoText(container, 'Waiting for your turn...');
            }
            return;
        }

        // Pending discard
        if (Game.getPlayerId() in (state.pending_discards || {})) {
            addInfoText(container, 'You must discard cards');
            return;
        }

        // Pending robber
        if (state.pending_robber_move) {
            addInfoText(container, 'Move the robber — click a hex');
            BoardRenderer.highlightHexes(Game.getLegalRobberHexes());
            return;
        }

        // Pending steal
        if (state.pending_robber_steal) {
            const targets = Game.getLegalStealTargets();
            addInfoText(container, 'Choose a player to steal from:');
            for (const target of targets) {
                const p = state.players[target];
                addActionBtn(container, `Steal from ${p.name}`, () => Game.steal(target));
            }
            return;
        }

        // Pending dev card action
        if (state.pending_action) {
            handlePendingAction(container, state.pending_action);
            return;
        }

        // Normal turn actions
        if (Game.canDoAction('roll_dice')) {
            addActionBtn(container, 'Roll Dice', () => Game.rollDice(), 'btn-primary');
        }

        if (Game.canDoAction('end_turn')) {
            // Build buttons
            if (Game.getLegalBuildLocations('settlement').length > 0) {
                addActionBtn(container, 'Build Settlement', () => {
                    Game.enterBuildMode('settlement');
                    BoardRenderer.highlightIntersections(Game.getLegalBuildLocations('settlement'));
                    renderActions(Game.getState());
                }, '', costDots({ brick: 1, lumber: 1, grain: 1, wool: 1 }));
            }

            if (Game.getLegalBuildLocations('city').length > 0) {
                addActionBtn(container, 'Build City', () => {
                    Game.enterBuildMode('city');
                    BoardRenderer.highlightIntersections(Game.getLegalBuildLocations('city'));
                    renderActions(Game.getState());
                }, '', costDots({ ore: 3, grain: 2 }));
            }

            if (Game.getLegalBuildLocations('road').length > 0) {
                addActionBtn(container, 'Build Road', () => {
                    Game.enterBuildMode('road');
                    BoardRenderer.highlightEdges(Game.getLegalBuildLocations('road'));
                    renderActions(Game.getState());
                }, '', costDots({ brick: 1, lumber: 1 }));
            }

            if (Game.canDoAction('buy_dev_card')) {
                addActionBtn(container, 'Buy Dev Card', () => Game.buyDevCard(), '',
                    costDots({ ore: 1, grain: 1, wool: 1 }));
            }

            if (Game.canDoAction('trade_offer')) {
                addActionBtn(container, 'Trade with Players', () => showTradeOfferModal());
            }

            addActionBtn(container, 'End Turn', () => Game.endTurn(), 'btn-secondary');
        }

        // Cancel build mode
        if (Game.getBuildMode()) {
            container.innerHTML = '';
            addInfoText(container, `Placing ${Game.getBuildMode()} — click on a highlighted spot`);
            addActionBtn(container, 'Cancel', () => {
                Game.exitBuildMode();
                renderAll();
            }, 'btn-secondary');
        }
    }

    function handlePendingAction(container, pa) {
        if (pa.type === 'choose_resources') {
            showResourcePickerModal(pa.count, (resources) => {
                Game.devCardAction({ resources });
            });
            addInfoText(container, `Choose ${pa.count} resources (see popup)`);
        }
        else if (pa.type === 'choose_monopoly_resource') {
            showMonopolyModal();
            addInfoText(container, 'Choose a resource for Monopoly (see popup)');
        }
        else if (pa.type === 'build_free_roads') {
            // Free road legal locations come as dev_card_action with location field
            const freeRoadActions = Game.getLegalActions().filter(a => a.type === 'dev_card_action' && a.location >= 0);
            const roadLocs = freeRoadActions.map(a => a.location);
            addInfoText(container, `Place free road (${pa.remaining} remaining) — click an edge`);
            if (roadLocs.length > 0) {
                BoardRenderer.highlightEdges(roadLocs);
            } else {
                addInfoText(container, 'No legal road locations — skipping remaining free roads');
                Game.devCardAction({ location: -1, skip: true });
            }
        }
    }

    function addActionBtn(container, text, onClick, extraClass, costHTML) {
        const btn = document.createElement('button');
        btn.className = 'action-btn ' + (extraClass || '');
        btn.innerHTML = text + (costHTML || '');
        btn.addEventListener('click', onClick);
        container.appendChild(btn);
    }

    function addInfoText(container, text) {
        const div = document.createElement('div');
        div.style.cssText = 'color: var(--text-dim); font-size: 0.85em; padding: 4px 0;';
        div.textContent = text;
        container.appendChild(div);
    }

    function costDots(cost) {
        const colorMap = {
            brick: 'var(--brick)', lumber: '#1a7a42', ore: 'var(--ore)',
            grain: '#c9a800', wool: 'var(--wool)',
        };
        let html = '<span class="cost">';
        for (const [res, count] of Object.entries(cost)) {
            for (let i = 0; i < count; i++) {
                html += `<span class="cost-dot" style="background:${colorMap[res] || '#666'}"></span>`;
            }
        }
        html += '</span>';
        return html;
    }

    // ---------------------------------------------------------------
    // Dev cards display
    // ---------------------------------------------------------------

    function renderDevCards(state) {
        const section = document.getElementById('dev-cards-section');
        const list = document.getElementById('dev-cards-list');
        const me = state.players[Game.getPlayerId()];

        if (!me || !me.dev_cards || me.dev_cards.length === 0) {
            section.style.display = 'none';
            return;
        }

        section.style.display = 'block';
        list.innerHTML = '';

        // Count cards by type
        const counts = {};
        for (const card of me.dev_cards) {
            counts[card] = (counts[card] || 0) + 1;
        }

        for (const [cardType, count] of Object.entries(counts)) {
            const config = Game.getConfig();
            const cardConfig = config && config.building_types ? null : null; // dev cards aren't in building_types
            const name = cardType.replace(/_/g, ' ');
            const canPlay = Game.getLegalActions().some(a => a.type === 'play_dev_card' && a.card_type === cardType);

            const item = document.createElement('div');
            item.className = 'dev-card-item';
            item.textContent = `${name} (x${count})`;
            if (canPlay) {
                item.style.cursor = 'pointer';
                item.style.borderColor = 'var(--accent2)';
                item.addEventListener('click', () => Game.playDevCard(cardType));
            } else {
                item.style.opacity = '0.6';
            }
            list.appendChild(item);
        }
    }

    // ---------------------------------------------------------------
    // Bank trade display
    // ---------------------------------------------------------------

    function renderBankTrades(state) {
        const area = document.getElementById('bank-trade-area');
        const trades = Game.getLegalBankTrades();

        if (trades.length === 0) {
            area.innerHTML = '<span style="font-size:0.8em;color:var(--text-dim);">No bank trades available</span>';
            return;
        }

        // Group by give_resource
        const byGive = {};
        for (const t of trades) {
            if (!byGive[t.give_resource]) byGive[t.give_resource] = [];
            byGive[t.give_resource].push(t.want_resource);
        }

        area.innerHTML = '';
        for (const [give, wants] of Object.entries(byGive)) {
            const me = state.players[Game.getPlayerId()];
            // Determine ratio
            let ratio = 4; // default
            if (me.ports) {
                const config = Game.getConfig();
                for (const portId of me.ports) {
                    const pt = config.port_types ? config.port_types[portId] : null;
                    if (pt) {
                        if (!pt.resource) ratio = Math.min(ratio, pt.ratio);
                        else if (pt.resource === give) ratio = Math.min(ratio, pt.ratio);
                    }
                }
            }

            const row = document.createElement('div');
            row.style.cssText = 'margin-bottom:6px;';
            row.innerHTML = `<span style="font-size:0.8em;color:var(--text-dim);">Give ${ratio} ${give} for:</span>`;

            const btns = document.createElement('div');
            btns.style.cssText = 'display:flex;gap:4px;margin-top:3px;flex-wrap:wrap;';
            for (const want of wants) {
                const btn = document.createElement('button');
                btn.className = 'btn btn-small btn-secondary';
                btn.textContent = want;
                btn.addEventListener('click', () => Game.tradeBank(give, want));
                btns.appendChild(btn);
            }
            row.appendChild(btns);
            area.appendChild(row);
        }
    }

    // ---------------------------------------------------------------
    // Top bar
    // ---------------------------------------------------------------

    function renderTopBar(state) {
        const phase = document.getElementById('game-phase');
        const turnInd = document.getElementById('turn-indicator');
        const diceDisplay = document.getElementById('dice-display');
        const remaining = document.getElementById('dev-cards-remaining');

        phase.textContent = state.phase.charAt(0).toUpperCase() + state.phase.slice(1);

        const currentPlayer = state.phase === 'setup'
            ? state.players[state.player_order[state.setup.player_idx]]
            : state.players[state.current_player];

        if (currentPlayer) {
            turnInd.textContent = `${currentPlayer.name}'s turn`;
            turnInd.style.background = currentPlayer.color;
            turnInd.style.color = 'white';
        }

        if (state.last_roll) {
            diceDisplay.style.display = 'flex';
            document.getElementById('die1').textContent = state.last_roll[0];
            document.getElementById('die2').textContent = state.last_roll[1];
            document.getElementById('dice-total').textContent = `= ${state.last_roll.reduce((a, b) => a + b, 0)}`;
        } else {
            diceDisplay.style.display = 'none';
        }

        remaining.textContent = `${state.dev_cards_remaining} dev cards left`;
    }

    // ---------------------------------------------------------------
    // Log
    // ---------------------------------------------------------------

    function renderLog(state) {
        const log = document.getElementById('game-log');
        if (!state.log) return;

        log.innerHTML = state.log.slice(-15).map(entry => {
            const playerName = entry.player ? (state.players[entry.player] ? state.players[entry.player].name : entry.player) : '';
            return `<div class="log-entry"><span class="player-name-log">${playerName}</span> ${formatLogEntry(entry)}</div>`;
        }).join('');
        log.scrollTop = log.scrollHeight;
    }

    function formatLogEntry(entry) {
        switch (entry.type) {
            case 'dice_rolled': return `rolled ${entry.total} (${entry.rolls.join(', ')})`;
            case 'build': return `built ${entry.building}`;
            case 'buy_dev_card': return 'bought a development card';
            case 'play_dev_card': return `played ${entry.card}`;
            case 'trade_bank': return `traded with bank`;
            case 'trade_accept': return 'accepted a trade';
            case 'steal': return `stole from ${entry.target}`;
            case 'move_robber': return 'moved the robber';
            case 'discard': return 'discarded cards';
            case 'end_turn': return 'ended their turn';
            case 'game_started': return 'Game started!';
            case 'setup_complete': return 'Setup complete!';
            case 'game_won': return `won the game with ${entry.vp} VP!`;
            default: return entry.type;
        }
    }

    function addLog(text) {
        const log = document.getElementById('game-log');
        log.innerHTML += `<div class="log-entry">${text}</div>`;
        log.scrollTop = log.scrollHeight;
    }

    // ---------------------------------------------------------------
    // Modals
    // ---------------------------------------------------------------

    function checkModals() {
        const state = Game.getState();
        if (!state) return;

        // Check for discard
        const myDiscard = state.pending_discards ? state.pending_discards[Game.getPlayerId()] : null;
        if (myDiscard) {
            showDiscardModal(myDiscard);
        }

        // Check for pending action modals
        if (state.pending_action && Game.isMyTurn()) {
            if (state.pending_action.type === 'choose_resources') {
                showResourcePickerModal(state.pending_action.count, (resources) => {
                    Game.devCardAction({ resources });
                });
            } else if (state.pending_action.type === 'choose_monopoly_resource') {
                showMonopolyModal();
            }
        }

        // Check for incoming trades
        if (state.trade_offers) {
            for (const [tid, offer] of Object.entries(state.trade_offers)) {
                if (offer.from_player !== Game.getPlayerId()) {
                    showIncomingTradeModal(tid, offer, state);
                }
            }
        }
    }

    function showDiscardModal(count) {
        const modal = document.getElementById('discard-modal');
        const picker = document.getElementById('discard-picker');
        const msg = document.getElementById('discard-message');
        const state = Game.getState();
        const me = state.players[Game.getPlayerId()];

        msg.textContent = `You must discard ${count} cards.`;

        const selected = {};
        const config = Game.getConfig();
        const resources = config ? Object.keys(config.resource_types) : Object.keys(me.resources);

        function renderPicker() {
            picker.innerHTML = resources.map(res => {
                const have = me.resources[res] || 0;
                const sel = selected[res] || 0;
                return `
                    <div class="resource-pick">
                        <div style="font-size:0.75em;color:var(--text-dim);">${res}</div>
                        <div style="font-size:0.8em;">have: ${have}</div>
                        <div class="pick-count">${sel}</div>
                        <div>
                            <button data-res="${res}" data-dir="down">-</button>
                            <button data-res="${res}" data-dir="up">+</button>
                        </div>
                    </div>
                `;
            }).join('');

            picker.querySelectorAll('button').forEach(btn => {
                btn.addEventListener('click', () => {
                    const res = btn.dataset.res;
                    const dir = btn.dataset.dir;
                    if (dir === 'up' && (selected[res] || 0) < (me.resources[res] || 0)) {
                        selected[res] = (selected[res] || 0) + 1;
                    } else if (dir === 'down' && (selected[res] || 0) > 0) {
                        selected[res] = (selected[res] || 0) - 1;
                    }
                    renderPicker();
                });
            });
        }

        renderPicker();
        modal.classList.add('active');

        document.getElementById('btn-confirm-discard').onclick = () => {
            const total = Object.values(selected).reduce((a, b) => a + b, 0);
            if (total !== count) {
                alert(`Must discard exactly ${count} cards (selected ${total})`);
                return;
            }
            Game.discard(selected);
            modal.classList.remove('active');
        };
    }

    function showResourcePickerModal(count, onConfirm) {
        const modal = document.getElementById('resource-picker-modal');
        const picker = document.getElementById('resource-picker');
        const title = document.getElementById('resource-picker-title');
        title.textContent = `Choose ${count} Resources`;

        const selected = {};
        const config = Game.getConfig();
        const resources = config ? Object.keys(config.resource_types) : ['brick', 'lumber', 'ore', 'grain', 'wool'];

        function renderPicker() {
            picker.innerHTML = resources.map(res => {
                const sel = selected[res] || 0;
                return `
                    <div class="resource-pick">
                        <div style="font-size:0.75em;color:var(--text-dim);">${res}</div>
                        <div class="pick-count">${sel}</div>
                        <div>
                            <button data-res="${res}" data-dir="down">-</button>
                            <button data-res="${res}" data-dir="up">+</button>
                        </div>
                    </div>
                `;
            }).join('');

            picker.querySelectorAll('button').forEach(btn => {
                btn.addEventListener('click', () => {
                    const res = btn.dataset.res;
                    const dir = btn.dataset.dir;
                    const total = Object.values(selected).reduce((a, b) => a + b, 0);
                    if (dir === 'up' && total < count) {
                        selected[res] = (selected[res] || 0) + 1;
                    } else if (dir === 'down' && (selected[res] || 0) > 0) {
                        selected[res] = (selected[res] || 0) - 1;
                    }
                    renderPicker();
                });
            });
        }

        renderPicker();
        modal.classList.add('active');

        document.getElementById('btn-confirm-resource-pick').onclick = () => {
            const total = Object.values(selected).reduce((a, b) => a + b, 0);
            if (total !== count) {
                alert(`Must choose exactly ${count} resources (selected ${total})`);
                return;
            }
            onConfirm(selected);
            modal.classList.remove('active');
        };
    }

    function showMonopolyModal() {
        const modal = document.getElementById('monopoly-modal');
        const choices = document.getElementById('monopoly-choices');
        const config = Game.getConfig();
        const resources = config ? Object.keys(config.resource_types) : ['brick', 'lumber', 'ore', 'grain', 'wool'];

        choices.innerHTML = '';
        for (const res of resources) {
            const btn = document.createElement('button');
            btn.className = 'action-btn';
            btn.textContent = res;
            btn.addEventListener('click', () => {
                Game.devCardAction({ resource: res });
                modal.classList.remove('active');
            });
            choices.appendChild(btn);
        }
        modal.classList.add('active');
    }

    const resColors = {
        brick: '#c0392b', lumber: '#1a7a42', ore: '#7f8c8d',
        grain: '#c9a800', wool: '#2ecc71',
    };

    function showTradeOfferModal() {
        const modal = document.getElementById('trade-offer-modal');
        const state = Game.getState();
        const me = state.players[Game.getPlayerId()];
        const config = Game.getConfig();
        const resources = config ? Object.keys(config.resource_types) : Object.keys(me.resources);

        const give = {};
        const want = {};

        function renderCards() {
            // Give side — show your resources as clickable cards
            const giveCards = document.getElementById('trade-give-cards');
            giveCards.innerHTML = '';
            for (const res of resources) {
                const have = me.resources[res] || 0;
                const selected = give[res] || 0;
                const card = document.createElement('div');
                card.className = 'trade-res-card' + (selected > 0 ? ' selected' : '');
                card.style.borderColor = selected > 0 ? (resColors[res] || 'var(--accent2)') : '';
                card.innerHTML = `
                    <div class="res-count">${selected}</div>
                    <div class="res-name">${res.slice(0, 4)}</div>
                    <div class="res-have">(${have})</div>
                `;
                card.addEventListener('click', (e) => {
                    if (e.shiftKey && (give[res] || 0) > 0) {
                        give[res] = (give[res] || 0) - 1;
                    } else if ((give[res] || 0) < have) {
                        give[res] = (give[res] || 0) + 1;
                    }
                    renderCards();
                });
                card.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    if ((give[res] || 0) > 0) {
                        give[res] = (give[res] || 0) - 1;
                        renderCards();
                    }
                });
                giveCards.appendChild(card);
            }

            // Want side
            const wantCards = document.getElementById('trade-want-cards');
            wantCards.innerHTML = '';
            for (const res of resources) {
                const selected = want[res] || 0;
                const card = document.createElement('div');
                card.className = 'trade-res-card' + (selected > 0 ? ' selected' : '');
                card.style.borderColor = selected > 0 ? (resColors[res] || 'var(--accent2)') : '';
                card.innerHTML = `
                    <div class="res-count">${selected}</div>
                    <div class="res-name">${res.slice(0, 4)}</div>
                `;
                card.addEventListener('click', (e) => {
                    if (e.shiftKey && (want[res] || 0) > 0) {
                        want[res] = (want[res] || 0) - 1;
                    } else {
                        want[res] = (want[res] || 0) + 1;
                    }
                    renderCards();
                });
                card.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    if ((want[res] || 0) > 0) {
                        want[res] = (want[res] || 0) - 1;
                        renderCards();
                    }
                });
                wantCards.appendChild(card);
            }

            // Summaries
            const giveSummary = Object.entries(give).filter(([, v]) => v > 0).map(([r, c]) => `${c} ${r}`).join(', ');
            const wantSummary = Object.entries(want).filter(([, v]) => v > 0).map(([r, c]) => `${c} ${r}`).join(', ');
            document.getElementById('trade-give-summary').textContent = giveSummary || 'Click to add';
            document.getElementById('trade-want-summary').textContent = wantSummary || 'Click to add';
        }

        renderCards();
        modal.classList.add('active');

        document.getElementById('btn-send-trade').onclick = () => {
            const offering = {};
            const requesting = {};
            for (const [k, v] of Object.entries(give)) { if (v > 0) offering[k] = v; }
            for (const [k, v] of Object.entries(want)) { if (v > 0) requesting[k] = v; }
            if (Object.keys(offering).length === 0 || Object.keys(requesting).length === 0) {
                showNotification('Must offer and request something', 'warning');
                return;
            }
            Game.tradeOffer(offering, requesting);
            modal.classList.remove('active');
        };

        document.getElementById('btn-cancel-trade').onclick = () => {
            modal.classList.remove('active');
        };
    }

    function showIncomingTradeModal(tradeId, offer, state) {
        const modal = document.getElementById('incoming-trade-modal');
        const display = document.getElementById('incoming-trade-display');
        const offerer = state.players[offer.from_player];

        function resChips(obj) {
            return Object.entries(obj).filter(([, c]) => c > 0).map(([r, c]) =>
                `<span class="res-chip" style="color:${resColors[r] || 'var(--text)'}">${c} ${r}</span>`
            ).join('');
        }

        display.innerHTML = `
            <div class="incoming-trade-side">
                <div class="label">${offerer.name} gives</div>
                <div class="resources">${resChips(offer.offering)}</div>
            </div>
            <div class="trade-arrow">&#x21C4;</div>
            <div class="incoming-trade-side">
                <div class="label">You give</div>
                <div class="resources">${resChips(offer.requesting)}</div>
            </div>
        `;

        modal.classList.add('active');

        document.getElementById('btn-accept-trade').onclick = () => {
            Game.tradeAccept(tradeId);
            modal.classList.remove('active');
        };

        document.getElementById('btn-decline-trade').onclick = () => {
            modal.classList.remove('active');
        };
    }

    function checkWinner(state) {
        if (state.winner) {
            const winner = state.players[state.winner];
            document.getElementById('winner-name').textContent = `${winner.name} wins with ${winner.vp} VP!`;
            document.getElementById('winner-overlay').classList.add('active');
        }
    }
})();
