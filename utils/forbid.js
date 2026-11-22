// Design: docs/challenges.md
// @ts-check

/**
 * Mechanics a challenge can forbid (config `forbid`, set by CHALLENGES in config.js): "bladeburner" (BN6 and BN7 challenges: don't
 * join the division) and "gang" (BN2 challenge: don't form a gang). The capability helpers (utils/bladeburner.js, utils/gang.js)
 * report a forbidden mechanic as not available, so every manager, ready check and planner that asks them stands down by itself.
 * Pure, 0GB, no imports (workers copy it alone).
 */
export const FORBIDDABLE = ["bladeburner", "gang"];

/**
 * True when the config forbids the mechanic. Accepts the whole config, or just a list of names.
 * @param {{ forbid?: string[] | string } | string[] | string | null | undefined} config
 * @param {string} feature
 */
export function forbids(config, feature) {
	const list = Array.isArray(config) || typeof config === "string" ? config : config?.forbid;
	return [list ?? []].flat().includes(feature);
}

/** The line scripts print when a forbidden mechanic is skipped. @param {string} feature */
export function forbiddenWhy(feature) {
	return `a challenge is on that forbids it (${feature}; \`run /tools/set-config.js challenge\` lists them, \`challenge clear\` ends it)`;
}
