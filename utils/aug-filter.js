// Design: docs/config.md
import { STAT_GROUPS, LOWER_IS_BETTER } from "/config.js";

/**
 * What an augment does that this player wants, as text ("hack +10%, grow +5%"), or "" when it
 * isn't worth buying. The one "worth it" rule shared by buy-augs.js, singularity/workers/faction-goals.js
 * and singularity/workers/city-plan.js, driven by the `augments` section of the config (config.js). 0GB:
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

/**
 * What an augment is worth for the reset rule (buy-augs.js decideReset): the weighted sum of
 * ln(multiplier) over the stats in augConfig.wantStats, so e^value is roughly how much faster
 * it makes a run. Weights are augConfig.resetRule.weights (per stat, else defaultWeight);
 * augments without useful stats get resetRule.specialValue[name], or 0. Never negative. 0GB.
 */
export function augValue(augName, stats, augConfig) {
	const rule = augConfig.resetRule;
	if (augConfig.never.includes(augName)) return 0;
	if (rule.specialValue && augName in rule.specialValue) return rule.specialValue[augName];
	let value = 0;
	for (const group of augConfig.wantStats) {
		for (const key of Object.keys(STAT_GROUPS[group] ?? {})) {
			const multiplier = stats[key];
			if (multiplier === undefined || multiplier <= 0) continue;
			const weight = rule.weights[key] ?? rule.defaultWeight;
			value += weight * (LOWER_IS_BETTER.includes(key) ? -Math.log(multiplier) : Math.log(multiplier));
		}
	}
	return Math.max(0, value);
}
