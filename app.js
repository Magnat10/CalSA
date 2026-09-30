import { normalize, catalog, category, solve, ITEM_NAMES } from './calculator.js';

const $ = s => document.querySelector(s); const $$ = s => document.querySelectorAll(s);
const E = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Globaler Notfall-Scanner
window.addEventListener('error', function(e) {
    const view = $('#view');
    if(view) view.innerHTML = `<div style="padding:20px; color:#ef4444; background:#341919; border:1px solid #702f2f; border-radius:6px; margin:15px;"><b>System-Fehler:</b> ${e.message}</div>`;
});

let recipes = [];
let items = [];
let plan = null;
let view = 'network';
let iconRegistry = {};
let whitelist = null;

const config = {
    selectedNodeId: null, 
    recipeSelections: {},
    machineConfig: {}
};

const panZoom = { zoom: 1, x: 0, y: 0, isDragging: false, startX: 0, startY: 0 };

async function fetchWithFallback(url) {
    let res = await fetch(url).catch(() => null);
    if (!res || !res.ok) {
        res = await fetch(url + '?nocache=' + Date.now()).catch(() => null);
    }
    return res;
}

async function init() {
    try {
        const [recRes, iconRes, whiteRes] = await Promise.all([
            fetchWithFallback('de.json'), // <--- Hier wurde auf de.json umgestellt
            fetchWithFallback('icons.json'),
            fetchWithFallback('scim-item-whitelist.json')
        ]);

        if (!recRes || !recRes.ok) throw new Error("de.json konnte nicht geladen werden.");
        
        const rawData = await recRes.json();
        recipes = normalize(rawData);
        
        if (!recipes || recipes.length === 0) throw new Error("Die Rezept-Datenbank ist leer oder fehlerhaft.");

        iconRegistry = iconRes && iconRes.ok ? await iconRes.json() : {};
        whitelist = whiteRes && whiteRes.ok ? await whiteRes.json() : null;

        const allItems = catalog(recipes);

        const catMap = whitelist && whitelist.categories ? whitelist.categories : {};
        const idMap = whitelist && whitelist.known_scim_ids ? whitelist.known_scim_ids : {};
        const allowedNames = new Set(Object.values(catMap).flat());
        const allowedIds = new Set(Object.values(idMap));
        const hasWhitelist = allowedNames.size > 0 || allowedIds.size > 0;

        items = allItems.filter(i => !hasWhitelist || allowedIds.has(i.id) || allowedNames.has(i.name));

        if (items.length === 0) throw new Error("Nach dem Filtern sind keine Items mehr übrig.");

        const catByName = new Map();
        Object.entries(catMap).forEach(([cat, names]) => names.forEach(n => catByName.set(n, cat)));
        
        const grouped = {};
        items.forEach(i => {
            const k = catByName.get(i.name) || category(i.name);
            if (!grouped[k]) grouped[k] = [];
            grouped[k].push(i);
        });

        $('#product').innerHTML = Object.keys(grouped).sort().map(k =>
            `<optgroup label="${E(k)}">${grouped[k].map(i => `<option value="${i.id}">${E(i.name)}</option>`).join('')}</optgroup>`
        ).join('');

        bindEvents();
        setupPanZoom();

        let defaultItem = items.find(x => x.id === 'Desc_IronPlateReinforced_C') || items[0];
        if (defaultItem) {
            $('#product').value = defaultItem.id;
            $('#rate').value = 20;
            config.selectedNodeId = defaultItem.id;
            onProductChange();
        }

    } catch (e) {
        const viewEl = $('#view');
        if (viewEl) {
            viewEl.innerHTML = `<div style="padding: 20px; margin: 15px; color: #ffbbb4; background: #341919; border: 1px solid #702f2f; border-radius: 8px;">
                <b>⚠ Initialisierungsfehler</b><br><br>${E(e.message)}
            </div>`;
        }
        $('#product').innerHTML = `<option>Fehler</option>`;
    }
}

