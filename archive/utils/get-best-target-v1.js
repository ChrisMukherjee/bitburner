/** @param {NS} ns */
// Evaluate all rooted servers and select the best dynamic target
export function getBestTarget(ns, servers) {
	let bestTarget = "n00dles";
	let maxScore = -1;

	let playerLevel = ns.getHackingLevel();

	for (let server of servers) {
		if (!ns.hasRootAccess(server)) continue;

		let maxMoney = ns.getServerMaxMoney(server);
		let reqLevel = ns.getServerRequiredHackingLevel(server);

		// Ignore servers with no money or those above player's current hacking level
		// Also ignore home and private servers
		if (maxMoney <= 0 || reqLevel > playerLevel || server === "home" || server.startsWith("pserv-")) continue;

		let currentMoney = ns.getServerMoneyAvailable(server);
		let minSec = ns.getServerMinSecurityLevel(server);
		let currSec = ns.getServerSecurityLevel(server);
		let hackingTime = ns.getHackTime(server);

		// True money ratio: If the server is drained to 0, its score drops to 0
		let moneyFactor = currentMoney / maxMoney;

		// Security penalty: Higher current security relative to min security degrades score
		let secPenalty = Math.max(1, currSec - minSec);

		// Score = (Effective Max Money * Money Health Ratio) / (Hack Time * Security Penalty)
		let score = (maxMoney * moneyFactor) / (hackingTime * secPenalty);

		if (score > maxScore) {
			maxScore = score;
			bestTarget = server;
		}
	}

	return bestTarget;
}