/**
 * Board renderer — draws the hex board as SVG.
 * Handles hex layout, intersections, edges, buildings, robber, and ports.
 */

const BoardRenderer = (() => {
    const HEX_SIZE = 55;
    const SQRT3 = Math.sqrt(3);

    let svg = null;
    let hexGroup, edgeGroup, intersectionGroup, buildingGroup, labelGroup, robberGroup, portGroup;

    // Terrain colors (will be updated from config)
    let terrainColors = {};

    function init(svgElement) {
        svg = svgElement;
        svg.innerHTML = '';

        // Create layer groups (order = z-order)
        hexGroup = createGroup('hex-layer');
        portGroup = createGroup('port-layer');
        edgeGroup = createGroup('edge-layer');
        intersectionGroup = createGroup('intersection-layer');
        buildingGroup = createGroup('building-layer');
        labelGroup = createGroup('label-layer');
        robberGroup = createGroup('robber-layer');
    }

    function createGroup(id) {
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.id = id;
        svg.appendChild(g);
        return g;
    }

    function setTerrainColors(config) {
        if (config && config.terrain_types) {
            for (const [id, t] of Object.entries(config.terrain_types)) {
                terrainColors[id] = t.color;
            }
        }
    }

    // Convert axial hex coords to pixel
    function hexToPixel(q, r) {
        const x = HEX_SIZE * (SQRT3 * q + SQRT3 / 2 * r);
        const y = HEX_SIZE * (3 / 2 * r);
        return { x, y };
    }

    // Intersection pixel positions — computed from hex corners during render
    let intersectionPixels = {};

    function buildIntersectionPixels(boardState) {
        intersectionPixels = {};
        const hexes = boardState.hexes || {};
        const hexIntersections = boardState.hex_intersections || {};
        for (const [hid, hex] of Object.entries(hexes)) {
            const center = hexToPixel(hex.q, hex.r);
            const corners = hexCorners(center.x, center.y);
            const iids = hexIntersections[String(hid)] || hexIntersections[hid] || [];
            for (let i = 0; i < iids.length && i < corners.length; i++) {
                intersectionPixels[iids[i]] = corners[i];
            }
        }
    }

    function intersectionToPixel(q, r, iid) {
        if (iid !== undefined && intersectionPixels[iid]) {
            return intersectionPixels[iid];
        }
        // Fallback (shouldn't be needed after buildIntersectionPixels)
        const x = HEX_SIZE * (SQRT3 * q + SQRT3 / 2 * r);
        const y = HEX_SIZE * (3 / 2 * r);
        return { x, y };
    }

    // Hex corner positions
    function hexCorners(cx, cy) {
        const corners = [];
        for (let i = 0; i < 6; i++) {
            const angle = Math.PI / 180 * (60 * i - 30);
            corners.push({
                x: cx + HEX_SIZE * Math.cos(angle),
                y: cy + HEX_SIZE * Math.sin(angle),
            });
        }
        return corners;
    }

    function hexPointsString(cx, cy) {
        return hexCorners(cx, cy).map(c => `${c.x},${c.y}`).join(' ');
    }

    // ---------------------------------------------------------------
    // Render functions
    // ---------------------------------------------------------------

    function render(boardState, config, callbacks) {
        if (!svg || !hexGroup) return;

        // Clear all layers
        hexGroup.innerHTML = '';
        edgeGroup.innerHTML = '';
        intersectionGroup.innerHTML = '';
        buildingGroup.innerHTML = '';
        labelGroup.innerHTML = '';
        robberGroup.innerHTML = '';
        portGroup.innerHTML = '';

        if (!boardState) return;

        const hexes = boardState.hexes || {};
        const intersections = boardState.intersections || {};
        const edges = boardState.edges || {};

        // Build intersection pixel lookup from hex corners
        buildIntersectionPixels(boardState);

        // Draw hexes
        for (const [hid, hex] of Object.entries(hexes)) {
            drawHex(hex, callbacks);
        }

        // Draw ports
        for (const [iid, inter] of Object.entries(intersections)) {
            if (inter.port) {
                drawPort(iid, inter, config);
            }
        }

        // Draw edges
        for (const [eid, edge] of Object.entries(edges)) {
            drawEdge(eid, edge, intersections, callbacks);
        }

        // Draw intersections and buildings
        for (const [iid, inter] of Object.entries(intersections)) {
            drawIntersection(iid, inter, callbacks);
        }

        // Draw robber
        for (const [hid, hex] of Object.entries(hexes)) {
            if (hex.has_robber) {
                drawRobber(hex);
            }
        }

        // Auto-fit viewBox to board content
        fitViewBox();
    }

    function fitViewBox() {
        if (!svg) return;
        const bbox = svg.getBBox();
        if (bbox.width === 0 || bbox.height === 0) return;
        const pad = 30;
        svg.setAttribute('viewBox',
            `${bbox.x - pad} ${bbox.y - pad} ${bbox.width + pad * 2} ${bbox.height + pad * 2}`);
    }

    function drawHex(hex, callbacks) {
        const { x, y } = hexToPixel(hex.q, hex.r);
        const color = terrainColors[hex.terrain] || '#666';

        const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        polygon.setAttribute('points', hexPointsString(x, y));
        polygon.setAttribute('fill', color);
        polygon.classList.add('hex-tile');
        polygon.dataset.hexId = hex.id;

        if (callbacks && callbacks.onHexClick) {
            polygon.addEventListener('click', () => callbacks.onHexClick(hex.id));
        }

        hexGroup.appendChild(polygon);

        // Number token
        if (hex.number_token) {
            // Background circle
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', x);
            circle.setAttribute('cy', y);
            circle.setAttribute('r', 18);
            circle.classList.add('hex-number-bg');
            labelGroup.appendChild(circle);

            const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            text.setAttribute('x', x);
            text.setAttribute('y', y + 1);
            text.textContent = hex.number_token;
            text.classList.add('hex-number');
            if (hex.number_token === 6 || hex.number_token === 8) {
                text.classList.add('red');
            }
            labelGroup.appendChild(text);

            // Probability dots
            const dots = getDots(hex.number_token);
            if (dots > 0) {
                const dotsText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                dotsText.setAttribute('x', x);
                dotsText.setAttribute('y', y + 14);
                dotsText.setAttribute('text-anchor', 'middle');
                dotsText.setAttribute('font-size', '7');
                dotsText.setAttribute('fill', (hex.number_token === 6 || hex.number_token === 8) ? '#e74c3c' : '#bbb');
                dotsText.textContent = '\u2022'.repeat(dots);
                labelGroup.appendChild(dotsText);
            }
        }

        // Terrain label — with dark outline for readability
        const terrainY = y - (hex.number_token ? 22 : 0);
        const terrainLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        terrainLabel.setAttribute('x', x);
        terrainLabel.setAttribute('y', terrainY);
        terrainLabel.setAttribute('text-anchor', 'middle');
        terrainLabel.setAttribute('font-size', '10');
        terrainLabel.setAttribute('font-weight', 'bold');
        terrainLabel.setAttribute('fill', 'white');
        terrainLabel.setAttribute('stroke', 'rgba(0,0,0,0.7)');
        terrainLabel.setAttribute('stroke-width', '3');
        terrainLabel.setAttribute('paint-order', 'stroke');
        terrainLabel.setAttribute('pointer-events', 'none');
        terrainLabel.textContent = hex.terrain.charAt(0).toUpperCase() + hex.terrain.slice(1);
        labelGroup.appendChild(terrainLabel);
    }

    function getDots(num) {
        const probs = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };
        return probs[num] || 0;
    }

    function drawEdge(eid, edge, intersections, callbacks) {
        const aId = edge.intersections[0];
        const bId = edge.intersections[1];
        const ia = intersections[String(aId)];
        const ib = intersections[String(bId)];
        if (!ia || !ib) return;

        const pa = intersectionToPixel(ia.q, ia.r, aId);
        const pb = intersectionToPixel(ib.q, ib.r, bId);

        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', pa.x);
        line.setAttribute('y1', pa.y);
        line.setAttribute('x2', pb.x);
        line.setAttribute('y2', pb.y);
        line.classList.add('edge-line');
        line.dataset.edgeId = eid;

        if (edge.building) {
            line.classList.add('has-road');
            line.style.stroke = edge.building.player || '#fff';
            // Look up player color
        }

        if (callbacks && callbacks.onEdgeClick) {
            line.addEventListener('click', () => callbacks.onEdgeClick(parseInt(eid)));
        }

        edgeGroup.appendChild(line);
    }

    function drawIntersection(iid, inter, callbacks) {
        const { x, y } = intersectionToPixel(inter.q, inter.r, parseInt(iid));

        if (inter.building) {
            // Draw building (with click handler for city upgrades)
            const el = drawBuilding(x, y, inter.building);
            if (el) {
                el.dataset.intersectionId = iid;
                if (callbacks && callbacks.onIntersectionClick) {
                    el.addEventListener('click', () => callbacks.onIntersectionClick(parseInt(iid)));
                }
            }
        } else {
            // Draw clickable empty intersection
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', x);
            circle.setAttribute('cy', y);
            circle.setAttribute('r', 7);
            circle.classList.add('intersection');
            circle.dataset.intersectionId = iid;

            if (callbacks && callbacks.onIntersectionClick) {
                circle.addEventListener('click', () => callbacks.onIntersectionClick(parseInt(iid)));
            }

            intersectionGroup.appendChild(circle);
        }
    }

    function drawBuilding(x, y, building) {
        const color = building.player || '#fff';

        if (building.type === 'city') {
            // City = larger square
            const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect.setAttribute('x', x - 9);
            rect.setAttribute('y', y - 9);
            rect.setAttribute('width', 18);
            rect.setAttribute('height', 18);
            rect.setAttribute('rx', 3);
            rect.setAttribute('fill', color);
            rect.classList.add('building-city');
            buildingGroup.appendChild(rect);
            return rect;
        } else {
            // Settlement = circle
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', x);
            circle.setAttribute('cy', y);
            circle.setAttribute('r', 8);
            circle.setAttribute('fill', color);
            circle.classList.add('building-settlement');
            buildingGroup.appendChild(circle);
            return circle;
        }
    }

    function drawRobber(hex) {
        const { x, y } = hexToPixel(hex.q, hex.r);

        // Robber body
        const body = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
        body.setAttribute('cx', x + 20);
        body.setAttribute('cy', y + 15);
        body.setAttribute('rx', 8);
        body.setAttribute('ry', 12);
        body.classList.add('robber');
        robberGroup.appendChild(body);

        // Robber head
        const head = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        head.setAttribute('cx', x + 20);
        head.setAttribute('cy', y + 1);
        head.setAttribute('r', 6);
        head.classList.add('robber');
        robberGroup.appendChild(head);
    }

    function drawPort(iid, inter, config) {
        const { x, y } = intersectionToPixel(inter.q, inter.r, parseInt(iid));
        const portConfig = config.port_types ? config.port_types[inter.port] : null;
        if (!portConfig) return;

        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', x);
        text.setAttribute('y', y - 16);
        text.classList.add('port-indicator');
        const label = portConfig.resource
            ? `${portConfig.ratio}:1 ${portConfig.resource.charAt(0).toUpperCase() + portConfig.resource.slice(1, 3)}`
            : `${portConfig.ratio}:1`;
        text.textContent = label;
        portGroup.appendChild(text);
    }

    // ---------------------------------------------------------------
    // Highlighting for legal moves
    // ---------------------------------------------------------------

    function highlightIntersections(ids) {
        clearHighlights();
        ids.forEach(id => {
            // Check both empty intersections and buildings (for city upgrades)
            const el = intersectionGroup.querySelector(`[data-intersection-id="${id}"]`)
                    || buildingGroup.querySelector(`[data-intersection-id="${id}"]`);
            if (el) el.classList.add('highlight');
        });
    }

    function highlightEdges(ids) {
        clearHighlights();
        ids.forEach(id => {
            const el = edgeGroup.querySelector(`[data-edge-id="${id}"]`);
            if (el) el.classList.add('highlight');
        });
    }

    function highlightHexes(ids) {
        clearHighlights();
        ids.forEach(id => {
            const el = hexGroup.querySelector(`[data-hex-id="${id}"]`);
            if (el) el.classList.add('highlight');
        });
    }

    function clearHighlights() {
        svg.querySelectorAll('.highlight').forEach(el => el.classList.remove('highlight'));
    }

    // ---------------------------------------------------------------
    // Update player colors on roads/buildings
    // ---------------------------------------------------------------

    function updatePlayerColors(players) {
        // Update road colors
        edgeGroup.querySelectorAll('.has-road').forEach(line => {
            const eid = line.dataset.edgeId;
            // Color is set during render from state
        });
    }

    return {
        init,
        setTerrainColors,
        render,
        highlightIntersections,
        highlightEdges,
        highlightHexes,
        clearHighlights,
    };
})();
