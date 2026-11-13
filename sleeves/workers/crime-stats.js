// Design: docs/sleeves.md
// @ts-check
// Port sleeves/plan.js reads the crime stats from (CRIME_STATS_PORT; not imported so the worker stays small).
const CRIME_STATS_PORT = 43;

/**
 * One-shot for sleeves/sleeve-manager.js: reads the game's own numbers for every crime (difficulty, time, money and the
 * weights of each skill in the success chance) so the manager can work out each sleeve's chance and money per second with the
 * game's formula. Needs the Singularity API (5GB a call, times its RAM multiplier outside BitNode 4), so the manager only
 * starts it where that is 4x or less. Posts { time, crimes: { name: { difficulty, time, money, karma, weights } } } on port 43.
 */
/** @param {NS} ns */
export async function main(ns) {
	/** @type {Record<string, any>} */
	const crimes = {};
	for (const name of Object.values(ns.enums.CrimeType)) {
		const stats = ns.singularity.getCrimeStats(name);
		crimes[name] = {
			difficulty: stats.difficulty, time: stats.time, money: stats.money, karma: stats.karma,
			weights: {
				hacking: stats.hacking_success_weight, strength: stats.strength_success_weight, defense: stats.defense_success_weight,
				dexterity: stats.dexterity_success_weight, agility: stats.agility_success_weight, charisma: stats.charisma_success_weight,
			},
		};
	}
	ns.clearPort(CRIME_STATS_PORT);
	ns.writePort(CRIME_STATS_PORT, JSON.stringify({ time: Date.now(), crimes }));
}