function bindEvents() {
    $('#product').addEventListener('change', onProductChange);
    $('#rate').addEventListener('input', calc);
    $('#belt').addEventListener('change', calc);

    $('#recipe').addEventListener('change', (e) => {
        if (config.selectedNodeId) {
            config.recipeSelections[config.selectedNodeId] = e.target.value;
            calc();
        }
    });

    $('#machine-tier').addEventListener('change', (e) => {
        if (config.selectedNodeId) {
            if (!config.machineConfig[config.selectedNodeId]) config.machineConfig[config.selectedNodeId] = {};
            config.machineConfig[config.selectedNodeId].tier = parseInt(e.target.value) || 1;
            calc();
        }
    });

    $('#clock').addEventListener('input', (e) => {
        if (config.selectedNodeId) {
            if (!config.machineConfig[config.selectedNodeId]) config.machineConfig[config.selectedNodeId] = {};
            config.machineConfig[config.selectedNodeId].clock = parseInt(e.target.value) || 100;
            calc();
        }
    });

    $$('.tabs button').forEach(b => {         b.addEventListener('click', () => {             view = b.dataset.view;             $$
('.tabs button').forEach(x => x.classList.toggle('active', x === b));
            render();
        });
    });
}

function onProductChange() {
    config.selectedNodeId = $('#product').value;
    refreshConfigUI();
    calc();
    panZoom.zoom = 1; panZoom.x = 20; panZoom.y = 20;
    applyPanZoom();
}

function refreshConfigUI() {
    const id = config.selectedNodeId;
    if (!id) return;
    const itemRecipes = recipes.filter(r => r.products?.some(p => p.item === id));
    $('#recipe').innerHTML = itemRecipes.map(r =>
        `<option value="${r.id}">${r.alternate ? 'Alternativ: ' : 'Standard: '}${E(r.name)}</option>`
    ).join('');
    if (config.recipeSelections[id]) {
        $('#recipe').value = config.recipeSelections[id];
    } else if (itemRecipes.length) {
        $('#recipe').value = itemRecipes[0].id;
    }
    const mCfg = config.machineConfig[id] || { tier: 1, clock: 100 };
    $('#machine-tier').value = mCfg.tier;
    $('#clock').value = mCfg.clock;
}

function calc() {
    const id = $('#product').value;
    const rate = parseFloat($('#rate').value) || 0;
    if (!id || rate <= 0) return;
    plan = solve(id, rate, recipes, {
        maxBelt: $('#belt').value,
        recipeSelections: config.recipeSelections,
        machineConfig: config.machineConfig
    });
    updateDashStats();
    render();
    updatePreviews();
}

function updateDashStats() {
    if (!plan) return;
    $('#machines').textContent = plan.totals.machineCount.toFixed(2) + 'x';
    $('#power').textContent = plan.totals.power.toFixed(0) + ' MW';
    $('#raw').textContent = plan.totals.rawRate.toFixed(1);
}

window.iconSvg = t => {
    if (t === 'ore') return `<svg viewBox="0 0 24 24"><path d="M7.2 3.5h9.6l4.7 8.1-4.7 8.1H7.2l-4.7-8.1 4.7-8.1Z"/><path d="m8.2 14.8 3.8-7 3.8 7H8.2Z"/></svg>`;
    if (t === 'machine') return `<svg viewBox="0 0 24 24"><path d="M3 20V9l5 3V8l5 3V4h4v5l4 2v9H3Z"/><path d="M7 16h2m3 0h2m3 0h2"/></svg>`;
    return `<svg viewBox="0 0 24 24"><path d="m12 2 8 4.5v9L12 20l-8-4.5v-9L12 2Z"/><path d="m4.5 6.8 7.5 4.3 7.5-4.3M12 11v9"/></svg>`;
};

function iconFor(id, type = 'item') {
    const rec = iconRegistry[id];
    const cls = `ph icon-${type}`;
    if (rec?.icon) return `<div class="${cls}"><img src="${E(rec.icon)}" alt="" loading="lazy" onerror="this.parentElement.innerHTML=window.iconSvg('${type}')"></div>`;
    return `<div class="${cls}">${window.iconSvg(type)}</div>`;
}

const nm = id => ITEM_NAMES[id] || items.find(x => x.id === id)?.name || id.replace(/^Desc_/, '').replace(/_C$/, '');

function render() {
    if (!plan) return;
    const titles = {
        network: ['⌘ Netzwerkgraph', 'Materialflüsse und Maschinen'],
        tree: ['♜ Baumstruktur', 'Hierarchische Ansicht'],
        items: ['◇ Gegenstände', 'Alle benötigten Items'],
        machines: ['▥ Gebäude', 'Benötigte Maschinen']
    };
    $('#view-title').textContent = titles[view][0];
    $('#view-subtitle').textContent = titles[view][1];
    $('.graph-tools').style.display = (view === 'network') ? 'flex' : 'none';$('#legend').style.display = (view === 'network') ? 'flex' : 'none';

    if (view === 'network') renderNetwork();
    else if (view === 'tree') renderTree();
    else if (view === 'items') renderItems();
    else if (view === 'machines') renderMachines();
}

