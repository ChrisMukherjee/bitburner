/**
 * What this run can do with gangs. The one place that knows the gang rules per BitNode:
 *   - the Gang API works in BitNode 2, and anywhere once you own Source-File 2 (or are in a gang);
 *   - in BitNode 2 a gang only needs a gang faction's invite; elsewhere also karma -54,000.
 * Costs getResetInfo (1GB); gang.inGang and heart.break are free.
 *
 *   { available, inGang, karmaNeeded, canCreate }
 *   karmaNeeded: 0 or -54,000; canCreate: karma is low enough (or already in a gang).
 */
/** @param {NS} ns */
export function gangAccess(ns) {
	const info = ns.getResetInfo();
	const inGang = ns.gang.inGang();
	const homeNode = info.currentNode === 2;
	const available = inGang || homeNode || info.ownedSF.has(2);
	const karmaNeeded = homeNode ? 0 : -54_000;
	const canCreate = inGang || (available && ns.heart.break() <= karmaNeeded);
	return { available, inGang, karmaNeeded, canCreate };
}
