/** @param {NS} ns **/
import { getAllServers } from "/scripts/get-all-servers.js"
import { attemptNuke } from "/scripts/attempt-nuke.js"
import { getBestTarget } from "/scripts/get-best-target.js"

export async function main(ns) {
	// Disable log spam in the script's active log window
	ns.disableLog("ALL");

	const targetScript = "early-hack.js"; // Your basic hack/grow/weaken script
	const ramPerThread = ns.getScriptRam(targetScript);

	// Crawl network and find all reachable servers
	const servers = getAllServers(ns);

	// Open ports and NUKE all eligible servers
	for (let server of servers) {
		if (server === "home") continue;
		attemptNuke(ns, server);
	}

	// Find the best current target on the network based on current stats
	let target = getBestTarget(ns, servers);

	// Deploy worker scripts across all rooted servers
	for (let server of servers) {
		if (ns.hasRootAccess(server)) {
			await ns.scp(targetScript, server, "home");

			let ramAvailable = ns.getServerMaxRam(server) - ns.getServerUsedRam(server);
			let threads = Math.floor(ramAvailable / ramPerThread);

			if (threads > 0 && !ns.scriptRunning(targetScript, server)) {
				ns.exec(targetScript, server, threads, target);
				ns.tprint(`Started ${targetScript} on ${server} with ${threads} threads.`);
			}
		}
		// Sleep for 30 seconds before re-evaluating targets and opening newly accessible servers
		await ns.sleep(30000);
	}
}