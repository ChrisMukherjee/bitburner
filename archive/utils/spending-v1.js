/**
 * Shared spending policy for the hacknet and pserv managers.
 *
 * Each manager passes its own policy: { reserve, maxFraction }.
 *   reserve      - cash that must always be left untouched
 *   maxFraction  - largest share of current cash one decision may spend (0 < x <= 1)
 *
 * Both managers read live cash every time, so when one spends, the other's
 * budget shrinks automatically; that is the coordination between them.
 */

/** Cash on hand. */
export function getCash(ns) {
	return ns.getPlayer().money;
}

/**
 * What a manager may spend right now:
 * the smaller of (maxFraction * cash) and (cash - reserve), never negative.
 */
export function getBudget(ns, policy) {
	assertValidPolicy(policy);
	const cash = getCash(ns);
	const aboveReserve = cash - policy.reserve;
	return Math.max(0, Math.min(cash * policy.maxFraction, aboveReserve));
}

/** Money as "$1.234m" using the v3 formatter. */
export function formatMoney(ns, amount) {
	return "$" + ns.format.number(amount);
}

function assertValidPolicy(policy) {
	const validReserve = Number.isFinite(policy.reserve) && policy.reserve >= 0;
	const validFraction = policy.maxFraction > 0 && policy.maxFraction <= 1;
	if (!validReserve || !validFraction) {
		throw new Error(
			`Bad spending policy: reserve=${policy.reserve}, maxFraction=${policy.maxFraction}`
		);
	}
}