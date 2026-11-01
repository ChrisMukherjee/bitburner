/** @param {NS} ns **/
import { findPath } from "/utils/find-path.js"
import { getAllServers } from "/utils/get-all-servers.js"

export async function main(ns) {
	ns.disableLog("ALL");

	const servers = getAllServers(ns);
	let pendingBackdoors = [];

	for (let server of servers) {
		let serverObj = ns.getServer(server);

		// Skip home, player-purchased servers, unrooted servers, or already backdoored servers
		if (serverObj.purchasedByPlayer || !serverObj.hasAdminRights || serverObj.backdoorInstalled) {
			continue;
		}

		// Optional: Filter out servers where your hacking level is still too low
		let reqLevel = serverObj.requiredHackingLevel ?? ns.getServerRequiredHackingLevel(server);
		if (ns.getHackingLevel() < reqLevel) {
			continue;
		}

		let path = findPath(ns, server);
		pendingBackdoors.push({
			name: server,
			reqLevel: reqLevel,
			command: "home; " + path.slice(1).map(s => `connect ${s}`).join("; ") + "; backdoor"
		});
	}

	// Sort by required hacking level ascending
	pendingBackdoors.sort((a, b) => a.reqLevel - b.reqLevel);

	if (pendingBackdoors.length === 0) {
		ns.tprint("All eligible, hackable servers already have backdoors installed!");
		return;
	}

	ns.tprint("\n=== SERVERS PENDING BACKDOOR ===");
	for (let item of pendingBackdoors) {
		ns.tprint(`\n[ ${item.name} ] (Req Hacking: ${item.reqLevel})`);
		ns.tprint(`Copy/Paste into Terminal:\n  ${item.command}`);
	}
}