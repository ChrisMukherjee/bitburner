import { loadConfig } from "/utils/config.js";
import { notify } from "/utils/notify.js";
import { createPolicyTracker, getBudget, getCash, formatMoney } from "/utils/spending.js";
import { readIncomeRate } from "/utils/income.js";
import { bitnodeMults } from "/utils/bitnode-mults.js";

const CONFIG = {
	// Spending stages (reserve, maxFraction, ... by income) are `hacknetBuying` in the config
	// (config.js, data/config.json).
	loopMs: 10_000,
	// Safety valve; the budget normally ends a pass long before this.
	maxPurchasesPerPass: 25,
};

// Upgrade cost constants from the game (before the player's cost multipliers). Only used without
// Formulas.exe, to price upgrades on a node we don't own yet; the multiplier is measured from a real node,
// which also absorbs any constant offset in these.
const UPGRADE_COST = { levelBase: 500, levelMult: 1.04, ramBase: 30000, ramMult: 1.28, coreBase: 500000, coreMult: 1.48 };

/**
 * Buys the hacknet purchase with the shortest payback, as long as it fits the budget
 * and pays back within the current stage's maxPaybackSeconds.
 *
 * Payback = real cost from the hacknet API / extra production per second, where the
 * extra production scales the node's REAL production (getNodeStats().production).
 *
 * A bare new node (level 1, 1GB, 1 core) makes almost nothing, so on its own its payback is
 * terrible and it would never be bought. Its value is the cheap upgrades it unlocks, so a new
 * node is priced as a package: the node plus the upgrades worth putting on it (newNodePackage).
 * Buying it only buys the node; those upgrades then win on payback by themselves.
 */
export async function main(ns) {
	ns.disableLog("ALL");

	// Hacknet Servers make hashes, not money, so $ payback would be meaningless.
	if (producesHashes(ns)) {
		ns.print("[hacknet] nodes produce hashes, not money; this manager only handles money nodes.");
		return;
	}

	const getPolicy = createPolicyTracker(loadConfig(ns).hacknetBuying);
	let lastStageName = "";
	let lastIdleMessage = "";
	let formulasWasOn = null; // null so the first pass always reports the mode
	while (true) {
		const formulasOn = ns.fileExists("Formulas.exe", "home");
		if (formulasOn !== formulasWasOn) {
			const mode = `Formulas.exe ${formulasOn ? "found: exact production and costs on" : "not found: estimating"}.`;
			if (formulasWasOn === null) ns.print(`[hacknet] ${mode}`); // first pass: routine
			else notify(ns, "[hacknet]", mode, "info"); // the mode changed mid-run: toast only
			formulasWasOn = formulasOn;
		}
		const policy = getPolicy(ns);
		if (policy.name !== lastStageName) {
			ns.print(
				`[hacknet] stage "${policy.name}": reserve ${formatMoney(ns, policy.reserve)}, ` +
				`max ${ns.format.percent(policy.maxFraction)} of cash per pass, ` +
				`payback under ${ns.format.time(policy.maxPaybackSeconds * 1000)}`
			);
			lastStageName = policy.name;
		}

		const idleMessage = runPass(ns, policy);
		// Only print "nothing to buy" when the reason changes.
		if (idleMessage && idleMessage !== lastIdleMessage) ns.print(idleMessage);
		lastIdleMessage = idleMessage;

		await ns.sleep(CONFIG.loopMs);
	}
}

function producesHashes(ns) {
	// Bracket access: ".hashCapacity" would be charged as ns.hacknet.hashCapacity (0.5GB).
	return ns.hacknet.numNodes() > 0 && ns.hacknet.getNodeStats(0)["hashCapacity"] > 0;
}

/**
 * Production shape of a node, multipliers left out. Only RATIOS of this are used,
 * so player/bitnode multipliers cancel and the absolute $/s always comes from real
 * production. Uses the game's own function when Formulas.exe is owned, otherwise
 * the same formula the game uses (level * 1.035^(ram-1) * (cores+5)/6).
 */
