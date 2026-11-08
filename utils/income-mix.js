// Design: docs/aug-reset.md
// @ts-check
/**
 * Where this run's money comes from, for the augment weights (see "Income mix" in docs/aug-reset.md).
 * postIncomeMix reads the game's money-by-source totals (1GB) and posts the positive ones on port 38;
 * utils/config.js reads that port (0GB) and scales each money stat's weight by its source's portion.
 * Only buy-augs.js imports this file, so the 1GB isn't charged to every script that loads the config.
 *   { time, sinceInstall: { hacking: 1.2e9, gang: 4e9, ... }, sinceStart: { ... } }
 */
export const INCOME_MIX_PORT = 38;

/** @param {NS} ns */
export function postIncomeMix(ns) {
	const sources = ns.getMoneySources();
	const post = { time: Date.now(), sinceInstall: earnings(sources.sinceInstall), sinceStart: earnings(sources.sinceStart) };
	ns.clearPort(INCOME_MIX_PORT);
	ns.writePort(INCOME_MIX_PORT, JSON.stringify(post));
	return post;
}

/** The sources that earned money (expenses and "total" left out). */
function earnings(source) {
	const out = {};
	for (const [key, amount] of Object.entries(source ?? {})) if (key !== "total" && amount > 0) out[key] = amount;
	return out;
}
