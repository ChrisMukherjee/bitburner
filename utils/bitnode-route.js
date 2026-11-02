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
