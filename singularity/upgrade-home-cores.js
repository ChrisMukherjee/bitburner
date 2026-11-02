import { runUpgradeLoop } from "/singularity/home-upgrade-loop.js";
import { loadConfig } from "/utils/config.js";

const CONFIG = {
	// Spending stages are `homeCoresBuying` in the config (config.js, data/config.json).
	loopMs: 30_000,
};

/**
 * Buys home CPU core upgrades (Singularity) within the spending stages. Exits once home is maxed.
 *   run singularity/upgrade-home-cores.js          keep buying as money comes in
 *   run singularity/upgrade-home-cores.js --once   buy what's affordable now, then exit
 */
export async function main(ns) {
	await runUpgradeLoop(ns, {
		label: "home-cores",
		stages: loadConfig(ns).homeCoresBuying,
		loopMs: CONFIG.loopMs,
		costOf: () => ns.singularity.getUpgradeHomeCoresCost(),
		doUpgrade: () => ns.singularity.upgradeHomeCores(),
	});
}
