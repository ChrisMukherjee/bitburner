// Design: docs/player-work.md
import { loadConfig } from "/utils/config.js";
import { notify } from "/utils/notify.js";

// Base time (ms) and money of every crime (v3.0.0 src/Crime/Crimes.ts). The BitNode's crime money
// multiplier scales them all alike, so it doesn't change which one is best. Hardcoded because
// getCrimeStats would cost another 5GB; only the chance (which grows with the stats) is asked of the game.
const CRIMES = [
	["Shoplift", 2e3, 15e3],
	["Rob Store", 60e3, 400e3],
	["Mug", 4e3, 36e3],
	["Larceny", 90e3, 800e3],
	["Deal Drugs", 10e3, 120e3],
	["Bond Forgery", 300e3, 4.5e6],
	["Traffick Arms", 40e3, 600e3],
	["Homicide", 3e3, 45e3],
	["Grand Theft Auto", 80e3, 1.6e6],
	["Kidnap", 120e3, 3.6e6],
	["Assassination", 300e3, 12e6],
	["Heist", 600e3, 120e6],
];

/**
 * The start stage's stand-in for player-work.js, which needs 32.5GB and so can't run on a home below
 * 64GB (a fresh BitNode) or on any server that small. One short pass, run by startup.js every minute
 * until the early stage, when player-work.js takes over:
 *   1. below studying.hackLevel (and in studying.city): the free course from the `studying` config;
 *   2. then the crime that earns the most per second at your current chance, for cash towards home RAM
 *      and the port openers (the batcher earns little on a small network).
 * Leaves alone any other work (faction, company, ...), whoever started it. A class keeps running only
 * below the study target; past it, crime takes over. Focused unless `playerFocus` is false in the config.
 * About 14.6GB (normal Singularity cost), for a moment; it can run on a 16GB server.
 *   run /singularity/player-work-start.js
 */
/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	const { studying, playerFocus } = loadConfig(ns);
	const focus = playerFocus !== false;
	const player = ns.getPlayer();
	const current = ns.singularity.getCurrentWork();
	const hacking = player.skills.hacking;

	if (current && current.type !== "CLASS" && current.type !== "CRIME") {
		ns.print(`[start-work] ${current.type} work is running; leaving it alone`);
		return;
	}
	if (hacking < studying.hackLevel) {
		if (current?.type === "CLASS") {
			ns.print(`[start-work] studying, hacking ${hacking} < ${studying.hackLevel}`);
			return;
		}
		if (player.city === studying.city && ns.singularity.universityCourse(studying.university, studying.course, focus)) {
			notify(ns, "[start-work]", `studying ${studying.course} until hacking ${studying.hackLevel}`, "info");
			return;
		}
		ns.print(`[start-work] can't study here (in ${player.city}, not ${studying.city}); crime instead`);
	}

	const [crime, , , rate] = CRIMES
		.map(([name, time, money]) => [name, time, money, ns.singularity.getCrimeChance(name) * money / time])
		.sort((first, second) => second[3] - first[3])[0];
	const perSecond = `$${ns.format.number(1000 * rate)}/s before BitNode multipliers`;
	if (current?.type === "CRIME" && current.crimeType === crime) {
		ns.print(`[start-work] ${crime} (${perSecond})`);
		return;
	}
	ns.singularity.commitCrime(crime, focus);
	if (current?.type === "CRIME") ns.print(`[start-work] switched to ${crime} (${perSecond})`);
	else notify(ns, "[start-work]", `${crime} for cash (${perSecond}) until home reaches the early stage`, "info");
}