function baseRate(ns, level, ram, cores) {
	if (ns.fileExists("Formulas.exe", "home")) {
		return ns.formulas.hacknetNodes.moneyGainRate(level, ram, cores, 1);
	}
	return level * Math.pow(1.035, ram - 1) * ((cores + 5) / 6);
}

/**
 * $/s a brand-new node would make. With Formulas.exe it's exact (player and bitnode multipliers
 * included, even with no nodes yet); otherwise scaled by what an existing node really makes.
 */
function estimateNewNodeProduction(ns) {
	if (ns.fileExists("Formulas.exe", "home")) {
		return ns.formulas.hacknetNodes.moneyGainRate(1, 1, 1, ns.getPlayer().mults.hacknet_node_money);
	}
	// No nodes yet: the BitNode's hacknet multiplier if it is known (1 otherwise: understates, so it errs cautious)
	let multiplier = bitnodeMults(ns).get("HacknetNodeMoney");
	if (ns.hacknet.numNodes() > 0) {
		const stats = ns.hacknet.getNodeStats(0);
		const rate = baseRate(ns, stats.level, stats.ram, stats.cores);
		if (stats.production > 0 && rate > 0) multiplier = stats.production / rate;
	}
	return multiplier * baseRate(ns, 1, 1, 1);
}

/** Cost before multipliers of raising one stat ("level", "ram" or "cores") on a node, per the game's formulas. */
function rawUpgradeCost(kind, from, to) {
	let total = 0;
	if (kind === "level") {
		for (let level = from; level < to; level++) total += UPGRADE_COST.levelBase * Math.pow(UPGRADE_COST.levelMult, level);
	} else if (kind === "ram") {
		let upgrades = Math.round(Math.log2(from));
		for (let ram = from; ram < to; ram *= 2, upgrades++) total += ram * UPGRADE_COST.ramBase * Math.pow(UPGRADE_COST.ramMult, upgrades);
	} else {
		for (let cores = from; cores < to; cores++) total += UPGRADE_COST.coreBase * Math.pow(UPGRADE_COST.coreMult, cores - 1);
	}
	return total;
}

// Caps for a Hacknet Node's stats.
const MAX_STATS = { level: 200, ram: 64, cores: 16 };

/**
 * Prices one upgrade step (level +1, RAM x2, cores +1) from any starting value, for a node we
 * don't own yet. Exact with Formulas.exe. Without it, the game's formula times a cost multiplier
 * measured from the real API on an existing node. Returns null if a multiplier can't be measured.
 */
function makeStepPricer(ns) {
	if (ns.fileExists("Formulas.exe", "home")) {
		const mults = ns.getPlayer().mults;
		const formulas = ns.formulas.hacknetNodes;
		return {
			level: (from) => formulas.levelUpgradeCost(from, 1, mults.hacknet_node_level_cost),
			ram: (from) => formulas.ramUpgradeCost(from, 1, mults.hacknet_node_ram_cost),
			cores: (from) => formulas.coreUpgradeCost(from, 1, mults.hacknet_node_core_cost),
		};
	}
	const apiCost = {
		level: (index) => ns.hacknet.getLevelUpgradeCost(index, 1),
		ram: (index) => ns.hacknet.getRamUpgradeCost(index, 1),
		cores: (index) => ns.hacknet.getCoreUpgradeCost(index, 1),
	};
	const nextValue = (kind, value) => (kind === "ram" ? value * 2 : value + 1);
	const pricer = {};
	for (const kind of ["level", "ram", "cores"]) {
		let multiplier = NaN;
		for (let index = 0; index < ns.hacknet.numNodes() && !Number.isFinite(multiplier); index++) {
			const current = ns.hacknet.getNodeStats(index)[kind];
			const cost = apiCost[kind](index);
			if (Number.isFinite(cost)) multiplier = cost / rawUpgradeCost(kind, current, nextValue(kind, current));
		}
		if (!Number.isFinite(multiplier)) return null;
		pricer[kind] = (from) => multiplier * rawUpgradeCost(kind, from, nextValue(kind, from));
	}
	return pricer;
}

