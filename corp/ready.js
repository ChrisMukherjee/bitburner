// Design: docs/corporation.md
// @ts-check
import { corpApiFromInfo, seedMoneyFromInfo, SELF_FUND_COST } from "/utils/corporation.js";
import { forbids } from "/utils/forbid.js";

/**
 * For startup.js: corp/corp-manager.js has something to do when the Corporation API works in this run (BitNode 3, or
 * Source-File 3), `corp.enabled` is not switched off, and a corporation exists or can be made now: on seed money in BitNode 3,
 * or, elsewhere, with `corp.selfFund` on and the cash at `selfFundCash` x the $150b price. The game's own canCreateCorporation
 * (0GB) rules out BitNodes that disable corporations; a challenge that forbids one (`forbid`, the BN3 challenge) keeps it from being
 * made. Reads the getResetInfo and cash startup.js already pays for.
 */
/** @param {NS} ns */
export function corpReady(ns, config) {
	const settings = config.corp;
	if (settings?.enabled === false) return false;
	const info = ns.getResetInfo();
	if (!corpApiFromInfo(info)) return false;
	if (ns.corporation.hasCorporation()) return true;
	if (forbids(config, "corporation")) return false;
	const seed = seedMoneyFromInfo(info);
	if (String(ns.corporation.canCreateCorporation(!seed)) !== "Success") return false;
	if (seed) return true;
	return !!settings?.selfFund && ns.getServerMoneyAvailable("home") >= SELF_FUND_COST * (settings.selfFundCash ?? 1);
}
