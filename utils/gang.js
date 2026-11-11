// @ts-check
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
	const available = inGang || gangApiFromInfo(info);
	const karmaNeeded = homeNode ? 0 : -54_000;
	const canCreate = inGang || (available && ns.heart.break() <= karmaNeeded);
	return { available, inGang, karmaNeeded, canCreate };
}

/** Whether the Gang API works by BitNode and Source-Files alone (BitNode 2 or Source-File 2), from a getResetInfo() result. Pure, 0GB. @param {{ currentNode: number, ownedSF: Map<number, number> }} info */
export function gangApiFromInfo(info) {
	return info.currentNode === 2 || info.ownedSF.has(2);
}
