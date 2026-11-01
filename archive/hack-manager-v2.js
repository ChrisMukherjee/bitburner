/** @param {NS} ns **/
import { attemptNuke } from "/archive/attempt-nuke.js";
import { deployToPoolSubset, getWorkerPool } from "/utils/workpool.js";
import { getAllServers } from "/utils/get-all-servers.js";
import { getTopTargets } from "/utils/get-top-targets.js";

export async function main(ns) {
	// Disable log spam in the script's active log window
	ns.disableLog("ALL");

	// Accept a mode argument: pass "xp" for power-leveling, defaults to "money"
	const mode = ns.args[0] ? ns.args[0].toLowerCase() : "money";

	const workerFiles = [
		"/workers/weaken.js",
		"/workers/grow.js",
		"/workers/hack.js"
	];

	ns.tprint(`Starting Hack Manager in [ ${mode.toUpperCase()} ] mode...`);

	while (true) {
		// Crawl network and find all reachable servers
		const servers = getAllServers(ns);

		// Open ports and NUKE all eligible servers
		for (let server of servers) {
			if (server === "home") continue;
			attemptNuke(ns, server);
		}

		if (mode === "xp") {
			// XP Mode: Hardcode to an ultra-fast early game target like joesguns
			// and spam grow/weaken to maximize cycle velocity and experience gain
			let target = "joesguns";
			let scriptToRun;
			let securityThresh = ns.getServerMinSecurityLevel(target) + 2;

			// Deploy across full pool for XP
			await deployToPoolSubset(ns, workerFiles, scriptToRun, target, getWorkerPool(ns), 10);
		} else {
			// Money Mode: Get top 3 targets
			let topTargets = getTopTargets(ns, servers, 3);
			if (topTargets.length === 0) topTargets = ["n00dles"]; // Fallback

			let pool = getWorkerPool(ns);

			// Split the pool among the top targets (e.g., target 0 gets servers 0-8, target 1 gets 9-16, etc.)
			let chunkSize = Math.ceil(pool.length / topTargets.length);

			for (let i = 0; i < topTargets.length; i++) {
				let target = topTargets[i];
				let assignedServers = pool.slice(i * chunkSize, (i + 1) * chunkSize);

				if (assignedServers.length === 0) continue;

				let securityThresh = ns.getServerMinSecurityLevel(target) + 5;
				let moneyThresh = ns.getServerMaxMoney(target) * 0.50;

				let scriptToRun = "/workers/hack.js";
				if (ns.getServerSecurityLevel(target) > securityThresh) {
					scriptToRun = "/workers/weaken.js";
				} else if (ns.getServerMoneyAvailable(target) < moneyThresh) {
					scriptToRun = "/workers/grow.js";
				}

				// Deploy this target's script to its assigned slice of the pserv pool
				await deployToPoolSubset(ns, workerFiles, scriptToRun, target, assignedServers, i === 0 ? 10 : 0);
			}
		}
		// Sleep ONCE after deploying to all servers
		await ns.sleep(3000);
	}
}