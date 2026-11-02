/** @param {NS} ns */
// Attempt to open available ports and root a server
export function attemptNuke(ns, server) {
	if (ns.hasRootAccess(server)) return;

	// Open ports based on tools currently owned
	let openPorts = 0;
	if (ns.fileExists("BruteSSH.exe")) { ns.brutessh(server); openPorts++; }
	if (ns.fileExists("FTPCrack.exe")) { ns.ftpcrack(server); openPorts++; }
	if (ns.fileExists("relaySMTP.exe")) { ns.relaysmtp(server); openPorts++; }
	if (ns.fileExists("HTTPWorm.exe")) { ns.httpworm(server); openPorts++; }
	if (ns.fileExists("SQLInject.exe")) { ns.sqlinject(server); openPorts++; }

	// Root server if required ports are met and we don't have access yet
	if (ns.getServerNumPortsRequired(server) <= openPorts &&
		ns.getHackingLevel() >= ns.getServerRequiredHackingLevel(server)) {
		ns.nuke(server);
		ns.tprint(`Rooted: ${server}`);
	}
}