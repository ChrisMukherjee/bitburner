// Design: docs/sleeves.md
// @ts-check
import { loadConfig } from "/utils/config.js";
import { augValue } from "/utils/aug-filter.js";
// Port sleeves/sleeve-shop.js reads the values from (AUG_VALUE_PORT in sleeves/plan.js).
const AUG_VALUE_PORT = 42;

/**
 * One-shot for sleeves/sleeve-shop.js: what each sleeve augmentation is worth, by the stats the config says matter for sleeves
 * (`sleeves.augments.wantStats`, shared rule: utils/aug-filter.js augValue; 0 = not worth buying). Needs the Singularity API (5GB
 * a call, times its RAM multiplier), so the shop only starts it where that is 4x or less; without it the shop buys the cheapest first.
 * Posts { time, values: { name: value } } on port 42, keeping what earlier runs posted.
 *   args: JSON ["augmentation name", ...]
 */
/** @param {NS} ns */
export async function main(ns) {
	const names = JSON.parse(String(ns.args[0]));
	const rule = loadConfig(ns).sleeves.augments;
	const augConfig = { never: rule.never, special: {}, wantStats: rule.wantStats, resetRule: { weights: {}, defaultWeight: 1, specialValue: {} }, incomeFactors: {} };
	let values = {};
	try {
		values = JSON.parse(ns.peek(AUG_VALUE_PORT)).values ?? {};
	} catch { /* none yet */ }
	for (const name of names) values[name] = augValue(name, ns.singularity.getAugmentationStats(name), augConfig);
	ns.clearPort(AUG_VALUE_PORT);
	ns.writePort(AUG_VALUE_PORT, JSON.stringify({ time: Date.now(), values }));
}
