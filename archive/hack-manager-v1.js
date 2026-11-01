/** @param {NS} ns **/
import { getAllServers } from "/scripts/get-all-servers.js"
import { attemptNuke } from "/scripts/attempt-nuke.js"
import { getBestTarget } from "/scripts/get-best-target.js"
import { deployToPool } from "/scripts/workpool.js"

export async function main(ns) {
	// Disable log spam in the script's active log window
	ns.disableLog("ALL");

	// Accept a mode argument: pass "xp" for power-leveling, defaults to "money"
	const mode = ns.args[0] ? ns.args[0].toLowerCase() : "money";

	const workerFiles = [
		"/shared/weaken.js",
		"/shared/grow.js",
		"/shared/hack.js"
	];

	ns.print(`Starting Hack Manager in [ ${mode.toUpperCase()} ] mode...`);

	while (true) {
		// Crawl network and find all reachable servers
		const servers = getAllServers(ns);

		// Open ports and NUKE all eligible servers
		for (let server of servers) {
			if (server === "home") continue;
			attemptNuke(ns, server);
		}

		let target;
		let scriptToRun;

		if (mode === "xp") {
			// XP Mode: Hardcode to an ultra-fast early game target like joesguns
			// and spam grow/weaken to maximize cycle velocity and experience gain
			target = "joesguns";

			let securityThresh = ns.getServerMinSecurityLevel(target) + 2;
			if (ns.getServerSecurityLevel(target) > securityThresh) {
				scriptToRun = "/shared/weaken.js";
			} else {
				scriptToRun = "/shared/grow.js";
			}
		} else {
			// Money Mode: Use dynamic scoring formula and 85% threshold
			target = getBestTarget(ns, servers);

			// Determine what the target server needs right now
			let securityThresh = ns.getServerMinSecurityLevel(target) + 5;
			let moneyThresh = ns.getServerMaxMoney(target) * 0.50;

			scriptToRun = "/shared/hack.js";

			if (ns.getServerSecurityLevel(target) > securityThresh) {
				scriptToRun = "/shared/weaken.js";
			} else if (ns.getServerMoneyAvailable(target) < moneyThresh) {
				scriptToRun = "/shared/grow.js";
			}
		}

		// Deploy worker scripts across your worker pool (home + cloud servers) using the utility
		await deployToPool(ns, workerFiles, scriptToRun, target, 10);

		// Sleep ONCE after deploying to all servers
		await ns.sleep(3000);
	}
}