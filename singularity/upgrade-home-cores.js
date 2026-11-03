import { runUpgradeLoop } from "/singularity/home-upgrade-loop.js";
import { loadConfig } from "/utils/config.js";

const CONFIG = {
	loopMs: 30_000,
};

/**
 * Buys home CPU core upgrades (Singularity) while the cash left covers `homeUpgrades.cores.reserveSeconds` of income. Exits once home is maxed.
 * startup.js runs it with --once whenever the cash it last asked for is there.
 *   run singularity/upgrade-home-cores.js          keep buying as money comes in
 *   run singularity/upgrade-home-cores.js --once   buy what's affordable now, then exit
 *   run singularity/upgrade-home-cores.js --once --spend-all   spend all the cash on it (before an install)
 */
export async function main(ns) {
	await runUpgradeLoop(ns, {
		label: "home-cores",
		...loadConfig(ns).homeUpgrades.cores,
		loopMs: CONFIG.loopMs,
		costOf: () => ns.singularity.getUpgradeHomeCoresCost(),
		doUpgrade: () => ns.singularity.upgradeHomeCores(),
		gate: "home-cores",
	});
}
