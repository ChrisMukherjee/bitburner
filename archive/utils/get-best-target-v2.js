/** @param {NS} ns */
export function pickTarget(ns, allServers) {
	let bestTarget = "n00dles";
	let bestScore = 0;
	for (const server of allServers) {
		const score = scoreTarget(ns, server);
		if (score > bestScore) {
			bestScore = score;
			bestTarget = server;
		}
	}
	return bestTarget;
}

// Money per unit of RAM-time: batches that take longer to finish hold their RAM longer.
export function scoreTarget(ns, server) {
	if (!server || server === "home") return 0;
	const serverInfo = ns.getServer(server);
	if (serverInfo.purchasedByPlayer || !serverInfo.hasAdminRights) return 0;
	const maxMoney = serverInfo.moneyMax || 0;
	if (maxMoney <= 0) return 0;
	const maxRequiredLevel = Math.max(1, Math.floor(ns.getHackingLevel() / 2));
	if (serverInfo.requiredHackingSkill > maxRequiredLevel) return 0;
	return (maxMoney * ns.hackAnalyzeChance(server)) / ns.getWeakenTime(server);
}