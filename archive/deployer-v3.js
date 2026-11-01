/** @param {NS} ns **/
import { getAllServers } from "/scripts/get-all-servers.js"
import { attemptNuke } from "/scripts/attempt-nuke.js"
import { getBestTarget } from "/scripts/get-best-target.js"

export async function main(ns) {
	// Disable log spam in the script's active log window
	ns.disableLog("ALL");

	const workerFiles = [
		"/shared/weaken.js",
		"/shared/grow.js",
		"/shared/hack.js"
	];

	while (true) {
		// Crawl network and find all reachable servers
		const servers = getAllServers(ns);

		// Open ports and NUKE all eligible servers
		for (let server of servers) {
			if (server === "home") continue;
			attemptNuke(ns, server);
		}

		// Find the best current target on the network based on current stats
		let target = getBestTarget(ns, servers);

		// Determine what the target server needs right now
		let securityThresh = ns.getServerMinSecurityLevel(target) + 5;
		let moneyThresh = ns.getServerMaxMoney(target) * 0.75;

		let scriptToRun = "/shared/hack.js";
		let actionTime = ns.getHackTime(target);

		if (ns.getServerSecurityLevel(target) > securityThresh) {
			scriptToRun = "/shared/weaken.js";
			actionTime = ns.getWeakenTime(target);
		} else if (ns.getServerMoneyAvailable(target) < moneyThresh) {
			scriptToRun = "/shared/grow.js";
			actionTime = ns.getGrowTime(target);
		}

		let ramPerThread = ns.getScriptRam(scriptToRun);

		// Deploy worker scripts across all rooted servers
		for (let server of servers) {
			if (!ns.hasRootAccess(server)) continue;

			// Copy worker files to foreign server if needed
			if (server !== "home") {
				await ns.scp(workerFiles, server, "home");
			}

			// Calculate available RAM (reserve 10GB on home for user scripts)
			let maxRam = ns.getServerMaxRam(server);
			let usedRam = ns.getServerUsedRam(server);
			if (server === "home") {
				usedRam = Math.max(usedRam, 10);
			}

			let ramAvailable = Math.max(0, maxRam - usedRam);
			let threads = Math.floor(ramAvailable / ramPerThread);

			if (threads > 0) {
				ns.exec(scriptToRun, server, threads, target);
			}
		}
		// Sleep ONCE after deploying to all servers
		// Sleep for the duration of the action + 500ms buffer before re-evaluating
		await ns.sleep(actionTime + 500);
	}
}