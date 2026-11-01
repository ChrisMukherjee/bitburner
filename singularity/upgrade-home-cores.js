import { runUpgradeLoop } from "/singularity/home-upgrade-loop.js";

const CONFIG = {
	// Cores only speed up grow/weaken on home and cost a lot, so spend more carefully than
	// on RAM. Same rules as the other managers' stages.
	stages: [
		{ name: "early", minIncome: 0, reserve: 1e6, maxFraction: 0.50 },
		{ name: "growing", minIncome: 1e5, reserve: 30e6, maxFraction: 0.40 },
		{ name: "established", minIncome: 1e7, reserve: 300e6, maxFraction: 0.30 },
		{ name: "late", minIncome: 1e8, reserve: 1e9, maxFraction: 0.25 },
	],
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
		stages: CONFIG.stages,
		loopMs: CONFIG.loopMs,
		costOf: () => ns.singularity.getUpgradeHomeCoresCost(),
		doUpgrade: () => ns.singularity.upgradeHomeCores(),
	});
}
