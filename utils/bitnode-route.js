// @ts-check
/**
 * Which BitNode to go to next, from `bitnodeRoute` in the config (a list of { bitNode, level }).
 * The first entry whose Source-File level isn't reached yet wins, counting the level that
 * destroying this BitNode now would give. Returns that entry, or null when the route is done.
 *
 * Shared by singularity/auto-destroy.js (which acts on it) and tools/status.js (which shows it).
 * Costs only getResetInfo (1GB).
 */
/** @param {NS} ns */
export function nextRouteStep(ns, route) {
	const info = ns.getResetInfo();
	const levels = new Map(info.ownedSF);
	levels.set(info.currentNode, (levels.get(info.currentNode) ?? 0) + 1); // what destroying now gives
	return route.find((step) => (levels.get(step.bitNode) ?? 0) < step.level) ?? null;
}

/** Source-File levels as they will be once this BitNode ends. */
function levelsAfterDestroy(ns) {
	const info = ns.getResetInfo();
	const levels = new Map(info.ownedSF);
	levels.set(info.currentNode, (levels.get(info.currentNode) ?? 0) + 1);
	return levels;
}

/**
 * How easy a BitNode's multipliers make it, as a number (higher is easier; 0 when unknown). The mean of ln of what pays
 * (hack money, server money, hacking level, faction rep) minus ln of what costs (augment money and rep), so one
 * multiplier of 0.5 weighs as much as another of 2 weighs the other way.
 */
export function easeScore(mults) {
	if (!mults) return 0;
	const ln = (name) => Math.log(Math.max(0.01, mults[name] ?? 1));
	const good = ["ScriptHackMoney", "ServerMaxMoney", "HackingLevelMultiplier", "FactionWorkRepGain"].map(ln);
	const bad = ["AugmentationMoneyCost", "AugmentationRepCost"].map(ln);
	return (good.reduce((a, b) => a + b, 0) - bad.reduce((a, b) => a + b, 0)) / (good.length + bad.length);
}

/**
 * The BitNode the config's bitnodePlan suggests next, or null when every entry is reached: the first tier with a
 * Source-File level not owned yet (counting this destroy), and in it the entry whose multipliers make it easiest
 * (the saved ones from utils/bitnode-mults.js, so only with Source-File 5; otherwise the listed order).
 * Returns { bitNode, level, why }. 1GB (getResetInfo).
 */
/** @param {NS} ns */
export function suggestedStep(ns, plan, mults) {
	const levels = levelsAfterDestroy(ns);
	const open = (plan ?? []).filter((step) => (levels.get(step.bitNode) ?? 0) < step.level);
	if (!open.length) return null;
	const tier = Math.min(...open.map((step) => step.tier ?? 1));
	const inTier = open.filter((step) => (step.tier ?? 1) === tier);
	const scored = inTier.map((step) => ({ step, score: easeScore(mults?.other(step.bitNode)) }));
	const known = mults?.known && scored.some((item) => item.score !== 0);
	const best = known ? scored.reduce((a, b) => (b.score > a.score ? b : a)) : scored[0];
	const scores = scored.map((item) => `${item.step.bitNode}: ${item.score >= 0 ? "+" : ""}${item.score.toFixed(2)}`).join(", ");
	const why = known && inTier.length > 1 ? `tier ${tier}, easiest multipliers of ${inTier.map((step) => step.bitNode).join("/")} (ease ${scores})` : `tier ${tier} of the plan`;
	return { bitNode: best.step.bitNode, level: best.step.level, why };
}

/**
 * Where to go next, in order of who decided: your bitnodeRoute (source "route"), else the plan's suggestion when
 * bitnodeRouteAuto is true ("suggested", also after your route is done), else only the suggestion for display with source "suggestion-only".
 * { bitNode, level, source, why } or null. `mults` is bitnodeMults(ns) from utils/bitnode-mults.js.
 */
/** @param {NS} ns */
export function routeStep(ns, config, mults) {
	const own = nextRouteStep(ns, config.bitnodeRoute ?? []);
	if (own) return { ...own, source: "route", why: "your bitnodeRoute" };
	// Your route is done: without auto you pick, as before; with auto the plan carries on from here.
	if ((config.bitnodeRoute ?? []).length && !config.bitnodeRouteAuto) return null;
	const suggestion = suggestedStep(ns, config.bitnodePlan, mults);
	if (!suggestion) return null;
	return { ...suggestion, source: config.bitnodeRouteAuto ? "suggested" : "suggestion-only" };
}
