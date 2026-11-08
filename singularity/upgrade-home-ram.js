// @ts-check
import { runUpgradeLoop } from "/singularity/home-upgrade-loop.js";
import { loadConfig } from "/utils/config.js";

const CONFIG = {
	loopMs: 10_000,
};

/**
 * Buys home RAM upgrades (Singularity) while the cash left covers `homeUpgrades.ram.reserveSeconds` of income. Exits once home is maxed,
 * or once the next upgrade would pass `homeUpgrades.ram.maxGB` (no cap when null).
 * startup.js runs it with --once whenever the cash it last asked for is there.
 *   run singularity/upgrade-home-ram.js          keep buying as money comes in
 *   run singularity/upgrade-home-ram.js --once   buy what's affordable now, then exit
 *   run singularity/upgrade-home-ram.js --once --spend-all   spend all the cash on it (before an install)
 */
export async function main(ns) {
	const settings = loadConfig(ns).homeUpgrades.ram;
	await runUpgradeLoop(ns, {
		label: "home-ram",
		...settings,
		loopMs: CONFIG.loopMs,
		costOf: () => ns.singularity.getUpgradeHomeRamCost(),
		doUpgrade: () => ns.singularity.upgradeHomeRam(),
		describe: () => ns.format.ram(ns.getServerMaxRam("home")),
		// Each upgrade doubles home RAM.
		cap: settings.maxGB == null ? null
			: { overNext: () => ns.getServerMaxRam("home") * 2 > settings.maxGB, text: ns.format.ram(settings.maxGB) },
		gate: "home-ram",
	});
}
