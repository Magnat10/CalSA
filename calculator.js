// calculator.js

const POWER = { Constructor: 4, Smelter: 4, Assembler: 15, Manufacturer: 55, Refinery: 30, Foundry: 16, Packager: 10, Blender: 75, Converter: 250, QuantumEncoder: 2000 };
export const BELTS = { 1: 60, 2: 120, 3: 270, 4: 480, 5: 780, 6: 1200 };

export function clean(x = '') { 
    return x.replace(/^Desc_/, '').replace(/^Build_/, '').replace(/^BP_EquipmentDescriptor/, '').replace(/Mk([1-9])/g, ' Mk.$1').replace(/_C$/, '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim(); 
}

export function normalize(raw) { 
    return Object.values(raw).flatMap(v => Array.isArray(v) ? v : [v]).filter(r => r?.products?.length && r.duration > 0 && !r.inBuildGun && !r.inCustomizer && !r.inWorkshop && r.producedIn?.length).map((r, i) => ({ ...r, id: r.className || `recipe_${i}` })); 
}

export function catalog(rs) { 
    const m = new Map(); 
    for (const r of rs) {
        for (const p of r.products) { 
            m.has(p.item) || m.set(p.item, { id: p.item, name: clean(p.item), recipes: [] }); 
            m.get(p.item).recipes.push(r); 
        }
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name)); 
}

export function category(n) { 
    if (/ore|coal|bauxite|sulfur|quartz|limestone|sam/i.test(n)) return 'Rohstoffe'; 
    if (/ingot/i.test(n)) return 'Barren'; 
    if (/water|oil|fuel|acid|solution|residue|nitrogen/i.test(n)) return 'Fluids'; 
    if (/wire|cable|circuit|computer|quickwire|limiter/i.test(n)) return 'Elektronik'; 
    return 'Bauteile'; 
}

const baseMachine = id => { 
    const name = clean(id), family = Object.keys(POWER).find(x => name.includes(x)) || name; 
    return { id, name, family, power: POWER[family] || 0 }; 
}

function configuredMachine(id, opt, itemId) { 
    const b = baseMachine(id);
    const cfg = opt.machineConfig?.[itemId] || {}; 
    const tier = Math.max(1, +cfg.tier || 1); 
    const clock = Math.min(250, Math.max(1, +cfg.clock || 100)); 
    const name = b.name.replace(/ Mk\.\d+/, '') + (tier > 1 ? ` Mk.${tier}` : b.name.match(/Mk\.\d+/) ? ' Mk.1' : ''); 
    
    // UPDATE 1.0/1.2: Stromverbrauch skaliert linear mit dem Takt (clock / 100). Der alte Exponent (1.321929) entfällt.
    return { 
        ...b, 
        name, 
        tier, 
        clock, 
        speed: tier * (clock / 100), 
        power: b.power * Math.pow(tier, 0.7) * (clock / 100) 
    }; 
}

