// Design: docs/player-work.md
import { loadConfig } from "/utils/config.js";
import { wantedBoosts, augValue } from "/utils/aug-filter.js";
import { readIncomeRate } from "/utils/income.js";
// Port player-work.js reads the goals from (20 darknet, 21 stock influence, 22 batcher income).
export const GOALS_PORT = 23;
const STOCK_SUMMARY_PORT = 26; // stock-trader.js posts the value of its positions here
const NEUROFLUX = "NeuroFlux Governor";
const PRICE_MULT = 1.9;        // every purchase multiplies the price of the rest

// "Worth it" is the shared rule in utils/aug-filter.js (same as buy-augs.js and
// singularity/workers/city-plan.js), driven by `augments` in the config (config.js, data/config.json).

/**
 * Works out the rep goal of each faction, counting only the augments this run can actually
 * get: the ones worth buying (not owned, not queued) that fit
 *   - the money: cash + stocks + income x resetRule.horizonHours, with the 1.9x markup of
 *     buying them most expensive first, as buy-augs.js does; and
 *   - the time: the rep still missing, faction by faction (player-work works one at a time),
 *     at the measured rep rate, within the same horizon. Skipped while no rate is measured.
 * Augments are taken best value per dollar first (augValue, the reset rule's value), each
 * with the prerequisites it still needs. resetRule.keyAugs (The Red Pill) always count, so
 * Daedalus keeps its goal for the Daedalus favor rule. A faction's goal is the highest rep
 * among its picked augments; the rest wait until income or rep rate catches up (refreshed
 * every 10 minutes). An augment sold by several factions counts for the first joined one.
 *
 * Started by singularity/player-work.js with one JSON argument:
 *   { factions: [...in priority order], rates: { faction: rep/s }, ratesTime }
 * (rates from data/aug-plan.json; ignored if from before the last reset). Writes
 *   { time, budget, horizonHours, timeChecked, goals: { faction: { rep, aug, count, skipped } } }
 * to port 23 and exits. count = augments picked there, skipped = wanted but out of reach this run.
 */
/** @param {NS} ns */
export async function main(ns) {
	const { factions, rates = {}, ratesTime = 0 } = JSON.parse(String(ns.args[0]));
	const augConfig = loadConfig(ns).augments;
	const rule = augConfig.resetRule;
	const horizonS = rule.horizonHours * 3600;
	const joined = new Set(ns.getPlayer().factions);
	const owned = new Set(ns.singularity.getOwnedAugmentations(true)); // true: bought-but-not-installed count too
	const order = [...factions.filter((faction) => joined.has(faction)), ...factions.filter((faction) => !joined.has(faction))];

	// Who sells what (first in order), and the wanted augments with their numbers.
	const sellerOf = new Map();
	const wanted = [];
	for (const faction of order) {
		for (const aug of ns.singularity.getAugmentationsFromFaction(faction)) {
			if (aug === NEUROFLUX || owned.has(aug) || sellerOf.has(aug)) continue;
			sellerOf.set(aug, faction);
			const stats = ns.singularity.getAugmentationStats(aug);
			if (wantedBoosts(aug, stats, augConfig)) wanted.push(aug);
		}
	}
	const info = new Map();
	const describe = (aug) => {
		if (!info.has(aug)) {
			info.set(aug, {
				aug, faction: sellerOf.get(aug), price: ns.singularity.getAugmentationPrice(aug),
				rep: ns.singularity.getAugmentationRepReq(aug), value: augValue(aug, ns.singularity.getAugmentationStats(aug), augConfig),
			});
		}
		return info.get(aug);
	};
	const rep = Object.fromEntries(order.map((faction) => [faction, joined.has(faction) ? ns.singularity.getFactionRep(faction) : 0]));

	// The augment plus every prerequisite it still needs, or null if one isn't sold by these factions.
	const withPrereqs = (aug, seen = new Set()) => {
		if (seen.has(aug)) return [];
		seen.add(aug);
		const bundle = [aug];
		for (const prereq of ns.singularity.getAugmentationPrereq(aug)) {
			if (owned.has(prereq)) continue;
			if (!sellerOf.has(prereq)) return null;
			const more = withPrereqs(prereq, seen);
			if (!more) return null;
			bundle.push(...more);
		}
		return bundle;
	};

	// Budget: money by the end of the horizon, and work time at the measured rep rate.
	const income = Math.max(0, readIncomeRate(ns).perSecond);
	const budget = ns.getServerMoneyAvailable("home") + stockValue(ns) + income * horizonS;
	const fresh = ratesTime >= ns.getResetInfo().lastAugReset;
	const measured = fresh ? Object.values(rates).filter((rate) => rate > 0) : [];
	// Factions not worked yet: assume the best rate seen (favor differences are ignored).
	const fallbackRate = measured.length > 0 ? Math.max(...measured) : 0;
	const rateOf = (faction) => (fresh && rates[faction] > 0 ? rates[faction] : fallbackRate);
	const timeChecked = fallbackRate > 0;

	const moneyFor = (augs) => [...augs].map((aug) => info.get(aug).price).sort((first, second) => second - first)
		.reduce((sum, price, index) => sum + price * Math.pow(PRICE_MULT, index), 0);
	const secondsFor = (augs) => {
		const top = new Map();
		for (const aug of augs) {
			const { faction, rep: needed } = info.get(aug);
			top.set(faction, Math.max(top.get(faction) ?? 0, needed));
		}
		let seconds = 0;
		for (const [faction, needed] of top) seconds += Math.max(0, needed - rep[faction]) / rateOf(faction);
		return seconds;
	};

	// Key augments (The Red Pill) always count, outside both budgets.
	const forced = new Set(wanted.filter((aug) => rule.keyAugs.includes(aug)));
	forced.forEach(describe);
	const picked = new Set();
	const candidates = wanted.filter((aug) => !forced.has(aug)).map(describe)
		.sort((first, second) => second.value / Math.max(1, second.price) - first.value / Math.max(1, first.price));
	for (const candidate of candidates) {
		if (picked.has(candidate.aug)) continue;
		const bundle = withPrereqs(candidate.aug);
		if (!bundle) continue;
		bundle.forEach(describe);
		const trial = new Set([...picked, ...bundle]);
		if (moneyFor(trial) > budget) continue;
		if (timeChecked && secondsFor(trial) > horizonS) continue;
		bundle.forEach((aug) => picked.add(aug));
	}

	const goals = Object.fromEntries(factions.map((faction) => [faction, { rep: 0, aug: "", count: 0, skipped: 0 }]));
	for (const aug of [...picked, ...forced]) {
		const { faction, rep: needed } = info.get(aug);
		const goal = goals[faction];
		goal.count++;
		if (needed > goal.rep) Object.assign(goal, { rep: needed, aug });
	}
	for (const aug of wanted) if (!picked.has(aug) && !forced.has(aug)) goals[sellerOf.get(aug)].skipped++;

	ns.clearPort(GOALS_PORT);
	ns.writePort(GOALS_PORT, JSON.stringify({ time: Date.now(), budget, horizonHours: rule.horizonHours, timeChecked, goals }));
}

/** What stock-trader.js last said its positions are worth (0 if it isn't running). */
function stockValue(ns) {
	try {
		const summary = JSON.parse(ns.peek(STOCK_SUMMARY_PORT));
		return Date.now() - summary.time < 5 * 60_000 && summary.value > 0 ? summary.value : 0;
	} catch {
		return 0;
	}
}
