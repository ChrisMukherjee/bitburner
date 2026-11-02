import { loadConfig } from "/utils/config.js";
import { wantedBoosts } from "/utils/aug-filter.js";
// Port faction-work.js reads the goals from (20 darknet, 21 stock influence, 22 batcher income).
export const GOALS_PORT = 23;
const NEUROFLUX = "NeuroFlux Governor";

// "Worth it" is the shared rule in utils/aug-filter.js (same as buy-augs.js and
// workers/city-plan.js), driven by `augments` in the config (config.js, data/config.json).

/**
 * Works out the real rep goal of each faction passed as an argument (in priority order):
 * the highest rep requirement among the augments still worth buying there, i.e. not owned
 * and not already bought (queued). getAugmentationRepReq includes the BitNode's rep-cost
 * multiplier. An augment sold by several of the factions counts only for the first joined
 * one in the list (or the first one, if none is joined), as before.
 *
 * Started by singularity/faction-work.js; writes
 *   { time, goals: { faction: { rep, aug, count } } }
 * to port 23 and exits. About 22GB, but only for a moment.
 */
/** @param {NS} ns */
export async function main(ns) {
	const factions = ns.args.map(String);
	const augConfig = loadConfig(ns).augments;
	const joined = new Set(ns.getPlayer().factions);
	const owned = new Set(ns.singularity.getOwnedAugmentations(true)); // true: bought-but-not-installed count too
	const order = [...factions.filter((faction) => joined.has(faction)), ...factions.filter((faction) => !joined.has(faction))];

	const goals = Object.fromEntries(factions.map((faction) => [faction, { rep: 0, aug: "", count: 0 }]));
	const claimed = new Set();
	for (const faction of order) {
		for (const aug of ns.singularity.getAugmentationsFromFaction(faction)) {
			if (aug === NEUROFLUX || owned.has(aug) || claimed.has(aug) || !wantedBoosts(aug, ns.singularity.getAugmentationStats(aug), augConfig)) continue;
			claimed.add(aug);
			const goal = goals[faction];
			const rep = ns.singularity.getAugmentationRepReq(aug);
			goal.count++;
			if (rep > goal.rep) Object.assign(goal, { rep, aug });
		}
	}

	ns.clearPort(GOALS_PORT);
	ns.writePort(GOALS_PORT, JSON.stringify({ time: Date.now(), goals }));
}
