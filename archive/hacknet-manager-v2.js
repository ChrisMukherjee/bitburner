import { getBudget, getCash, formatMoney } from "/utils/spending.js";

const CONFIG = {
	// Cash this manager never touches. Keep it above whatever you are saving for
	// (HTTPWorm.exe, SQLInject.exe, ...) so hacknet can't block those.
	reserve: 300e6,
	// Largest share of current cash spent in one pass (one wake-up of the loop).
	maxFraction: 0.10,
	// Only buy if cost / extra $ per second is below this. Hacknet is tiny next to
	// the batcher, so only fast payback is worth the cash.
	maxPaybackSeconds: 10 * 60,
	loopMs: 10_000,
	// Safety valve; the budget normally ends a pass long before this.
	maxPurchasesPerPass: 25,
};

/**
 * Buys the hacknet purchase with the shortest payback, as long as it fits the budget
 * and pays back within CONFIG.maxPaybackSeconds.
 *
 * Payback = real cost from the hacknet API / extra production per second, where the
 * extra production scales the node's REAL production (getNodeStats().production).
 */
export async function main(ns) {
	ns.disableLog("ALL");

	// Hacknet Servers make hashes, not money, so $ payback would be meaningless.
	if (producesHashes(ns)) {
		ns.print("[hacknet] nodes produce hashes, not money; this manager only handles money nodes.");
		return;
	}

	let lastIdleMessage = "";
	while (true) {
		const idleMessage = runPass(ns);
		// Only print "nothing to buy" when the reason changes.
		if (idleMessage && idleMessage !== lastIdleMessage) ns.print(idleMessage);
		lastIdleMessage = idleMessage;

		await ns.sleep(CONFIG.loopMs);
	}
}

function producesHashes(ns) {
	return ns.hacknet.numNodes() > 0 && ns.hacknet.getNodeStats(0).hashCapacity > 0;
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

/** $/s a brand-new node would make, scaled by what an existing node really makes. */
function estimateNewNodeProduction(ns) {
	let multiplier = 1; // no nodes yet: assume no multipliers (understates, so it errs cautious)
	if (ns.hacknet.numNodes() > 0) {
		const stats = ns.hacknet.getNodeStats(0);
		const rate = baseRate(ns, stats.level, stats.ram, stats.cores);
		if (stats.production > 0 && rate > 0) multiplier = stats.production / rate;
	}
	return multiplier * baseRate(ns, 1, 1, 1);
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

	const newNodeCost = ns.hacknet.getPurchaseNodeCost();
	const newNodeProduction = estimateNewNodeProduction(ns);
	if (Number.isFinite(newNodeCost) && newNodeProduction > 0) {
		candidates.push({
			label: "new node",
			cost: newNodeCost,
			extraPerSecond: newNodeProduction,
			paybackSeconds: newNodeCost / newNodeProduction,
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
function runPass(ns) {
	let remainingBudget = getBudget(ns, CONFIG);
	let purchases = 0;

	while (purchases < CONFIG.maxPurchasesPerPass) {
		const candidates = listCandidates(ns);
		const choice = candidates.find(
			(candidate) =>
				candidate.cost <= remainingBudget && candidate.paybackSeconds <= CONFIG.maxPaybackSeconds
		);

		if (!choice) {
			return purchases > 0 ? "" : describeIdle(ns, candidates, remainingBudget);
		}

		const nodeIndex = choice.buy();
		if (nodeIndex < 0) return `[hacknet] purchase failed: ${choice.label}`;

		remainingBudget -= choice.cost;
		purchases++;

		// Log predicted vs observed so you can see if the estimate matches reality.
		const observedProduction = ns.hacknet.getNodeStats(nodeIndex).production;
		ns.print(
			`[hacknet] bought ${choice.label} for ${formatMoney(ns, choice.cost)} ` +
			`(payback ${ns.format.time(choice.paybackSeconds * 1000)}, ` +
			`+${ns.format.number(choice.extraPerSecond)}/s expected, ` +
			`+${ns.format.number(observedProduction - choice.previousProduction)}/s observed). ` +
			`Cash left: ${formatMoney(ns, getCash(ns))}`
		);
	}
	return "";
}

function describeIdle(ns, candidates, remainingBudget) {
	if (candidates.length === 0) return "[hacknet] nothing to buy (everything maxed).";
	const best = candidates[0];
	const reason =
		best.paybackSeconds > CONFIG.maxPaybackSeconds
			? `payback ${ns.format.time(best.paybackSeconds * 1000)} is over the ${ns.format.time(CONFIG.maxPaybackSeconds * 1000)} limit`
			: `costs ${formatMoney(ns, best.cost)}, budget is ${formatMoney(ns, remainingBudget)}`;
	return `[hacknet] idle: best option is ${best.label}, ${reason}.`;
}