// Design: docs/api-advice.md
// @ts-check
import { loadConfig } from "/utils/config.js";
import { adviseOnce, missingList } from "/utils/api-advice.js";
import { singularityFromInfo } from "/utils/singularity.js";
import { bitnodeMultsFromInfo } from "/utils/sf5.js";
import { gangApiFromInfo } from "/utils/gang.js";
import { bladeburnerAccess } from "/utils/bladeburner.js";

/**
 * One-shot: finds which APIs and items the scripts can use but this run lacks (Singularity, BitNode multipliers, Formulas.exe,
 * Gang, Bladeburner), prints what to do about each once per BitNode run (what is missing, what the scripts do meanwhile, which
 * BitNode to destroy or what to buy), and leaves the list in data/api-advice.json for `status`. startup.js runs it every
 * 10 minutes, so the advice drops away when you get the thing (Formulas.exe bought, a Source-File earned) and comes
 * back changed as your Source-Files change. `missingApiAdvice.enabled: false` in the config turns it off.
 */
/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	const config = loadConfig(ns);
	if (config.missingApiAdvice?.enabled === false) return;
	const info = ns.getResetInfo();
	const have = {
		singularity: singularityFromInfo(info).available,
		multipliers: bitnodeMultsFromInfo(info).available,
		formulas: ns.fileExists("Formulas.exe", "home"),
		gang: gangApiFromInfo(info),
		bladeburner: bladeburnerAccess(ns),
	};
	const missing = missingList(info, have, { plan: config.bitnodePlan, tor: ns.hasTorRouter() });
	adviseOnce(ns, missing, info, config, { replace: true });
}
