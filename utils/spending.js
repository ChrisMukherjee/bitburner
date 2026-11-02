import { readIncomeRate } from "/utils/income.js";

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

/**
 * Stage-based policy: strict rules hurt right after a prestige (cash is tiny, so a big
 * reserve blocks everything) and matter less once the batcher prints money. Each manager
 * has its own stages (hacknet, servers and stocks in config.js; home upgrades in their own CONFIG), ordered by minIncome ($/s, from utils/income.js: the
 * batcher's measured income, or running scripts' income when the batcher isn't running).
 *
 *   stages: [{ name, minIncome, reserve, maxFraction, ...anything else the manager needs }]
 *
 * The first stage must have minIncome 0. The returned function gives the current stage,
 * and it only ever moves UP during a run, so a short dip in batcher income (a batch
 * restart, say) cannot make spending loose again. Restarting the script resets it,
 * which is what you want after a prestige.
 */
export function createPolicyTracker(stages) {
	const ordered = stages.every((stage, index) =>
		index === 0 ? stage.minIncome === 0 : stage.minIncome > stages[index - 1].minIncome
	);
	if (!ordered) throw new Error("Stages must start at minIncome 0 and be sorted ascending.");
	stages.forEach(assertValidPolicy);

	let stageIndex = 0;
	return function getPolicy(ns) {
		const income = readIncomeRate(ns).perSecond;
		while (stageIndex + 1 < stages.length && income >= stages[stageIndex + 1].minIncome) {
			stageIndex++;
		}
		return stages[stageIndex];
	};
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