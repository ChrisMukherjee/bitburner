/** @param {NS} ns **/
export async function main(ns) {
	ns.disableLog("ALL");
	ns.print("Starting Hacknet Manager...");

	// Set maximum spending limit (optional: leave at Infinity or pass via args)
	const maxSpend = ns.args[0] || Infinity;
	const targetNodes = 12; // Cap initial node expansion so it doesn't spam infinitely before upgrading

	while (true) {
		let ownedNodes = ns.hacknet.numNodes();

		// If we have no nodes, buy the first one immediately if affordable
		if (ownedNodes === 0) {
			if (ns.getServerMoneyAvailable("home") >= ns.hacknet.getPurchaseNodeCost()) {
				ns.hacknet.purchaseNode();
				ns.print("Purchased first Hacknet node.");
			}
			await ns.sleep(3000);
			continue;
		}

		let bestOption = null;
		let maxRatio = 0; // Value ratio: Gain / Cost

		// Evaluate cost and production gain for purchasing a new node
		let newNodeCost = ns.hacknet.getPurchaseNodeCost();
		if (ownedNodes < targetNodes && newNodeCost < maxSpend && ns.getServerMoneyAvailable("home") >= newNodeCost) {
			// Base node production gain (Level 1, RAM 1, Core 1)
			let gain = calculateNodeGain(1, 1, 1);
			// Adjust weight so buying early nodes competes healthily with cheap upgrades
			let ratio = (gain * 10) / newNodeCost;
			if (ratio > maxRatio) {
				maxRatio = ratio;
				bestOption = { type: "purchaseNode", cost: newNodeCost };
			}
		}

		// Evaluate upgrades for all existing nodes
		for (let i = 0; i < ownedNodes; i++) {
			let stats = ns.hacknet.getNodeStats(i);

			// Level Upgrade Check
			let levelCost = ns.hacknet.getLevelUpgradeCost(i, 1);
			if (isFinite(levelCost) && levelCost < maxSpend) {
				let gain = calculateNodeGain(stats.level + 1, stats.ram, stats.cores) - calculateNodeGain(stats.level, stats.ram, stats.cores);
				let ratio = gain / levelCost;
				if (ratio > maxRatio) {
					maxRatio = ratio;
					bestOption = { type: "level", node: i, cost: levelCost };
				}
			}

			// RAM Upgrade Check
			let ramCost = ns.hacknet.getRamUpgradeCost(i, 1);
			if (isFinite(ramCost) && ramCost < maxSpend) {
				let gain = calculateNodeGain(stats.level, stats.ram * 2, stats.cores) - calculateNodeGain(stats.level, stats.ram, stats.cores);
				let ratio = gain / ramCost;
				if (ratio > maxRatio) {
					maxRatio = ratio;
					bestOption = { type: "ram", node: i, cost: ramCost };
				}
			}

			// Core Upgrade Check
			let coreCost = ns.hacknet.getCoreUpgradeCost(i, 1);
			if (isFinite(coreCost) && coreCost < maxSpend) {
				let gain = calculateNodeGain(stats.level, stats.ram, stats.cores + 1) - calculateNodeGain(stats.level, stats.ram, stats.cores);
				let ratio = gain / coreCost;
				if (ratio > maxRatio) {
					maxRatio = ratio;
					bestOption = { type: "core", node: i, cost: coreCost };
				}
			}
		}

		// Execute the single best value upgrade if we have enough money
		if (bestOption && ns.getServerMoneyAvailable("home") >= bestOption.cost) {
			if (bestOption.type === "purchaseNode") {
				let id = ns.hacknet.purchaseNode();
				ns.print(`Purchased Hacknet node #${id}`);
			} else if (bestOption.type === "level") {
				ns.hacknet.upgradeLevel(bestOption.node, 1);
				ns.print(`Upgraded Node #${bestOption.node} Level`);
			} else if (bestOption.type === "ram") {
				ns.hacknet.upgradeRam(bestOption.node, 1);
				ns.print(`Upgraded Node #${bestOption.node} RAM`);
			} else if (bestOption.type === "core") {
				ns.hacknet.upgradeCore(bestOption.node, 1);
				ns.print(`Upgraded Node #${bestOption.node} Core`);
			}
		}

		// Sleep before next evaluation loop
		await ns.sleep(3000);
	}
}

/** 
 * Calculate theoretical production ($/sec) for a Hacknet node with given stats.
 * Uses Bitburner's base Hacknet production formula.
 */
function calculateNodeGain(level, ram, cores) {
	// Base formula parameters used by Bitburner Hacknet
	return level * 1.5 * Math.pow(1.035, ram - 1) * ((cores + 5) / 6);
}