/**
 * The "new node" option. A bare node (level 1, 1GB, 1 core) earns almost nothing, so its value
 * is the cheap upgrades it unlocks. This plays out buying the node and then its upgrades in
 * best-payback order, stopping once the next upgrade would make the overall payback worse,
 * and returns the total cost and production at that point. With no nodes yet (nothing to
 * measure prices from) it's just the bare node.
 */
function newNodePackage(ns) {
	const nodeCost = ns.hacknet.getPurchaseNodeCost();
	const bare = { label: "new node", cost: nodeCost, production: estimateNewNodeProduction(ns) };
	const pricer = ns.hacknet.numNodes() > 0 ? makeStepPricer(ns) : null;
	if (!pricer || !(bare.production > 0)) return bare;

	// $/s per unit of baseRate, measured on a real node (multipliers are the same for every node)
	const perRate = bare.production / baseRate(ns, 1, 1, 1);
	const node = { level: 1, ram: 1, cores: 1 };
	let cost = nodeCost;
	let production = bare.production;
	while (true) {
		let best = null;
		for (const kind of ["level", "ram", "cores"]) {
			const next = { ...node, [kind]: kind === "ram" ? node.ram * 2 : node[kind] + 1 };
			if (next[kind] > MAX_STATS[kind]) continue;
			const stepCost = pricer[kind](node[kind]);
			const gain = perRate * baseRate(ns, next.level, next.ram, next.cores) - production;
			if (gain > 0 && (!best || stepCost / gain < best.payback)) best = { next, stepCost, gain, payback: stepCost / gain };
		}
		// Only keep upgrading while it improves the package's overall payback
		if (!best || best.payback >= cost / production) break;
		Object.assign(node, best.next);
		cost += best.stepCost;
		production += best.gain;
	}
	if (node.level === 1 && node.ram === 1 && node.cores === 1) return bare;
	return {
		label: `new node (+ upgrades to level ${node.level}, ${node.ram}GB, ${node.cores} cores)`,
		cost,
		production,
	};
}

/** Every purchase available right now, with its real cost and estimated payback. */
function listCandidates(ns) {
	const candidates = [];
	const nodeCount = ns.hacknet.numNodes();

	for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex++) {
		const stats = ns.hacknet.getNodeStats(nodeIndex);
		const currentRate = baseRate(ns, stats.level, stats.ram, stats.cores);
		if (!(stats.production > 0) || !(currentRate > 0)) continue;

		// Level +1, RAM doubles, cores +1: one step each, as the upgrade APIs do with count 1.
		const options = [
			{
				kind: "level",
				cost: ns.hacknet.getLevelUpgradeCost(nodeIndex, 1),
				nextRate: baseRate(ns, stats.level + 1, stats.ram, stats.cores),
				buy: () => ns.hacknet.upgradeLevel(nodeIndex, 1),
			},
			{
				kind: "ram",
				cost: ns.hacknet.getRamUpgradeCost(nodeIndex, 1),
				nextRate: baseRate(ns, stats.level, stats.ram * 2, stats.cores),
				buy: () => ns.hacknet.upgradeRam(nodeIndex, 1),
			},
			{
				kind: "core",
				cost: ns.hacknet.getCoreUpgradeCost(nodeIndex, 1),
				nextRate: baseRate(ns, stats.level, stats.ram, stats.cores + 1),
				buy: () => ns.hacknet.upgradeCore(nodeIndex, 1),
			},
		];

		for (const option of options) {
			if (!Number.isFinite(option.cost)) continue; // maxed out (the API returns Infinity)
			const extraPerSecond = stats.production * (option.nextRate / currentRate - 1);
			if (!(extraPerSecond > 0)) continue;
			candidates.push({
				label: `${stats.name} ${option.kind}`,
				cost: option.cost,
				extraPerSecond,
				paybackSeconds: option.cost / extraPerSecond,
				previousProduction: stats.production,
				// Returns the node index on success, -1 on failure.
				buy: () => (option.buy() ? nodeIndex : -1),
			});
		}
	}

	const newNode = newNodePackage(ns);
	if (Number.isFinite(newNode.cost) && newNode.production > 0) {
		candidates.push({
			label: newNode.label,
			cost: newNode.cost,                    // what it takes to make the node worth having
			spend: ns.hacknet.getPurchaseNodeCost(), // what buying it actually spends now
			extraPerSecond: newNode.production,
			paybackSeconds: newNode.cost / newNode.production,
			previousProduction: 0,
			buy: () => ns.hacknet.purchaseNode(), // returns the new index, or -1
		});
	}

	return candidates.sort((first, second) => first.paybackSeconds - second.paybackSeconds);
}

