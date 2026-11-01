import { runUpgradeLoop } from "/singularity/home-upgrade-loop.js";

const CONFIG = {
	// Home RAM is the best early buy (it is what every other manager runs on), so these
	// stages spend more freely than pserv-manager's. Same rules: a stage applies once
	// script income reaches minIncome ($/s) and never loosens until you restart.
	stages: [
		{ name: "early", minIncome: 0, reserve: 200e3, maxFraction: 0.90 },
		{ name: "growing", minIncome: 1e5, reserve: 10e6, maxFraction: 0.75 },
		{ name: "established", minIncome: 1e7, reserve: 100e6, maxFraction: 0.60 },
		{ name: "late", minIncome: 1e8, reserve: 1e9, maxFraction: 0.50 },
	],
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
		stages: CONFIG.stages,
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
