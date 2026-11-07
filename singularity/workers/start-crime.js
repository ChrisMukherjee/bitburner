// Design: docs/player-work.md
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
 * Commits the crime that earns the most per second at your current chance, for player-work-start.js
 * (which hands over with ns.spawn so it needn't hold these 5GB calls itself). Args: focus, and optionally a
 * crime to commit instead (start-gang.js asks for Homicide, for the gang invite's karma).
 * 12.1GB, for a moment.
 *   run /singularity/workers/start-crime.js true
 */
/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	const focus = ns.args[0] !== false;
	const current = ns.singularity.getCurrentWork();
	const forced = CRIMES.some(([name]) => name === ns.args[1]) ? String(ns.args[1]) : null;
	const [crime, , , rate] = CRIMES
		.map(([name, time, money]) => [name, time, money, ns.singularity.getCrimeChance(name) * money / time])
		.filter(([name]) => !forced || name === forced)
		.sort((first, second) => second[3] - first[3])[0];
	const perSecond = forced ? "for the gang invite's karma" : `$${ns.format.number(1000 * rate)}/s before BitNode multipliers`;
	if (current?.type === "CRIME" && current.crimeType === crime) {
		ns.print(`[start-work] ${crime} (${perSecond})`);
		return;
	}
	ns.singularity.commitCrime(crime, focus);
	if (current?.type === "CRIME") ns.print(`[start-work] switched to ${crime} (${perSecond})`);
	else if (forced) notify(ns, "[start-work]", `${crime} ${perSecond}`, "info");
	else notify(ns, "[start-work]", `${crime} for cash (${perSecond}) until home reaches the early stage`, "info");
}
