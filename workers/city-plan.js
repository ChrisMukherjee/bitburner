// Same "worth it" rule as buy-augs.js and workers/faction-goals.js, from the config.
import { loadConfig } from "/utils/config.js";
import { wantedBoosts } from "/utils/aug-filter.js";

// Port singularity/player-work.js reads the plan from (20 darknet, 21 stock influence,
// 22 hacked total, 23 faction goals, 24 income rate).
const PLAN_PORT = 25;
const NEUROFLUX = "NeuroFlux Governor";

/**
 * Works out which city factions still sell something worth having. Started by
 * singularity/player-work.js with one JSON argument: { groups, otherSources }.
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
	const augConfig = loadConfig(ns).augments;
	const owned = new Set(ns.singularity.getOwnedAugmentations(true)); // true: bought-but-not-installed too
	const elsewhere = new Set(otherSources.flatMap((faction) => ns.singularity.getAugmentationsFromFaction(faction)));

	const plan = groups.map((factions) => {
		const claimed = new Set();
		const needs = {};
		for (const faction of factions) {
			needs[faction] = ns.singularity.getAugmentationsFromFaction(faction).filter((aug) =>
				aug !== NEUROFLUX && !owned.has(aug) && !elsewhere.has(aug) && !claimed.has(aug) && wantedBoosts(aug, ns.singularity.getAugmentationStats(aug), augConfig));
			needs[faction].forEach((aug) => claimed.add(aug));
		}
		return { factions, needs };
	});

	ns.clearPort(PLAN_PORT);
	ns.writePort(PLAN_PORT, JSON.stringify({ time: Date.now(), groups: plan }));
}
