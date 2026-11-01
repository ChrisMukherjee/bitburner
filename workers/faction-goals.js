// Port faction-work.js reads the goals from (20 darknet, 21 stock influence, 22 batcher income).
export const GOALS_PORT = 23;
const NEUROFLUX = "NeuroFlux Governor";

// Same "worth it" filter as singularity/buy-augs.js (keep the two in step): an augment is
// worth buying if it boosts one of these stats, lowers a hacknet cost, or is in SPECIAL.
const HACKING_STATS = ["hacking", "hacking_exp", "hacking_chance", "hacking_speed", "hacking_money",
	"hacking_grow", "faction_rep", "company_rep", "hacknet_node_money", "dnet_money"];
const COST_STATS = ["hacknet_node_purchase_cost", "hacknet_node_ram_cost", "hacknet_node_core_cost", "hacknet_node_level_cost"];
const SPECIAL = ["The Red Pill", "Neuroreceptor Manager", "CashRoot Starter Kit"];

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
	const joined = new Set(ns.getPlayer().factions);
	const owned = new Set(ns.singularity.getOwnedAugmentations(true)); // true: bought-but-not-installed count too
	const order = [...factions.filter((faction) => joined.has(faction)), ...factions.filter((faction) => !joined.has(faction))];

	const goals = Object.fromEntries(factions.map((faction) => [faction, { rep: 0, aug: "", count: 0 }]));
	const claimed = new Set();
	for (const faction of order) {
		for (const aug of ns.singularity.getAugmentationsFromFaction(faction)) {
			if (aug === NEUROFLUX || owned.has(aug) || claimed.has(aug) || !worthIt(ns, aug)) continue;
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

// Also imported by workers/city-plan.js, so city-factions.js uses the same filter.
export function worthIt(ns, aug) {
	if (SPECIAL.includes(aug)) return true;
	const stats = ns.singularity.getAugmentationStats(aug);
	return HACKING_STATS.some((key) => stats[key] > 1) || COST_STATS.some((key) => stats[key] < 1);
}
