// @ts-check
import { bitnodeMults } from "/utils/bitnode-mults.js";
import { forbids, forbiddenWhy } from "/utils/forbid.js";

/**
 * What this BitNode does to Bladeburner, from the game's own multipliers (ns.getBitNodeMultipliers, saved each run by
 * tools/save-bitnode-mults.js and read with utils/bitnode-mults.js): { rank, skillCost, combatLevel, hackingLevel, known }.
 * `rank` multiplies every action's rank gain (0 = the game won't let the division be joined), `skillCost` every skill's price,
 * `combatLevel` and `hackingLevel` the levels the stats' exp gives. `known` false (no Source-File 5, or not saved yet): every
 * value is 1 and hackingLevel/combatLevel are null, so nothing is judged from them. 0GB.
 */
/** @param {NS} ns */
export function bladeburnerNodeMults(ns) {
	const saved = bitnodeMults(ns);
	if (!saved.known) return { rank: 1, skillCost: 1, combatLevel: null, hackingLevel: null, known: false };
	const combat = ["StrengthLevelMultiplier", "DefenseLevelMultiplier", "DexterityLevelMultiplier", "AgilityLevelMultiplier"].map((key) => saved.get(key));
	return {
		rank: saved.get("BladeburnerRank"), skillCost: saved.get("BladeburnerSkillCost"),
		combatLevel: Math.min(...combat), hackingLevel: saved.get("HackingLevelMultiplier"), known: true,
	};
}

/**
 * What this run can do with Bladeburner. The one place that knows the rule: the Bladeburner API works in BitNode 6 and 7, and
 * anywhere once you own Source-File 6 or 7, except where the BitNode's multipliers give no rank (the game then refuses to join)
 * or its advanced options disable Bladeburner. Without that check the scripts trained combat to 100 for a division that never
 * opens. The multipliers need Source-File 5 (bladeburnerNodeMults); without them only a join attempt can tell. A challenge that forbids
 * the division (`forbid` in the config, the BN6 and BN7 challenges) also makes it not available, so nothing joins it. Costs getResetInfo (1GB).
 *
 *   { available, why, forbidden }   why: the reason when not available; forbidden: a challenge is why
 */
/** @param {NS} ns @param {{ forbid?: string[] } | null} [config] the loaded config (callers that have it pass it; without it nothing is forbidden) */
export function bladeburnerAccess(ns, config = null) {
	const info = ns.getResetInfo();
	if (!([6, 7].includes(info.currentNode) || info.ownedSF.has(6) || info.ownedSF.has(7))) {
		return { available: false, forbidden: false, why: "needs BitNode 6 or 7 or Source-File 6 or 7" };
	}
	if (info.bitNodeOptions?.disableBladeburner) return { available: false, forbidden: false, why: "disabled by this BitNode's advanced options" };
	if (bladeburnerNodeMults(ns).rank <= 0) return { available: false, forbidden: false, why: "this BitNode's multipliers give no Bladeburner rank (BladeburnerRank 0), so the division can't be joined" };
	if (forbids(config, "bladeburner")) return { available: false, forbidden: true, why: forbiddenWhy("bladeburner") };
	return { available: true, forbidden: false, why: "" };
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
