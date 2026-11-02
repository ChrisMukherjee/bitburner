import { STAT_GROUPS, LOWER_IS_BETTER } from "/config.js";

/**
 * What an augment does that this player wants, as text ("hack +10%, grow +5%"), or "" when it
 * isn't worth buying. The one "worth it" rule shared by buy-augs.js, workers/faction-goals.js
 * and workers/city-plan.js, driven by the `augments` section of the config (config.js). 0GB:
 * the caller passes the stats from ns.singularity.getAugmentationStats.
 *   augName    - the augment's name
 *   stats      - its multipliers
 *   augConfig  - loadConfig(ns).augments
 */
export function wantedBoosts(augName, stats, augConfig) {
	if (augConfig.never.includes(augName)) return "";
	if (augConfig.special[augName]) return augConfig.special[augName];
	const parts = [];
	for (const group of augConfig.wantStats) {
		for (const [key, label] of Object.entries(STAT_GROUPS[group] ?? {})) {
			const value = stats[key];
			if (value === undefined) continue;
			if (LOWER_IS_BETTER.includes(key)) {
				if (value < 1) parts.push(`${label} -${Math.round((1 - value) * 100)}%`);
			} else if (value > 1) {
				parts.push(`${label} +${Math.round((value - 1) * 100)}%`);
			}
		}
	}
	return parts.join(", ");
}

/** Stat group names in augConfig.wantStats that STAT_GROUPS doesn't know (typos). */
export function unknownStatGroups(augConfig) {
	return augConfig.wantStats.filter((group) => !(group in STAT_GROUPS));
}