function renderNetwork() {
    const levels = {};
    plan.nodes.forEach(n => {
        if (!levels[n.depth]) levels[n.depth] = [];
        levels[n.depth].push(n);
    });

    const max = Math.max(0, ...Object.keys(levels).map(Number));
    let html = '<div class="network">';
    
    for (let d = max; d >= 0; d--) {
        if (!levels[d]) continue;
        html += `<div class="level">`;
        levels[d].forEach(n => {
            const isSelected = n.itemId === config.selectedNodeId;
            const activeStyle = isSelected ? 'box-shadow: 0 0 0 2px var(--orange); border-color: var(--orange);' : '';
            html += `
            <div class="net-node" data-id="${n.itemId}" style="cursor:pointer; ${activeStyle}">
                <div class="round">${iconFor(n.itemId, n.type === 'raw' ? 'ore' : 'item')}</div>
                <div class="node-copy">
                    <b>${E(n.name)}</b>
                    <span>${n.rate.toFixed(1)} / min</span>
                    ${n.type === 'prod' ? `<em>${n.count.toFixed(2)}x</em><small>${E(n.machine.name)}</small>` : '<small>Rohstoff</small>'}
                </div>
            </div>`;
        });
        html += `</div>`;
        if (d > 0) {
            const depthEdges = plan.edges.filter(e => {
                const fromNode = plan.nodes.find(x => x.id === e.from);
                return fromNode && fromNode.depth === d;
            });
            const hasDanger = depthEdges.some(x => x.bottleneck);
            const e = depthEdges[0]; 
            html += `<div class="connector ${hasDanger ? 'danger' : ''}"><span>${e ? `${e.flow.toFixed(1)} / min · Mk.${e.mk}` : ''}</span></div>`;
        }
    }
    html += '</div>';
    
    if (plan.warnings && plan.warnings.length > 0) {
        html += `<div style="position:absolute; bottom:10px; left:10px; right:10px; background:rgba(239,68,68,0.2); color:#fca5a5; padding:10px; border-radius:6px; border:1px solid rgba(239,68,68,0.4); font-size:11px; z-index: 10;">⚠ ${plan.warnings.map(E).join('<br>')}</div>`;
    }

    $('#view').innerHTML = html;     applyPanZoom();      $$('#view .net-node').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            config.selectedNodeId = el.dataset.id;
            refreshConfigUI();
            renderNetwork();
        });
    });
}

function renderTreeHTML(n, isRoot = false) {
    if (!n) return '';
    let html = `
    <div class="tree-node" style="margin-top: ${isRoot ? '0' : '10px'};">
        <div class="tree-row">
            ${iconFor(n.itemId, n.type === 'raw' ? 'ore' : 'item')}
            <div>
                <b>${E(n.name)} <span>(${n.rate.toFixed(1)} / min)</span></b>
                <small>${n.type === 'prod' ? `${n.count.toFixed(2)}x${E(n.machine?.name || 'Machine')}` : (n.name.includes('Kreislauf') ? 'Kreislauf' : 'Rohstoff')}</small>
            </div>
        </div>`;
        
    if (n.children && n.children.length > 0) {
        html += `<div class="children">`;
        n.children.forEach(c => html += renderTreeHTML(c));
        html += `</div>`;
    }
    html += `</div>`;
    return html;
}

function renderTree() {
    $('#view').innerHTML = `<div style="padding:15px;">${renderTreeHTML(plan.root, true)}</div>`;
}

function renderItems() {
    const rows = Object.entries(plan.totals.items).sort((a,b)=>b[1]-a[1]).map(([id, v]) => `
        <div class="data-row">
            <div style="display:flex; align-items:center; gap:10px;">
                ${iconFor(id, plan.totals.raw[id] ? 'ore' : 'item')}
                <b>${E(nm(id))}</b>
            </div>
            <div style="text-align:right;">
                <span>${v.toFixed(1)}</span>
                <br><small>${plan.totals.raw[id] ? 'Rohstoff' : 'Zwischenprodukt'}</small>
            </div>
        </div>
    `).join('');
    $('#view').innerHTML = `<div style="padding:10px;">${rows}</div>`;
}