export function solve(itemId, rate, recipes, opt = {}) { 
    // 1. ITERATIVER MATHE-SOLVER (Pool-System für Nebenprodukte & Loops)
    const itemBalance = { [itemId]: -rate }; 
    const machineCounts = {}; 

    const getRecipe = (id) => {
        const choices = recipes.filter(r => r.products.some(p => p.item === id));
        if (!choices.length) return null;
        const chosen = opt.recipeSelections?.[id];
        return (chosen ? choices.find(x => x.id === chosen) : null) || choices.find(x => x.alternate === false) || choices.find(x => !x.alternate) || choices[0];
    };

    let modified = true;
    let iter = 0;
    
    // Solange wir von einem Item ein Defizit haben (< -1e-5), rechnen wir weiter (max 1000 Durchläufe für Sicherheit)
    while (modified && iter < 1000) {
        modified = false;
        iter++;
        for (const [id, amount] of Object.entries(itemBalance)) {
            if (amount < -1e-5) {
                const r = getRecipe(id);
                if (r) {
                    const prod = r.products.find(p => p.item === id);
                    const m = configuredMachine(r.producedIn[0], opt, id);
                    const outputPerMachine = (prod.amount * 60 / r.duration) * m.speed;
                    const neededMachines = (-amount) / outputPerMachine;

                    machineCounts[r.id] = (machineCounts[r.id] || 0) + neededMachines;
                    itemBalance[id] = 0; // Defizit für dieses Item gedeckt

                    // Alle produzierten Items (inkl. Nebenprodukte) dem Pool hinzufügen
                    for (const p of r.products) {
                        if (p.item !== id) {
                            const byRate = (p.amount * 60 / r.duration) * m.speed * neededMachines;
                            itemBalance[p.item] = (itemBalance[p.item] || 0) + byRate;
                        }
                    }

                    // Alle benötigten Zutaten vom Pool abziehen
                    for (const ing of r.ingredients) {
                        const ingRate = (ing.amount * 60 / r.duration) * m.speed * neededMachines;
                        itemBalance[ing.item] = (itemBalance[ing.item] || 0) - ingRate;
                    }

                    modified = true;
                    break; // Iteration neu starten, da sich das Balance-Objekt geändert hat
                }
            }
        }
    }

    // 2. GRAPH-AGGREGATION (Knoten und Kanten erstellen)
    const nodes = [];
    const edges = [];
    const warnings = [];
    const nodeMap = {}; 

    // Produktions-Knoten aus den ermittelten Maschinen
    for (const [rId, count] of Object.entries(machineCounts)) {
        if (count > 1e-5) {
            const r = recipes.find(x => x.id === rId);
            const primaryItem = r.products[0].item;
            const m = configuredMachine(r.producedIn[0], opt, primaryItem);
            const nid = `prod_${rId}`;
            const n = { id: nid, type: 'prod', itemId: primaryItem, name: r.name, rate: count * (r.products[0].amount * 60 / r.duration) * m.speed, count, machine: m, recipe: r, depth: -1, children: [] };
            nodes.push(n);
            for (const p of r.products) {
                if (!nodeMap[p.item]) nodeMap[p.item] = nid;
            }
        }
    }

    // Rohstoff-Knoten für die übrig gebliebenen Defizite (Erze, Wasser etc.)
    for (const [id, amount] of Object.entries(itemBalance)) {
        if (amount < -1e-5) {
            const nid = `raw_${id}`;
            const n = { id: nid, type: 'raw', itemId: id, name: clean(id), rate: -amount, depth: -1, children: [] };
            nodes.push(n);
            nodeMap[id] = nid;
        }
    }

    // Kanten (Förderbänder) verbinden Provider mit Konsumenten
    for (const [rId, count] of Object.entries(machineCounts)) {
        if (count > 1e-5) {
            const r = recipes.find(x => x.id === rId);
            const m = configuredMachine(r.producedIn[0], opt, r.products[0].item);
            const consumerId = `prod_${rId}`;

            for (const ing of r.ingredients) {
                const providerId = nodeMap[ing.item];
                if (providerId) {
                    const flow = (ing.amount * 60 / r.duration) * m.speed * count;
                    const max = opt.maxBelt === 'auto' ? 6 : +opt.maxBelt || 6;
                    const allowed = Object.keys(BELTS).map(Number).filter(x => x <= max);
                    const mk = allowed.find(x => BELTS[x] >= flow) || max;
                    const cap = BELTS[mk];
                    const lines = Math.max(1, Math.ceil(flow / cap));
                    const bottleneck = flow > cap;
                    
                    edges.push({ from: providerId, to: consumerId, itemId: ing.item, flow, mk, cap, lines, bottleneck });
                    if (bottleneck) {
                        warnings.push(`${clean(ing.item)}: ${flow.toFixed(1)}/min benötigt ${lines}× Belt Mk.${mk}`);
                    }
                }
            }
        }
    }

    // Topologische Tiefe berechnen (für den UI-Netzwerkgraphen)
    const targetNodeId = nodeMap[itemId];
    if (targetNodeId) {
        const targetNode = nodes.find(n => n.id === targetNodeId);
        if (targetNode) targetNode.depth = 0;
    }

    let changed = true;
    let dIter = 0;
    while (changed && dIter < 100) {
        changed = false;
        dIter++;
        for (const e of edges) {
            const fromNode = nodes.find(n => n.id === e.from);
            const toNode = nodes.find(n => n.id === e.to);
            if (toNode && fromNode && toNode.depth !== -1) {
                if (fromNode.depth < toNode.depth + 1) {
                    fromNode.depth = toNode.depth + 1;
                    changed = true;
                }
            }
        }
    }

    const maxD = Math.max(0, ...nodes.map(n => n.depth));
    nodes.forEach(n => { if (n.depth === -1) n.depth = maxD + 1; });

    // 3. UI-BAUMSTRUKTUR (Rekursiv für die Listenansicht, mit Loop-Schutz)
    function buildTree(currentId, need, depth = 0, path = new Set()) {
        if (path.has(currentId)) {
            return { id: `loop_${currentId}_${depth}`, type: 'raw', itemId: currentId, name: clean(currentId) + ' (Kreislauf)', rate: need, depth, children: [] };
        }

        const providerRecipeEntry = Object.entries(machineCounts).find(([rId, count]) => {
            const r = recipes.find(x => x.id === rId);
            return r && r.products.some(p => p.item === currentId);
        });

        if (!providerRecipeEntry || providerRecipeEntry[1] < 1e-5) {
            return { id: `t_raw_${currentId}_${depth}`, type: 'raw', itemId: currentId, name: clean(currentId), rate: need, depth, children: [] };
        }

        const [rId] = providerRecipeEntry;
        const r = recipes.find(x => x.id === rId);
        const m = configuredMachine(r.producedIn[0], opt, currentId);
        
        const prod = r.products.find(p => p.item === currentId);
        const outputPerMachine = (prod.amount * 60 / r.duration) * m.speed;
        const dedicatedMachines = need / outputPerMachine;

        const n = { id: `t_prod_${rId}_${depth}`, type: 'prod', itemId: currentId, name: clean(currentId), rate: need, count: dedicatedMachines, machine: m, recipe: r, depth, children: [] };

        path.add(currentId);
        for (const ing of r.ingredients) {
            const ingNeed = (ing.amount * 60 / r.duration) * m.speed * dedicatedMachines;
            n.children.push(buildTree(ing.item, ingNeed, depth + 1, path));
        }
        path.delete(currentId);
        return n;
    }

    const root = buildTree(itemId, rate);

    // 4. TOTALS (Zusammenfassung aggregieren)
    const items = {};
    const raw = {};
    const machines = {};
    
    for (const n of nodes) {
        items[n.itemId] = (items[n.itemId] || 0) + n.rate;
        if (n.type === 'raw') {
            raw[n.itemId] = (raw[n.itemId] || 0) + n.rate;
        } else {
            const k = n.machine.name;
            machines[k] ||= { name: k, count: 0, power: n.machine.power, powerTotal: 0 };
            machines[k].count += n.count;
            machines[k].powerTotal += n.count * n.machine.power;
        }
    }

    return {
        root, 
        nodes, 
        edges, 
        warnings, 
        totals: {
            items, 
            raw, 
            machines, 
            machineCount: Object.values(machines).reduce((s, m) => s + m.count, 0), 
            power: Object.values(machines).reduce((s, m) => s + m.powerTotal, 0), 
            rawRate: Object.values(raw).reduce((a, b) => a + b, 0)
        }
    };
}

/**
 * QUALITÄTSSICHERUNG / TESTFALL
 */
export function testCalculatePower10() {
    // Testfall für Update 1.0 Strom: Constructor (Basis 4 MW), 250% Takt
    // Erwartung: Exakt 10 MW (4 * 2.5) anstatt 13.4 MW wie bei alten Iterationen.
    const opt = { machineConfig: { 'Desc_Test_C': { clock: 250, tier: 1 } } };
    const cfg = configuredMachine('Desc_ConstructorMk1_C', opt, 'Desc_Test_C');
    
    if (cfg.power !== 10) {
        console.error(`[TEST FEHLGESCHLAGEN] Stromberechnung skaliert nicht linear: Erwartet 10 MW, Erhalten ${cfg.power} MW`);
        return false;
    }
    console.log("[TEST ERFOLGREICH] Stromberechnung skaliert linear für Update 1.0 (250% = 10 MW).");
    return true;
}

// Test beim Laden ausführen
testCalculatePower10();
