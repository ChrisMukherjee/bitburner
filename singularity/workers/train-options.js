// Design: docs/combat-training.md
// @ts-check
import { COMBAT_CRIMES } from "/utils/training.js";

// Port player-work.js reads this from (not imported from there, so this worker's Singularity calls stay out of its RAM).
const TRAIN_PORT = 47;

/**
 * One-shot for singularity/player-work.js while a combat stat is being trained: the success chance of every crime that gives
 * combat exp, and the hash upgrade's gym training multiplier (1 without hacknet servers), so player-work can compare the gym,
 * the crimes and Bladeburner's Training (utils/training.js). Posts { time, chances: { crime: chance }, gymMult } on port 47.
 *   run /singularity/workers/train-options.js
 */
/** @param {NS} ns */
export async function main(ns) {
	/** @type {Record<string, number>} */
	const chances = {};
	for (const [name] of COMBAT_CRIMES) chances[name] = ns.singularity.getCrimeChance(/** @type {any} */ (name));
	let gymMult = 1;
	try {
		gymMult = ns.hacknet.getTrainingMult();
	} catch {
		// no hacknet servers: the gym gets no hash bonus
	}
	ns.clearPort(TRAIN_PORT);
	ns.writePort(TRAIN_PORT, JSON.stringify({ time: Date.now(), chances, gymMult }));
}
