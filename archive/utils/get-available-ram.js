/** @param {NS} ns */
import { getAllServers } from "/utils/get-all-servers.js";

export function getAvailableRam(ns) {
	const servers = getAllServers(ns);
	let totalFree = 0;
	for (let s of servers) {
		let serverObj = ns.getServer(s);
		if (serverObj.hasAdminRights) {
			totalFree += (ns.getServerMaxRam(s) - ns.getServerUsedRam(s));
		}
	}
	return totalFree;
}