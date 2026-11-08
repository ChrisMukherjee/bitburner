// @ts-check
import { runUpgradeLoop } from "/singularity/home-upgrade-loop.js";
import { loadConfig } from "/utils/config.js";

const CONFIG = {
	loopMs: 30_000,
};

/**
 * Buys home CPU core upgrades (Singularity) while the cash left covers `homeUpgrades.cores.reserveSeconds` of income. Exits once home is maxed,
 * or once the next upgrade would pass `homeUpgrades.cores.max` (no cap when null).
 * startup.js runs it with --once whenever the cash it last asked for is there.
 *   run singularity/upgrade-home-cores.js          keep buying as money comes in
 *   run singularity/upgrade-home-cores.js --once   buy what's affordable now, then exit
 *   run singularity/upgrade-home-cores.js --once --spend-all   spend all the cash on it (before an install)
 */
export async function main(ns) {
	const settings = loadConfig(ns).homeUpgrades.cores;
	// getServer costs 2GB; it is the only way to read the core count, needed for the cap and the log.
	const cores = () => ns.getServer("home").cpuCores;
	await runUpgradeLoop(ns, {
		label: "home-cores",
		...settings,
		loopMs: CONFIG.loopMs,
		costOf: () => ns.singularity.getUpgradeHomeCoresCost(),
		doUpgrade: () => ns.singularity.upgradeHomeCores(),
		describe: () => `${cores()} core${cores() === 1 ? "" : "s"}`,
		cap: settings.max == null ? null
			: { overNext: () => cores() + 1 > settings.max, text: `${settings.max} core${settings.max === 1 ? "" : "s"}` },
		gate: "home-cores",
	});
}
