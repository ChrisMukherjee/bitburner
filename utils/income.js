/**
 * Real money income, shared between scripts.
 *
 * ns.getTotalScriptIncome() only counts scripts that are still running, and the batcher's hack
 * workers exit the moment they pay out, so it reads close to $0/s even while the batcher earns
 * tens of millions per second. Instead batcher.js posts its own measured rate (from the running
 * total that hack/workers/hack.js keeps on port 22) on INCOME_RATE_PORT every log interval, and other
 * scripts read it here. Port calls cost 0GB.
 *
 * If the batcher isn't running (or hasn't posted for maxAgeMs), this falls back to
 * getTotalScriptIncome, which is right for long-running hack scripts like the early-game ones.
 */
export const INCOME_RATE_PORT = 24;

/** Called by batcher.js: post the measured hacking income ($/s, averaged over windowMs). */
export function postIncomeRate(ns, perSecond, windowMs) {
	ns.clearPort(INCOME_RATE_PORT);
	ns.writePort(INCOME_RATE_PORT, { perSecond, windowMs, time: Date.now() });
}

/**
 * Money income in $/s: { perSecond, source } where source is "batcher" or "running scripts".
 * Takes the larger of the batcher's posted rate and getTotalScriptIncome, so long-running
 * hack scripts still count when the batcher earns little.
 */
export function readIncomeRate(ns, maxAgeMs = 120000) {
	const fromScripts = ns.getTotalScriptIncome()[0];
	const posted = ns.peek(INCOME_RATE_PORT); // "NULL PORT DATA" when nothing was posted
	const fresh = posted && typeof posted === "object" && Number.isFinite(posted.perSecond) &&
		Date.now() - posted.time <= maxAgeMs;
	if (fresh && posted.perSecond >= fromScripts) return { perSecond: posted.perSecond, source: "batcher" };
	return { perSecond: fromScripts, source: "running scripts" };
}
