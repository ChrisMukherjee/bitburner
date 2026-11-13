// Design: docs/sleeves.md
// @ts-check
/**
 * What this run can do with sleeves. The one place that knows the rules:
 *   - the Sleeve API works in BitNode 10, and anywhere once you own Source-File 10;
 *   - buying sleeves and memory upgrades (purchaseSleeve, upgradeMemory) only works inside BitNode 10;
 *     elsewhere Source-File 10 hands out its sleeves for free and nothing more can be bought.
 * Costs getResetInfo (1GB).
 *
 *   { available, canBuy }
 */
/** @param {NS} ns */
export function sleevesAccess(ns) {
	const info = ns.getResetInfo();
	return { available: sleevesApiFromInfo(info), canBuy: sleevesBuyableFromInfo(info) };
}

/** Whether the Sleeve API works by BitNode and Source-Files alone, from a getResetInfo() result. Pure, 0GB. @param {{ currentNode: number, ownedSF: Map<number, number> }} info */
export function sleevesApiFromInfo(info) {
	return info.currentNode === 10 || info.ownedSF.has(10);
}

/** Whether sleeves and memory can be bought (BitNode 10 only), from a getResetInfo() result. Pure, 0GB. @param {{ currentNode: number }} info */
export function sleevesBuyableFromInfo(info) {
	return info.currentNode === 10;
}
