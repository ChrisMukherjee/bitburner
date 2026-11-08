// Description: Buys and upgrades Hacknet Nodes, always picking the purchase that pays itself back fastest.
// It measures what your nodes really earn (so all your multipliers count) and never spends the reserve.

// --- SETTINGS ---
const RESERVE_SHARE = 0.1;   // Never spend below this share of the most money you've had since installing augmentations (0.5 = half, 0 = spend everything)
const PEAK_FILE = "money-peak.txt"; // Where that highest amount is remembered
const RUN_HOURS = 24;       // How long you usually play between augmentation installs
const MIN_PAYBACK_HOURS = 1; // Even late in a run, still buy things that pay back within this many hours

/** @param {import(".").NS } ns */
export async function main(ns, maxNodes = ns.args[0] ?? 20) {
    ns.disableLog("sleep");
    ns.disableLog("getServerMoneyAvailable")
    ns.print("=== Hacknet Automation Script Started ===");
    ns.print(`Keeping ${RESERVE_SHARE * 100}% of your peak money (now $${ns.format.number(reserve(ns))}), max ${maxNodes} nodes, ${RUN_HOURS}h runs`);

    while (true) {
        const nodes = ns.hacknet.numNodes();
        const mult = productionMult(ns, nodes);

        // Every possible purchase, with how much $/sec it would add
        const options = [];
        for (let i = 0; i < nodes; i++) {
            const node = ns.hacknet.getNodeStats(i);
            const { level, ram, cores } = node;
            const now = baseRate(level, ram, cores) * mult;
            options.push(
                { name: `Level on Node ${i}`, cost: ns.hacknet.getLevelUpgradeCost(i, 1), gain: baseRate(level + 1, ram, cores) * mult - now, buy: () => ns.hacknet.upgradeLevel(i, 1) },
                { name: `RAM on Node ${i}`, cost: ns.hacknet.getRamUpgradeCost(i, 1), gain: baseRate(level, ram * 2, cores) * mult - now, buy: () => ns.hacknet.upgradeRam(i, 1) },
                { name: `Core on Node ${i}`, cost: ns.hacknet.getCoreUpgradeCost(i, 1), gain: baseRate(level, ram, cores + 1) * mult - now, buy: () => ns.hacknet.upgradeCore(i, 1) },
            );
        }
        if (nodes < maxNodes && nodes < ns.hacknet.maxNumNodes()) {
            options.push({ name: "new Hacknet Node", cost: ns.hacknet.getPurchaseNodeCost(), gain: baseRate(1, 1, 1) * mult, buy: () => ns.hacknet.purchaseNode() !== -1 });
        }

        // Best = earns the most per dollar spent (fastest payback)
        const usable = options.filter(o => isFinite(o.cost) && o.cost > 0 && o.gain > 0);
        if (usable.length === 0) {
            ns.print("[Wait] Nothing left to buy. Waiting...");
            await ns.sleep(10000);
            continue;
        }
        const best = usable.reduce((a, b) => a.gain / a.cost > b.gain / b.cost ? a : b);
        const paybackSec = best.cost / best.gain;
        const limitSec = paybackLimitHours(ns) * 3600;

        // --- CHECK 1: Does it pay for itself before you're likely to install augmentations? ---
        if (paybackSec > limitSec) {
            ns.print(`[Skip] Best buy (${best.name}) takes ${ns.format.time(paybackSec * 1000)} to pay back, but this run probably has ${ns.format.time(limitSec * 1000)} left. Waiting...`);
            await ns.sleep(10000);
            continue;
        }

        // --- CHECK 2: Can we afford it without touching the reserve? ---
        const spendable = ns.getServerMoneyAvailable("home") - reserve(ns);
        if (spendable < best.cost) {
            ns.print(`[Wait] ${best.name} costs $${ns.format.number(best.cost)}, have $${ns.format.number(Math.max(0, spendable))} above the reserve.`);
            await ns.sleep(1000);
            continue;
        }

        if (best.buy()) {
            ns.print(`[Success] Bought ${best.name} for $${ns.format.number(best.cost)} (+$${ns.format.number(best.gain)}/sec, pays back in ${ns.format.time(paybackSec * 1000)})`);
        }
        await ns.sleep(200);
    }
}

/**
 * Hacknet nodes are lost when you install augmentations, so a purchase only helps if it pays back before then.
 * Allows the time left in a typical run (RUN_HOURS), but never less than MIN_PAYBACK_HOURS.
 */
function paybackLimitHours(ns) {
    const hoursPlayed = (Date.now() - readReset(ns)) / 3600e3;
    return Math.max(MIN_PAYBACK_HOURS, RUN_HOURS - hoursPlayed);
}

/**
 * How much more your nodes really make than the basic formula says (augmentations, BitNode, etc).
 * Measured from your existing nodes' real production.
 */
function productionMult(ns, nodes) {
    let real = 0, base = 0;
    for (let i = 0; i < nodes; i++) {
        const node = ns.hacknet.getNodeStats(i);
        real += node.production;
        base += baseRate(node.level, node.ram, node.cores);
    }
    return real > 0 && base > 0 ? real / base : 1;
}

/** The game's Hacknet Node formula without any multipliers. */
function baseRate(level, ram, cores) {
    const levelMult = level * 1.5;
    const ramMult = Math.pow(1.035, ram - 1);
    const coresMult = (cores + 5) / 6;
    return levelMult * ramMult * coresMult;
}

/**
 * Money to keep: RESERVE_SHARE of the most money you've had since installing augmentations.
 * The peak is saved in PEAK_FILE (shared by the scripts that use it) and starts over after each install.
 */
function reserve(ns) {
    const reset = readReset(ns);
    let data = { reset, peak: 0 };
    try {
        const saved = JSON.parse(ns.read(PEAK_FILE));
        if (saved.reset === reset) data = saved;
    } catch { } // no file yet
    const money = ns.getServerMoneyAvailable("home");
    if (money > data.peak) {
        data.peak = money;
        ns.write(PEAK_FILE, JSON.stringify(data), "w");
    }
    return RESERVE_SHARE * data.peak;
}

/** Time of the last augmentation install, written by reset-marker.js (the orchestrator runs it). Reading a file is free; getResetInfo costs 1 GB. */
function readReset(ns) {
    return Number(ns.read("reset-info.txt")) || Date.now();
}
