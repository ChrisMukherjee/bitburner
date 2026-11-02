import { runUpgradeLoop } from "/singularity/home-upgrade-loop.js";
import { loadConfig } from "/utils/config.js";

const CONFIG = {
	// Spending stages are `homeRamBuying` in the config (config.js, data/config.json).
	loopMs: 10_000,
};

// Started after every upgrade, so new stages and scripts that didn't fit get going by themselves.
const RELAUNCH = "startup.js";

/**
 * Buys home RAM upgrades (Singularity) within the spending stages. Exits once home is maxed.
 * After an upgrade it runs startup.js on home (retrying each pass until home has room for it).
 *   run singularity/upgrade-home-ram.js          keep buying as money comes in
 *   run singularity/upgrade-home-ram.js --once   buy what's affordable now, then exit
 */
export async function main(ns) {
	let relaunchPending = false;
	await runUpgradeLoop(ns, {
		label: "home-ram",
		stages: loadConfig(ns).homeRamBuying,
		loopMs: CONFIG.loopMs,
		costOf: () => ns.singularity.getUpgradeHomeRamCost(),
		doUpgrade: () => ns.singularity.upgradeHomeRam(),
		describe: () => ns.format.ram(ns.getServerMaxRam("home")),
		onUpgrade: () => { relaunchPending = true; },
		afterPass: () => {
			if (relaunchPending && ns.exec(RELAUNCH, "home") !== 0) relaunchPending = false;
		},
	});
}
