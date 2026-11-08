// @ts-check
/** @param {NS} ns **/
import { getAllServers } from "/utils/get-all-servers.js";

export function nukeAllServers(ns) {
	const servers = getAllServers(ns);
	let portsAvailable = 0;

	// Count available port-opening tools
	if (ns.fileExists("BruteSSH.exe", "home")) portsAvailable++;
	if (ns.fileExists("FTPCrack.exe", "home")) portsAvailable++;
	if (ns.fileExists("relaySMTP.exe", "home")) portsAvailable++;
	if (ns.fileExists("HTTPWorm.exe", "home")) portsAvailable++;
	if (ns.fileExists("SQLInject.exe", "home")) portsAvailable++;

	for (let s of servers) {
		if (ns.hasRootAccess(s)) continue;

		// Skip if the server requires more open ports than we currently have tools for
		// (getServerNumPortsRequired is 0.1GB; ns.getServer would be 2GB)
		if (ns.getServerNumPortsRequired(s) > portsAvailable) continue;

		// Open available ports
		if (ns.fileExists("BruteSSH.exe", "home")) ns.brutessh(s);
		if (ns.fileExists("FTPCrack.exe", "home")) ns.ftpcrack(s);
		if (ns.fileExists("relaySMTP.exe", "home")) ns.relaysmtp(s);
		if (ns.fileExists("HTTPWorm.exe", "home")) ns.httpworm(s);
		if (ns.fileExists("SQLInject.exe", "home")) ns.sqlinject(s);

		ns.nuke(s);
		ns.tprint(`Gained root access on: ${s}`);
	}
}