/**
 * One decision round. The budget is fixed at the start of the pass and shrinks as we
 * buy, so a pass can never spend more than maxFraction of the cash it started with.
 * Returns "" if it bought something, otherwise a message explaining why not.
 */
function runPass(ns, policy) {
	if (policy.maxPaybackSeconds <= 0) return `[hacknet] buying is off in stage "${policy.name}".`;
	const hacknetIncome = totalHacknetProduction(ns);
	const scriptIncome = readIncomeRate(ns).perSecond;
	if (hacknetIncome < policy.minShareOfIncome * scriptIncome) {
		return (
			`[hacknet] idle: hacknet makes ${formatMoney(ns, hacknetIncome)}/s, under ` +
			`${ns.format.percent(policy.minShareOfIncome)} of script income (${formatMoney(ns, scriptIncome)}/s).`
		);
	}

	let remainingBudget = getBudget(ns, policy);
	let purchases = 0;

	while (purchases < CONFIG.maxPurchasesPerPass) {
		const candidates = listCandidates(ns);
		const choice = candidates.find(
			(candidate) =>
				candidate.cost <= remainingBudget && candidate.paybackSeconds <= policy.maxPaybackSeconds
		);

		if (!choice) {
			return purchases > 0 ? "" : describeIdle(ns, policy, candidates, remainingBudget);
		}

		const nodeIndex = choice.buy();
		if (nodeIndex < 0) return `[hacknet] purchase failed: ${choice.label}`;

		const spent = choice.spend ?? choice.cost;
		remainingBudget -= spent;
		purchases++;

		// Log predicted vs observed so you can see if the estimate matches reality.
		const observedProduction = ns.hacknet.getNodeStats(nodeIndex).production;
		ns.print(
			`[hacknet] bought ${choice.label} for ${formatMoney(ns, spent)} ` +
			`(payback ${ns.format.time(choice.paybackSeconds * 1000)}, ` +
			`+${ns.format.number(choice.extraPerSecond)}/s expected, ` +
			`+${ns.format.number(observedProduction - choice.previousProduction)}/s observed). ` +
			`Cash left: ${formatMoney(ns, getCash(ns))}`
		);
	}
	return "";
}

function totalHacknetProduction(ns) {
	let total = 0;
	for (let index = 0; index < ns.hacknet.numNodes(); index++) total += ns.hacknet.getNodeStats(index).production;
	return total;
}

function describeIdle(ns, policy, candidates, remainingBudget) {
	if (candidates.length === 0) return "[hacknet] nothing to buy (everything maxed).";
	const best = candidates[0];
	const reason =
		best.paybackSeconds > policy.maxPaybackSeconds
			? `payback ${ns.format.time(best.paybackSeconds * 1000)} is over the ${ns.format.time(policy.maxPaybackSeconds * 1000)} limit`
			: `costs ${formatMoney(ns, best.cost)}, budget is ${formatMoney(ns, remainingBudget)}`;
	return `[hacknet] idle: best option is ${best.label}, ${reason}.`;
}
