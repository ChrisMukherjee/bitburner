// @ts-check
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

/** The augmentation that lets Bladeburner actions run alongside other work (bitburner-src v3.0.0 Bladeburner.ts). */
export const SIMULACRUM = "The Blade's Simulacrum";

/**
 * True once The Blade's Simulacrum is installed: the game then keeps a Bladeburner action running while the player works,
 * studies, trains or commits crimes (a bought, not yet installed copy doesn't count). Costs getResetInfo (1GB).
 */
/** @param {NS} ns */
export function simulacrumInstalled(ns) {
	return ns.getResetInfo().ownedAugs?.has(SIMULACRUM) ?? false;
}
