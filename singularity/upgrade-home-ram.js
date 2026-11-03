import { runUpgradeLoop } from "/singularity/home-upgrade-loop.js";
import { loadConfig } from "/utils/config.js";

const CONFIG = {
	// Spending stages are `homeRamBuying` in the config (config.js, data/config.json).
	loopMs: 10_000,
};

/**
 * Buys home RAM upgrades (Singularity) within the spending stages. Exits once home is maxed.
 * startup.js runs it with --once whenever the cash it last asked for is there, and picks up the
 * new stage from home RAM by itself.
 *   run singularity/upgrade-home-ram.js          keep buying as money comes in
 *   run singularity/upgrade-home-ram.js --once   buy what's affordable now, then exit
 *   run singularity/upgrade-home-ram.js --once --spend-all   spend all the cash on it (before an install)
 */
export async function main(ns) {
	await runUpgradeLoop(ns, {
		label: "home-ram",
		stages: loadConfig(ns).homeRamBuying,
		loopMs: CONFIG.loopMs,
		costOf: () => ns.singularity.getUpgradeHomeRamCost(),
		doUpgrade: () => ns.singularity.upgradeHomeRam(),
		describe: () => ns.format.ram(ns.getServerMaxRam("home")),
		gate: "home-ram",
	});
}
