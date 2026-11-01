// Same "worth it" filter as faction-work.js and buy-augs.js (via workers/faction-goals.js).
import { worthIt } from "/workers/faction-goals.js";

// Port singularity/city-factions.js reads the plan from (20 darknet, 21 stock influence,
// 22 hacked total, 23 faction goals, 24 income rate).
const PLAN_PORT = 25;
const NEUROFLUX = "NeuroFlux Governor";

/**
 * Works out which city factions still sell something worth having. Started by
 * singularity/city-factions.js with one JSON argument: { groups, otherSources }.
 *
 * An augment counts as "needed" from a city faction when it is worth it, not owned and not
 * already bought (queued), and not sold by any faction in otherSources (the non-city
 * factions the scripts reach anyway, e.g. DataJack also comes from NiteSec). Inside a group,
 * an augment sold by two cities counts for the first one only.
 *
 * Writes { time, groups: [{ factions, needs: { faction: [augs] } }] } to port 25 and exits.
 * About 17GB, but only for a moment.
 */
/** @param {NS} ns */
export async function main(ns) {
	const { groups, otherSources } = JSON.parse(String(ns.args[0]));
	const owned = new Set(ns.singularity.getOwnedAugmentations(true)); // true: bought-but-not-installed too
	const elsewhere = new Set(otherSources.flatMap((faction) => ns.singularity.getAugmentationsFromFaction(faction)));

	const plan = groups.map((factions) => {
		const claimed = new Set();
		const needs = {};
		for (const faction of factions) {
			needs[faction] = ns.singularity.getAugmentationsFromFaction(faction).filter((aug) =>
				aug !== NEUROFLUX && !owned.has(aug) && !elsewhere.has(aug) && !claimed.has(aug) && worthIt(ns, aug));
			needs[faction].forEach((aug) => claimed.add(aug));
		}
		return { factions, needs };
	});

	ns.clearPort(PLAN_PORT);
	ns.writePort(PLAN_PORT, JSON.stringify({ time: Date.now(), groups: plan }));
}
