// Design: docs/grafting.md
// @ts-check

/**
 * Pure decisions for grafting (singularity/player-work.js asks, singularity/workers/graft-scan.js supplies the numbers).
 * Grafting costs 3x the augmentation's price up front (not refunded if cancelled), takes the player's time for 30 minutes to a
 * couple of hours in New Tokyo, and the augmentation works at once (no install, no rep, no faction). So it is worth it for what
 * the factions will not give soon, or when the player has nothing better to do. Each finished graft also adds an Entropy stack
 * (every multiplier x0.98, kept across installs), so what a graft is worth is its value less that loss (`entropyCost`).
 */

/**
 * A candidate's value net of the Entropy stack it adds (`entropyCost`, 0 when the Congruity Implant protects the player or the
 * entropy rule is off). Pure.
 * @param {{ value: number, entropyCost?: number }} item
 */
export function graftNetValue(item) {
	return item.value - (item.entropyCost ?? 0);
}

/**
 * What a graft may cost now: the cash beyond what this reset's planned purchases need (times `safety`, since prices rise as
 * they are bought), and at most `maxFraction` of the cash. Never negative.
 * @param {number} cash
 * @param {number} plannedCost
 * @param {{ maxFraction?: number, safety?: number }} rule
 */
export function graftBudget(cash, plannedCost, rule) {
	const beyondPlan = cash - (plannedCost || 0) * (rule.safety ?? 1.25);
	return Math.max(0, Math.min(cash * (rule.maxFraction ?? 0.5), beyondPlan));
}

/**
 * The augmentation to graft now, or null. Candidates are the wanted ones (value from the reset rule, scan worker):
 *   { name, cost, hours, value, reachable, entropyCost? }   reachable: a joined faction sells it, so rep work gets it for a lot less money.
 * Only those within the budget, with the value net of Entropy (graftNetValue) at least `rule.minValue` (and above 0), and not tried recently (`tried`). While the player has
 * other work (`idle` false) only the ones no joined faction sells are taken: the rest come from faction rep, and the work
 * stays. Best value per hour of the player's time first, the cheaper first on a tie.
 * @param {{ candidates: { name: string, cost: number, hours: number, value: number, reachable: boolean, entropyCost?: number }[], cash: number, plannedCost?: number,
 *   idle: boolean, rule: { maxFraction?: number, safety?: number, minValue?: number }, tried?: Set<string> }} view
 */
export function pickGraft(view) {
	const budget = graftBudget(view.cash, view.plannedCost ?? 0, view.rule);
	const eligible = view.candidates.filter((item) =>
		item.cost <= budget && graftNetValue(item) > 0 && graftNetValue(item) >= (view.rule.minValue ?? 0) && !view.tried?.has(item.name) && (view.idle || !item.reachable));
	eligible.sort((first, second) => graftNetValue(second) / Math.max(second.hours, 0.01) - graftNetValue(first) / Math.max(first.hours, 0.01) || first.cost - second.cost);
	return eligible[0] ?? null;
}