function renderMachines() {
    const rows = Object.values(plan.totals.machines).sort((a,b)=>b.count-a.count).map(m => `
        <div class="data-row">
            <div style="display:flex; align-items:center; gap:10px;">
                ${iconFor(m.id || m.name, 'machine')}
                <b>${E(m.name)}</b>
            </div>
            <div style="text-align:right;">
                <span>${m.count.toFixed(2)}x</span>
                <br><small>${m.power.toFixed(0)} MW (Total: ${m.powerTotal.toFixed(1)} MW)</small>
            </div>
        </div>
    `).join('');
    $('#view').innerHTML = `<div style="padding:10px;">${rows}</div>`;
}

function updatePreviews() {
    $('#tree-preview').innerHTML = renderTreeHTML(plan.root, true);
    const itemRows = Object.entries(plan.totals.items).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([id, v]) => `
        <div class="data-row" style="padding:4px 0; border: none;">
            <b>${E(nm(id))}</b><span>${v.toFixed(1)}</span>
        </div>
    `).join('');
    $('#items-preview').innerHTML = itemRows || '<div style="color:var(--muted); padding:10px;">Keine Items</div>';

    const machRows = Object.values(plan.totals.machines).sort((a,b)=>b.count-a.count).slice(0,5).map(m => `
        <div class="data-row" style="padding:4px 0; border: none;">
            <b>${E(m.name)}</b><span>${m.count.toFixed(2)}x</span>
        </div>
    `).join('');
    $('#machines-preview').innerHTML = machRows || '<div style="color:var(--muted); padding:10px;">Keine Maschinen</div>';
}

function setupPanZoom() {
    const viewEl = $('#view');
    viewEl.addEventListener('wheel', e => {
        if (view !== 'network') return;
        e.preventDefault();
        const rect = viewEl.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const zoomFactor = e.deltaY < 0 ? 1.12 : 0.89;
        const newZoom = Math.max(0.3, Math.min(2.5, panZoom.zoom * zoomFactor));
        panZoom.x = mouseX - (mouseX - panZoom.x) * (newZoom / panZoom.zoom);
        panZoom.y = mouseY - (mouseY - panZoom.y) * (newZoom / panZoom.zoom);
        panZoom.zoom = newZoom;
        applyPanZoom();
    }, { passive: false });

    viewEl.addEventListener('pointerdown', e => {
        if (view !== 'network' || e.target.closest('.net-node') || e.target.closest('button')) return;
        panZoom.isDragging = true;
        panZoom.startX = e.clientX - panZoom.x;
        panZoom.startY = e.clientY - panZoom.y;
        viewEl.setPointerCapture(e.pointerId);
        viewEl.style.cursor = 'grabbing';
    });

    viewEl.addEventListener('pointermove', e => {
        if (!panZoom.isDragging) return;
        panZoom.x = e.clientX - panZoom.startX;
        panZoom.y = e.clientY - panZoom.startY;
        applyPanZoom();
    });

    const endDrag = (e) => {
        if (!panZoom.isDragging) return;
        panZoom.isDragging = false;
        viewEl.releasePointerCapture(e.pointerId);
        viewEl.style.cursor = 'auto';
    };

    viewEl.addEventListener('pointerup', endDrag);
    viewEl.addEventListener('pointercancel', endDrag);

    $('#zoom-in').addEventListener('click', () => { panZoom.zoom = Math.min(2.5, panZoom.zoom * 1.2); applyPanZoom(); });
    $('#zoom-out').addEventListener('click', () => { panZoom.zoom = Math.max(0.3, panZoom.zoom * 0.8); applyPanZoom(); });
    $('#reset-view').addEventListener('click', () => { panZoom.zoom = 1; panZoom.x = 20; panZoom.y = 20; applyPanZoom(); });
    $('#fit').addEventListener('click', () => {
        const net = $('.network');
        if (!net) return;
        const vRect = viewEl.getBoundingClientRect();
        const scaleX = (vRect.width - 40) / net.scrollWidth;
        const scaleY = (vRect.height - 40) / net.scrollHeight;
        panZoom.zoom = Math.max(0.3, Math.min(1, Math.min(scaleX, scaleY)));
        panZoom.x = 20;
        panZoom.y = 20;
        applyPanZoom();
    });
}

function applyPanZoom() {
    const net = $('.network');
    if (net) {
        net.style.transformOrigin = '0 0';
        net.style.transform = `translate(${panZoom.x}px, ${panZoom.y}px) scale(${panZoom.zoom})`;
    }
    $('#zoom-label').textContent = Math.round(panZoom.zoom * 100) + '%';
}

window.addEventListener('load', init);
