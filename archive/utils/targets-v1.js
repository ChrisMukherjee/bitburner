/** @param {NS} ns **/
// Hacking-target evaluation shared by the batcher and the state dump, so both rank servers the same way.

/**
 * True for servers worth hacking right now: rooted, not ours, has money, within hacking level.
 * Pass a server object from ns.getServer.
 */
export function isHackable(server, hackingLevel) {
	return !server.purchasedByPlayer && server.hostname !== "home" && server.hasAdminRights &&
		server.moneyMax > 0 && server.requiredHackingSkill <= hackingLevel;
}

/** True once Formulas.exe is on home. Check it every time: it can be bought mid-run. */
export function hasFormulas(ns) {
	return ns.fileExists("Formulas.exe", "home");
}

/**
 * The target's server object as it will be once prepped: min security, and max money unless
 * moneyAvailable is given. For feeding to ns.formulas.hacking.
 */
export function preppedServer(ns, target, moneyAvailable) {
	const server = ns.getServer(target);
	server.hackDifficulty = server.minDifficulty;
	server.moneyAvailable = moneyAvailable ?? server.moneyMax;
	return server;
}

/**
 * What a target looks like once prepped (min security). With Formulas.exe the game computes it
 * exactly. Without it: hack time, grow time and weaken time all scale with
 * (2.5 * requiredLevel * security + 500), and hack chance and hack percent with (100 - security),
 * so current values are rescaled to min security.
 * Returns { weaken (ms), hackPerThread (fraction), chance }.
 */
export function estimateAtMinSecurity(ns, target, player) {
	if (hasFormulas(ns)) {
		const prepped = preppedServer(ns, target);
		player = player ?? ns.getPlayer();
		return {
			weaken: ns.formulas.hacking.weakenTime(prepped, player),
			hackPerThread: ns.formulas.hacking.hackPercent(prepped, player),
			chance: ns.formulas.hacking.hackChance(prepped, player),
		};
	}
	const server = ns.getServer(target);
	const security = server.hackDifficulty;
	const minSecurity = server.minDifficulty;
	const timeScale = (2.5 * server.requiredHackingSkill * minSecurity + 500) /
		(2.5 * server.requiredHackingSkill * security + 500);
	const hackScale = (100 - minSecurity) / Math.max(1e-9, 100 - security);
	return {
		weaken: ns.getWeakenTime(target) * timeScale,
		hackPerThread: ns.hackAnalyze(target) * hackScale,
		chance: Math.min(1, ns.hackAnalyzeChance(target) * hackScale),
	};
}

/**
 * Money per ms of weaken time once prepped. At a fixed batch spacing, income from a target is
 * proportional to maxMoney x chance, and the RAM it ties up to weaken time, so this ranks
 * targets by money per unit of RAM-time. Pass an estimate to avoid computing it twice.
 */
export function scoreTarget(ns, target, estimate = estimateAtMinSecurity(ns, target)) {
	if (!(estimate.weaken > 0)) return 0;
	return (ns.getServerMaxMoney(target) * estimate.chance) / estimate.weaken;
}
