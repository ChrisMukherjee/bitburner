/** @param {NS} ns **/
// Evaluate all rooted servers and return the top N targets sorted by score
export function getTopTargets(ns, servers, limit = 3) {
	let scoredServers = [];

	let playerLevel = ns.getHackingLevel();

	for (let server of servers) {
		if (!ns.hasRootAccess(server)) continue;

		let maxMoney = ns.getServerMaxMoney(server);
		let reqLevel = ns.getServerRequiredHackingLevel(server);

		if (maxMoney <= 0 || reqLevel > playerLevel || server === "home" || server.startsWith("pserv-")) continue;

		let currentMoney = ns.getServerMoneyAvailable(server);
		let minSec = ns.getServerMinSecurityLevel(server);
		let currSec = ns.getServerSecurityLevel(server);
		let hackTime = ns.getHackTime(server);

		let moneyFactor = currentMoney / maxMoney;
		let secPenalty = Math.max(1, currSec - minSec);
		let score = (maxMoney * moneyFactor) / (hackTime * secPenalty);

		scoredServers.push({ name: server, score: score });
	}

	// Sort descending by score
	scoredServers.sort((a, b) => b.score - a.score);

	// Return just the server name strings up to the limit
	return scoredServers.slice(0, limit).map(s => s.name);
}