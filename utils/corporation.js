// Design: docs/corporation.md
// @ts-check
import { forbids, forbiddenWhy } from "/utils/forbid.js";

/**
 * What this run can do with a corporation. The one place that knows the rules (bitburner-src v3.0.0, Corporation/helpers.ts
 * and PlayerObjectCorporationMethods.ts):
 *   - the Corporation API works in BitNode 3, and anywhere once you own Source-File 3;
 *   - in BitNode 3 a corporation can start on the government's seed money (free; it takes 500m of the 1.5b shares),
 *     elsewhere it is self-funded: $150b of the player's own cash;
 *   - in BitNode 3, or with Source-File 3.3, a new corporation has the Office and Warehouse APIs; otherwise they are
 *     unlocks bought with corporation funds ($50b each), and nothing else can be scripted until they are;
 *   - a BitNode whose CorporationSoftcap is below 0.15, or an advanced option, rules corporations out: the game's own
 *     canCreateCorporation says so (0GB);
 *   - a challenge that forbids corporations (`forbid` in the config, the BN3 challenge: the game checks that none exists when
 *     the BitNode is destroyed) makes it not available until one exists; one that already exists is left alone.
 * hasCorporation and canCreateCorporation cost 0GB, getResetInfo 1GB.
 *
 *   { available, hasCorp, canCreate, seedMoney, cost, apisFree, why }, plus forbidden: true only when a challenge is the reason
 *   available: the API works in this run; hasCorp: a corporation exists; canCreate: the game would let one be created now (money
 *   aside); seedMoney: BitNode 3 (free start); cost: what creating one costs the player ($0 or $150b); apisFree: the Office
 *   and Warehouse APIs come with it; why: the game's reason when one can't be created, else "".
 */
/** @param {NS} ns @param {{ forbid?: string[] } | null} [config] the loaded config (callers that have it pass it; without it nothing is forbidden) */
export function corpAccess(ns, config = null) {
	const info = ns.getResetInfo();
	const api = corpApiFromInfo(info);
	const hasCorp = api && ns.corporation.hasCorporation();
	const forbidden = api && !hasCorp && forbids(config, "corporation");
	const available = api && !forbidden;
	const seedMoney = seedMoneyFromInfo(info);
	const check = available && !hasCorp ? String(ns.corporation.canCreateCorporation(!seedMoney)) : "";
	const canCreate = !hasCorp && check === "Success";
	return {
		available, hasCorp, canCreate, seedMoney, cost: seedMoney ? 0 : SELF_FUND_COST, apisFree: corpApisFreeFromInfo(info),
		why: forbidden ? forbiddenWhy("corporation") : hasCorp || canCreate || !available ? "" : createRefusal(check),
		...(forbidden ? { forbidden } : {}),
	};
}

/** What a self-funded corporation costs the player (game: costOfCreatingCorporation). */
export const SELF_FUND_COST = 150e9;

/** Whether the Corporation API works by BitNode and Source-Files alone (BitNode 3 or Source-File 3). Pure, 0GB. @param {{ currentNode: number, ownedSF: Map<number, number> }} info */
export function corpApiFromInfo(info) {
	return info.currentNode === 3 || info.ownedSF.has(3);
}

/** BitNode 3 only: a corporation can start on seed money. Pure, 0GB. @param {{ currentNode: number }} info */
export function seedMoneyFromInfo(info) {
	return info.currentNode === 3;
}

/** The Office and Warehouse APIs come free with a new corporation (BitNode 3, or Source-File 3.3). Pure, 0GB. @param {{ currentNode: number, ownedSF: Map<number, number> }} info */
export function corpApisFreeFromInfo(info) {
	return info.currentNode === 3 || (info.ownedSF.get(3) ?? 0) >= 3;
}

/** The game's CreatingCorporationCheckResult as a reason a player can read. @param {string} check */
export function createRefusal(check) {
	if (check === "DisabledBySoftCap") return "this BitNode does not allow corporations";
	if (check === "NoSf3OrDisabled") return "corporations are switched off for this run (an advanced BitNode option)";
	if (check === "UseSeedMoneyOutsideBN3") return "seed money only exists in BitNode 3";
	if (check === "CorporationExists") return "";
	return check ? `the game refused (${check})` : "";
}
