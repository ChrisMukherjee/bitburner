/**
 * What this run can do with Bladeburner. The one place that knows the rule: the Bladeburner API works
 * in BitNode 6 and 7, and anywhere once you own Source-File 6 or 7. Costs getResetInfo (1GB).
 *
 *   { available }
 */
/** @param {NS} ns */
export function bladeburnerAccess(ns) {
	const info = ns.getResetInfo();
	const available = [6, 7].includes(info.currentNode) || info.ownedSF.has(6) || info.ownedSF.has(7);
	return { available };
}
