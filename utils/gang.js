// @ts-check
import { karmaNeededFromInfo } from "/utils/gang-karma.js";
import { forbids, forbiddenWhy } from "/utils/forbid.js";
export { karmaNeededFromInfo };
/**
 * What this run can do with gangs. The one place that knows the gang rules per BitNode:
 *   - the Gang API works in BitNode 2, and anywhere once you own Source-File 2 (or are in a gang);
 *   - in BitNode 2 a gang only needs a gang faction's invite; elsewhere also karma -54,000.
 * A challenge that forbids gangs (`forbid` in the config, the BN2 challenge) makes it not available until a gang exists; one that is
 * already formed is left alone (the attempt is lost, but nothing here can undo it).
 * Costs getResetInfo (1GB); gang.inGang and heart.break are free.
 *
 *   { available, inGang, karmaNeeded, canCreate, forbidden, why }
 *   karmaNeeded: 0 or -54,000; canCreate: karma is low enough (or already in a gang); forbidden: a challenge forbids forming one;
 *   why: the reason when forbidden.
 */
/** @param {NS} ns @param {{ forbid?: string[] } | null} [config] the loaded config (callers that have it pass it; without it nothing is forbidden) */
export function gangAccess(ns, config = null) {
	const info = ns.getResetInfo();
	const inGang = ns.gang.inGang();
	const forbidden = !inGang && forbids(config, "gang");
	const available = inGang || (gangApiFromInfo(info) && !forbidden);
	const karmaNeeded = karmaNeededFromInfo(info);
	const canCreate = inGang || (available && ns.heart.break() <= karmaNeeded);
	return { available, inGang, karmaNeeded, canCreate, forbidden, why: forbidden ? forbiddenWhy("gang") : "" };
}

/** Whether the Gang API works by BitNode and Source-Files alone (BitNode 2 or Source-File 2), from a getResetInfo() result. Pure, 0GB. @param {{ currentNode: number, ownedSF: Map<number, number> }} info */
export function gangApiFromInfo(info) {
	return info.currentNode === 2 || info.ownedSF.has(2);
}

