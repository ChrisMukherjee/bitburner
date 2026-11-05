import { readIncomeRate } from "/utils/income.js";
import { loadConfig } from "/utils/config.js";
import { wantedBoosts, augValue } from "/utils/aug-filter.js";
import { homeUpgradeNeed } from "/singularity/ready.js";
import { recordIncomeSample, buildIncomeModel, earnedOver, timeToEarn, incomeMultAt } from "/utils/income-curve.js";
// Design: docs/aug-reset.md
const NEUROFLUX = "NeuroFlux Governor";
const RED_PILL = "The Red Pill";
const DAEDALUS = "Daedalus";
const DAEMON = "w0r1d_d43m0n"; // appears once The Red Pill is installed; destroying it ends the BitNode
const PLAN_FILE = "data/aug-plan.json";
const BUYER = "singularity/workers/aug-buyer.js"; // does the buying, so this script stays small
const STOCK_SUMMARY_PORT = 26;   // stock-trader.js posts the value of its positions here
const PRICE_MULT = 1.9;          // every purchase multiplies the price of the rest
const NEUROFLUX_LEVEL_MULT = 1.14; // each NeuroFlux level costs this much more money and rep
const DONATE_MONEY_PER_REP = 1e6;  // donations: $1m per rep point, before rep multipliers
// Moments ahead (minutes) the reset rule compares with resetting now, up to resetRule.horizonHours.
const FORECAST_MINUTES = [10, 20, 30, 45, 60, 90, 120, 180, 240, 300, 360, 480, 600, 720];

// Which augments are worth buying, and when to reset, come from the config (config.js,
// data/config.json): `augments.wantStats`, `augments.special`, `augments.never` and
// `augments.resetRule`. Set at the start of main.
let AUG_CONFIG = null;
let RESET_RULE = null;

/**
 * Buys the augments worth having (by default: ones that help hacking, hacknet, darknet or
 * rep gain, plus The Red Pill, Neuroreceptor Management Implant and CashRoot) that you have the rep
 * for, most expensive first (each purchase raises the price of the rest by 1.9x, so the
 * big ones go first), then spends what's left on NeuroFlux Governor levels. By default
 * combat, charisma, crime and Bladeburner augments are skipped, since they'd only make the
 * useful ones dearer; `augments.wantStats` in the config changes that (see config.js).
 * It doesn't install them: run install-augs.js for that.
 *
 * Prerequisites aren't looked up (getAugmentationPrereq would cost another 5GB). A
 * purchase that fails is retried after the next one succeeds, so e.g. Cranial Signal
 * Processors Gen II goes through once Gen I is bought.
 *
 * It only spends cash: money in stocks has to be sold first (auto-reset.js does that with
 * stock-trader.js --liquidate). It runs once and exits.
 *
 * Planning and buying are split so a 32GB home can do both: this script (about 30GB) plans,
 * writes data/aug-plan.json with the list to buy, and hands over to
 * singularity/workers/aug-buyer.js (about 9GB), which buys in the same order after this
 * script has exited (ns.spawn). auto-reset.js runs the buyer itself after --plan.
 *
 *   run singularity/buy-augs.js                  plan, then buy the useful ones you can afford
 *   run singularity/buy-augs.js --dry            list them with what each one boosts, the
 *                                                cost of the whole set and whether to reset
 *   run singularity/buy-augs.js --all            buy every augment, useful or not
 *   run singularity/buy-augs.js --no-neuroflux   skip NeuroFlux Governor
 *   run singularity/buy-augs.js --reserve 1e9    leave $1b untouched
 *   run singularity/buy-augs.js --plan           buy nothing; write what it could buy and
 *                                                whether to reset to data/aug-plan.json
 *                                                (used by auto-reset.js)
 *
 * --dry and --plan both end with the same reset decision (see decideReset), so what
 * `augs` tells you is exactly what auto-reset.js will do. Why the rule looks the way it does:
 * docs/aug-reset.md.
 */
export async function main(ns) {
	ns.disableLog("ALL");
	AUG_CONFIG = loadConfig(ns).augments;
	RESET_RULE = AUG_CONFIG.resetRule;
	const flags = ns.flags([["dry", false], ["all", false], ["no-neuroflux", false], ["reserve", 0], ["plan", false]]);
	const cash = () => ns.getServerMoneyAvailable("home") - flags.reserve;
	const money = (amount) => "$" + ns.format.number(amount);

	const player = ns.getPlayer();
	const factions = player.factions;
	const owned = new Set(ns.singularity.getOwnedAugmentations(true));
	const rep = new Map(factions.map((faction) => [faction, ns.singularity.getFactionRep(faction)]));

	// Augment -> a joined faction with enough rep to sell it; what it boosts; what it's worth.
	const sellers = new Map();
	const boosts = new Map();
	const values = new Map();
	const statsOf = new Map(); // multipliers, for the after-Red-Pill rule
	const skipped = [];
	const anySeller = new Map(); // every augment a joined faction has the rep for, useful or not (Daedalus push)
	const locked = []; // useful, but the faction rep isn't there yet
	for (const faction of factions) {
		for (const aug of ns.singularity.getAugmentationsFromFaction(faction)) {
			if (aug === NEUROFLUX || owned.has(aug) || sellers.has(aug)) continue;
			// Several factions can sell the same augment: read its stats once, but check the rep at each.
			if (!boosts.has(aug)) {
				const stats = ns.singularity.getAugmentationStats(aug);
				statsOf.set(aug, stats);
				boosts.set(aug, wantedBoosts(aug, stats, AUG_CONFIG));
				values.set(aug, augValue(aug, stats, AUG_CONFIG));
			}
			const summary = boosts.get(aug);
			const repNeeded = ns.singularity.getAugmentationRepReq(aug);
			if (rep.get(faction) < repNeeded) {
				if (summary) {
					locked.push({ aug, faction, repNeeded, missing: repNeeded - rep.get(faction), price: ns.singularity.getAugmentationPrice(aug), value: values.get(aug) });
				}
				continue;
			}
			if (!anySeller.has(aug)) anySeller.set(aug, faction);
			if (summary || flags.all) sellers.set(aug, faction);
			else if (!skipped.includes(aug)) skipped.push(aug);
		}
	}
	const byPrice = () => [...sellers.keys()]
		.map((aug) => ({ aug, price: ns.singularity.getAugmentationPrice(aug), value: values.get(aug) ?? 0 }))
		.sort((first, second) => second.price - first.price);
	const stocks = stockValue(ns);

	const installed = new Set(ns.singularity.getOwnedAugmentations(false));
	const queued = [...owned].filter((aug) => !installed.has(aug));
	const previous = readPlan(ns);
	const rates = repRates(ns, previous, rep);
	const plan = byPrice();
	const lastReset = ns.getResetInfo().lastAugReset;
	const sameRun = previous?.checkedAt >= lastReset;
	const income = readIncomeRate(ns).perSecond; // not getTotalScriptIncome: it misses batcher hacks
	// Income curve: this run's income history (and the last run's), and how fast it's growing.
	const sinceInstallMs = Date.now() - lastReset;
	const incomeHistory = recordIncomeSample(previous?.incomeHistory, lastReset, Date.now(), income, RESET_RULE.incomeCurve);
	const incomeModel = buildIncomeModel(incomeHistory, sinceInstallMs, RESET_RULE.incomeCurve);

	// Each locked augment once (the faction closest to unlocking it), minus ones another faction sells.
	const closest = new Map();
	for (const entry of locked) {
		if (sellers.has(entry.aug)) continue;
		const rate = rates.perSecond[entry.faction] ?? 0;
		const etaMs = rate > 0 ? (entry.missing / rate) * 1000 : null;
		const best = closest.get(entry.aug);
		if (!best || (etaMs ?? Infinity) < (best.etaMs ?? Infinity) || (best.etaMs === null && entry.missing < best.missing)) {
			closest.set(entry.aug, { ...entry, etaMs });
		}
	}
	const upcoming = [...closest.values()];
	const fitNow = whatFits(plan, cash() + stocks);

	// Daedalus push: when the invite only lacks installed augments, the cheapest ones, useful or not.
	const push = daedalusPush(ns, factions, installed, queued);
	if (push) {
		const pool = [...anySeller.keys()].map((aug) => ({ aug, price: ns.singularity.getAugmentationPrice(aug) }));
		push.fill = cheapestFill(pool, cash(), push.missing + (RESET_RULE.daedalusPushSpare ?? 0));
	}

	// NeuroFlux: bought from the joined faction with the most rep (its rep need climbs per level).
	const nfgFaction = factions.reduce((top, faction) => (rep.get(faction) > (rep.get(top) ?? -1) ? faction : top), null);
	const neuroflux = AUG_CONFIG.neuroflux && nfgFaction ? {
		price: ns.singularity.getAugmentationPrice(NEUROFLUX),
		repReq: ns.singularity.getAugmentationRepReq(NEUROFLUX),
		value: augValue(NEUROFLUX, ns.singularity.getAugmentationStats(NEUROFLUX), AUG_CONFIG),
		rep: rep.get(nfgFaction),
		rate: rates.perSecond[nfgFaction] ?? 0,
	} : null;

	// Favor: each faction still needed next run (it sells a wanted augment we won't have,
	// or it's Daedalus before The Red Pill), weighted by how much rep it will take there.
	const willOwn = new Set([...owned, ...fitNow.augs]);
	const repStillNeeded = new Map();
	const need = (faction, amount) => repStillNeeded.set(faction, Math.max(repStillNeeded.get(faction) ?? 0, amount));
	for (const entry of locked) if (!willOwn.has(entry.aug)) need(entry.faction, entry.repNeeded);
	for (const [aug, faction] of sellers) if (!willOwn.has(aug)) need(faction, ns.singularity.getAugmentationRepReq(aug));
	const redPillRep = ns.singularity.getAugmentationRepReq(RED_PILL);
	if (factions.includes(DAEDALUS) && !owned.has(RED_PILL)) need(DAEDALUS, redPillRep);
	const totalNeeded = [...repStillNeeded.values()].reduce((sum, amount) => sum + amount, 0);
	const favors = [...repStillNeeded].map(([faction, amount]) => ({
		faction, favor: ns.singularity.getFactionFavor(faction), rep: rep.get(faction),
		rate: rates.perSecond[faction] ?? 0, repShare: totalNeeded > 0 ? amount / totalNeeded : 0, // not `share`: that name costs 2.4GB (ns.share)
	}));

	// Daedalus: when it was first seen this run (how long the invite takes), and its numbers.
	const daedalusSeenAt = !factions.includes(DAEDALUS) ? null
		: sameRun && previous.daedalusSeenAt ? previous.daedalusSeenAt : Date.now();
	const daedalus = factions.includes(DAEDALUS) && !owned.has(RED_PILL) ? {
		favor: favors.find((entry) => entry.faction === DAEDALUS)?.favor ?? ns.singularity.getFactionFavor(DAEDALUS),
		rep: rep.get(DAEDALUS), rate: rates.perSecond[DAEDALUS] ?? 0, redPillRep,
		threshold: ns.getFavorToDonate(), joinAgeMs: daedalusSeenAt - lastReset,
		repMult: player.mults.faction_rep,
	} : null;

	// After The Red Pill: only hacking level stands between the run and the end of the BitNode.
	const hackExp = hackExpRate(previous, sameRun, player.exp.hacking);
	let endgame = null;
	if (installed.has(RED_PILL) && ns.serverExists(DAEMON)) {
		for (const aug of [...queued, NEUROFLUX]) if (!statsOf.has(aug)) statsOf.set(aug, ns.singularity.getAugmentationStats(aug));
		endgame = { daemonLevel: ns.getServerRequiredHackingLevel(DAEMON), level: player.skills.hacking, exp: player.exp.hacking, rate: hackExp.perSecond, statsOf };
	}

	const decision = decideReset({
		queued, plan, upcoming, cash: cash() + stocks, homeCash: cash(), income, incomeModel, sinceInstallMs,
		neuroflux, homeNeed: homeUpgradeNeed(ns), favors, daedalus, push, endgame, ratesMeasured: Object.keys(rates.perSecond).length > 0,
	});
	// A push reset buys the fill list (cheapest augments) instead of the usual plan.
	const pushing = push && decision.reset && decision.push;

	// When the advice first said RESET this run (null while it says wait), so auto-reset.js
	// announces a reset once per stretch of RESET advice, even when it is restarted.
	const resetSince = !decision.reset ? null
		: sameRun && previous?.resetSince ? previous.resetSince : Date.now();

	ns.write(PLAN_FILE, JSON.stringify({
		time: rates.snapshotTime, rep: rates.snapshot, perSecond: rates.perSecond, checkedAt: Date.now(),
		queued, affordable: fitNow.augs, cost: fitNow.cost, stocks, decision, resetSince, daedalusSeenAt, bitnode: bitnodeGoal(ns, factions),
		incomeHistory, incomeModel, hackExp,
		// For singularity/workers/aug-buyer.js: everything with the rep, most expensive first, and
		// where to buy NeuroFlux (null when the config or --no-neuroflux says not to).
		buyList: pushing ? push.fill.map((aug) => ({ aug, faction: anySeller.get(aug) }))
			: plan.map((entry) => ({ aug: entry.aug, faction: sellers.get(entry.aug) })),
		neurofluxFaction: AUG_CONFIG.neuroflux && !flags["no-neuroflux"] ? nfgFaction : null,
		daedalusPush: push ? { need: push.need, installed: push.installed, missing: push.missing, fill: push.fill } : null,
	}), "w");
	if (flags.dry) {
		if (push) {
			ns.tprint(`Daedalus push: the invite only lacks installed augments (${push.installed} + ${queued.length} bought of ${push.need}). ` +
				`Cheapest ${push.fill.length} affordable now: ${push.fill.join(", ") || "none"}.`);
		}
		showAdvice(ns, plan, cash(), stocks, sellers, boosts, skipped, upcoming, queued, fitNow, decision, rates, income, incomeModel);
	}
	if (flags.dry || flags.plan) return;

	// Buy: hand over to the small buyer, which starts once this script has exited and frees its RAM.
	const buyerArgs = flags.reserve > 0 ? ["--reserve", flags.reserve] : [];
	ns.spawn(BUYER, { threads: 1, spawnDelay: 0 }, ...buyerArgs);
}

/**
 * Should you reset now? Returns { reset, reason, value, rate, best, curve }.
 *
 * The rule: reset at the moment that gives the most augment value per hour of the run.
 * A batch's value is the weighted sum of log(multiplier) of its stats (utils/aug-filter.js
 * augValue), plus the NeuroFlux levels the leftover cash buys, plus the favor the rep
 * earned this run turns into. e^value is roughly how much faster the next run goes.
 * Long-run progress grows by the value gained per hour, so for each moment ahead
 * (FORECAST_MINUTES, from the income curve and rep rates) it works out value / (run age + overhead)
 * and resets when no later moment beats now by more than waitMargin. Waiting pays less and
 * less over a run because each purchase makes the rest 1.9x dearer, so there is always a
 * best moment, and the slow start of every run is already inside the run age.
 *
 * On top of that: The Red Pill (resetRule.keyAugs) resets at once, and the Daedalus rule
 * (daedalusRule) holds or forces a reset around Daedalus favor reaching the donation line.
 */
function decideReset(context) {
	const { queued, plan, upcoming, income, sinceInstallMs, daedalus, push, endgame, ratesMeasured } = context;
	const minutes = (ms) => `${Math.max(1, Math.round(ms / 60_000))} min`;
	const eta = (ms) => (ms < 3600_000 ? minutes(ms) : `${(ms / 3600_000).toFixed(1)}h`);
	const overheadMs = RESET_RULE.overheadMinutes * 60_000;
	const horizonMs = RESET_RULE.horizonHours * 3600_000;

	const points = [0, ...FORECAST_MINUTES.map((m) => m * 60_000).filter((ms) => ms <= horizonMs)].map((waitMs) => {
		const point = valueAt(context, waitMs);
		return { ...point, waitMs, rate: point.value / ((sinceInstallMs + waitMs + overheadMs) / 3600_000) };
	});
	const now = points[0];
	// Only moments within maxWaitMinutes count as "later": a forecast that keeps promising a slightly
	// better moment a bit further on would otherwise postpone the reset for ever.
	const maxWaitMs = (RESET_RULE.maxWaitMinutes ?? Infinity) * 60_000;
	const later = points.slice(1).filter((point) => point.waitMs <= maxWaitMs).reduce((top, point) => (!top || point.rate > top.rate ? point : top), null);
	const curve = points.map((point) => ({ inMinutes: Math.round(point.waitMs / 60_000), value: round(point.value), rate: round(point.rate), augs: point.augs.length, neuroflux: point.neuroflux }));
	const result = (reset, reason, pushReset = false) => ({
		reset, reason, push: pushReset, value: round(now.value), rate: round(now.rate), curve,
		best: later ? { inMinutes: Math.round(later.waitMs / 60_000), value: round(later.value), rate: round(later.rate) } : null,
	});
	const speed = (point) => `x${Math.exp(point.value).toFixed(2)} (${point.rate.toFixed(3)}/h)`;
	const added = (point) => {
		const fresh = point.augs.filter((aug) => !now.augs.includes(aug));
		const parts = [];
		if (fresh.length > 0) parts.push(fresh.join(", "));
		if (point.neuroflux > now.neuroflux) parts.push(`${point.neuroflux - now.neuroflux} more NeuroFlux`);
		if (parts.length === 0) parts.push("more favor");
		return parts.join(" + ");
	};

	const ready = [...queued, ...now.augs];
	if (endgame) {
		const after = afterRedPillRule(endgame, ready, now.neuroflux, eta);
		return result(after.reset, after.reason);
	}
	const key = RESET_RULE.keyAugs.filter((aug) => ready.includes(aug));
	if (key.length > 0) return result(true, `${key.join(" and ")} ready: reset for it right away.`);
	// Daedalus push: enough cheap augments for the invite's count are affordable, so install them now.
	if (push && push.fill.length >= push.missing) {
		return result(true, `Daedalus invite only lacks installed augments (${push.installed} of ${push.need}): ` +
			`buying the ${push.fill.length} cheapest, useful or not, and resetting for the invite.`, true);
	}

	const count = ready.length + now.neuroflux;
	if (count === 0) {
		const unlockNote = later && later.augs.length > 0 ? ` First batch worth it in about ${eta(later.waitMs)}: ${later.augs.join(", ")}.` : "";
		return result(false, (plan.length > 0 ? "Useful augments are unlocked but none is affordable yet." : "Nothing useful is unlocked yet: keep earning rep.") + unlockNote);
	}
	if (sinceInstallMs < RESET_RULE.minRunMinutes * 60_000) {
		return result(false, `Run is only ${minutes(sinceInstallMs)} old (minimum ${RESET_RULE.minRunMinutes} min). ${count} ready, worth ${speed(now)}.`);
	}
	if (!ratesMeasured && upcoming.length > 0) {
		return result(false, `${count} ready, worth ${speed(now)}. Measuring rep rates before deciding (next check).`);
	}

	const fromDaedalus = daedalusRule(daedalus, context, horizonMs, eta);
	if (fromDaedalus) return result(fromDaedalus.reset, fromDaedalus.reason);

	// Guarantee: an old run with a worthwhile batch resets now, whatever the forecast says.
	if (RESET_RULE.maxRunHours != null && sinceInstallMs >= RESET_RULE.maxRunHours * 3600_000 &&
		now.value >= Math.log(RESET_RULE.guaranteeSpeed ?? 1)) {
		return result(true, `Run is ${eta(sinceInstallMs)} old and ${count} ready are worth ${speed(now)} (at least x${RESET_RULE.guaranteeSpeed ?? 1}): ` +
			"resetting instead of waiting for ever-better moments.");
	}

	if (later && later.rate > now.rate * (1 + RESET_RULE.waitMargin)) {
		return result(false, `Resetting now gives ${speed(now)}; waiting ${eta(later.waitMs)} for ${added(later)} gives ${speed(later)}, ` +
			`more per hour of run. Waiting.`);
	}
	const laterNote = later ? ` Best later moment: in ${eta(later.waitMs)}, ${speed(later)}.` : "";
	return result(true, `${count} ready, worth ${speed(now)} per hour of run: no later moment beats it.${laterNote}`);
}

/**
 * The Daedalus rule, while Daedalus is joined and The Red Pill isn't owned.
 * Daedalus can take donations (150 favor, getFavorToDonate): singularity/donate-rep.js buys
 * the rep with money, so hold the reset while that money comes within the horizon (a reset
 * would mean earning the invite again first). Otherwise a later run can buy the rep, but only
 * after getting the invite again (hack level and money):
 *  - Red Pill by work sooner than that: keep working, no reset (it would throw the rep away).
 *  - Otherwise, favor after a reset reaches the line: reset.
 *  - Otherwise, it reaches the line within the forecast horizon: hold until it does.
 * Returns { reset, reason } or null to leave it to the normal rule.
 */
function daedalusRule(daedalus, { income, incomeModel, homeCash }, horizonMs, eta) {
	if (!RESET_RULE.daedalusFavor || !daedalus) return null;
	if (daedalus.favor >= daedalus.threshold) {
		// Home cash only: donations can't use money held in stocks.
		const missingMoney = Math.max(0, daedalus.redPillRep - daedalus.rep) * DONATE_MONEY_PER_REP / daedalus.repMult;
		const waitMs = missingMoney <= homeCash ? 0 : income > 0 ? timeToEarn(income, incomeModel, missingMoney - homeCash) * 1000 : Infinity;
		if (waitMs > horizonMs) return null;
		const cost = missingMoney >= 1e12 ? `$${(missingMoney / 1e12).toFixed(1)}t` : `$${(missingMoney / 1e9).toFixed(1)}b`;
		return { reset: false, reason: `Daedalus takes donations: The Red Pill's rep costs ${cost}` +
			(waitMs > 0 ? `, earned in about ${eta(waitMs)}` : ", affordable now") + " (donate-rep.js buys it). No reset until then." };
	}
	const missing = Math.max(0, daedalus.redPillRep - daedalus.rep);
	const workMs = daedalus.rate > 0 ? (missing / daedalus.rate) * 1000 : Infinity;
	if (!Number.isFinite(workMs)) return null; // not working for Daedalus (or not measured yet)
	const donateMoney = daedalus.redPillRep * DONATE_MONEY_PER_REP / daedalus.repMult;
	const rebuildMs = income > 0 ? daedalus.joinAgeMs + (donateMoney / income) * 1000 : Infinity;
	if (workMs <= rebuildMs) {
		return { reset: false, reason: `The Red Pill by work in about ${eta(workMs)}, sooner than a reset plus the Daedalus invite and donations (~${Number.isFinite(rebuildMs) ? eta(rebuildMs) : "never at this income"}). Keep working, no reset.` };
	}
	const favorAfter = repToFavor(favorToRep(daedalus.favor) + daedalus.rep);
	if (favorAfter >= daedalus.threshold) {
		return { reset: true, reason: `Daedalus favor reaches ${Math.floor(favorAfter)} on reset: next run can buy The Red Pill's rep with money (~${eta(rebuildMs)}) instead of ${eta(workMs)} of work.` };
	}
	const repToLine = favorToRep(daedalus.threshold) - favorToRep(daedalus.favor) - daedalus.rep;
	const lineMs = (repToLine / daedalus.rate) * 1000;
	if (lineMs <= horizonMs) {
		return { reset: false, reason: `Daedalus favor reaches the donation line (${daedalus.threshold}) in about ${eta(lineMs)}. Waiting for it, then resetting.` };
	}
	return null;
}

/**
 * The batch you'd install if you reset after waiting waitMs: cash grows with income along
 * the income curve (utils/income-curve.js; flat when it has nothing to go on),
 * locked augments unlock at their rep ETA, bought most expensive first like a real run,
 * then NeuroFlux with what's left, plus the favor the run's rep turns into.
 * Returns { value, augs, neuroflux }.
 */
function valueAt({ queued, plan, upcoming, cash, income, incomeModel, neuroflux, homeNeed, favors }, waitMs) {
	const waitS = waitMs / 1000;
	const cashThen = cash + earnedOver(Math.max(0, income), incomeModel, waitS);
	const unlocked = [...plan, ...upcoming.filter((entry) => entry.etaMs !== null && entry.etaMs <= waitMs)]
		.sort((first, second) => second.price - first.price);
	const fit = whatFits(unlocked, cashThen);
	const valueOf = new Map(unlocked.map((entry) => [entry.aug, entry.value]));
	let value = fit.augs.reduce((sum, aug) => sum + (valueOf.get(aug) ?? 0), 0);

	// NeuroFlux levels from the leftover cash (each level 1.14x dearer in money and rep, plus the 1.9x markup).
	// Not when a home upgrade could use the leftover cash instead (homeNeed: singularity/ready.js).
	let levels = 0;
	if (neuroflux && cashThen - fit.cost < homeNeed) {
		let left = cashThen - fit.cost;
		let price = neuroflux.price * fit.mult;
		let repReq = neuroflux.repReq;
		const rep = neuroflux.rep + neuroflux.rate * waitS;
		while (levels < 200 && price <= left && repReq <= rep) {
			left -= price;
			price *= NEUROFLUX_LEVEL_MULT * PRICE_MULT;
			repReq *= NEUROFLUX_LEVEL_MULT;
			levels++;
		}
		value += levels * neuroflux.value;
	}

	// Favor: +1% rep gain per point next run, at the factions still needed there.
	const repWeight = (RESET_RULE.weights.faction_rep ?? RESET_RULE.defaultWeight) * RESET_RULE.favorWeight;
	for (const entry of favors) {
		const after = repToFavor(favorToRep(entry.favor) + entry.rep + entry.rate * waitS);
		value += entry.repShare * repWeight * Math.log((100 + after) / (100 + entry.favor));
	}
	return { value, augs: fit.augs, neuroflux: levels };
}

/**
 * After The Red Pill is installed the BitNode ends once hacking reaches w0r1d_d43m0n's level
 * (auto-destroy.js), and a reset throws the hacking exp away. So reset only when starting over
 * with the batch gets there sooner: exp needed for the daemon's level with the batch's hacking
 * multiplier, earned at today's exp rate times its hacking-exp multiplier times
 * afterRedPill.rebuildFactor (a new run starts slower), plus overheadMinutes; against the exp
 * still missing at today's rate. Level = mult x (32 ln(exp + 534.6) - 200), the game's formula,
 * with the effective mult read back from the current level and exp (so BitNode multipliers count).
 */
function afterRedPillRule(endgame, ready, neurofluxLevels, eta) {
	const { daemonLevel, level, exp, rate, statsOf } = endgame;
	if (level >= daemonLevel) return { reset: false, reason: `Hacking ${level} reaches ${DAEMON} (${daemonLevel}): no reset, auto-destroy ends the BitNode.` };
	if (!(rate > 0)) return { reset: false, reason: `The Red Pill is installed: hacking ${level} of ${daemonLevel} for ${DAEMON}. Measuring the hack exp rate before weighing a reset.` };
	const base = 32 * Math.log(exp + 534.6) - 200;
	const mult = base > 0 ? level / base : 1;
	const expFor = (target, withMult) => Math.max(0, Math.exp((target / withMult + 200) / 32) - 534.6);
	let hackMult = 1;
	let expMult = 1;
	const boost = (stats, times = 1) => {
		hackMult *= Math.pow(stats?.hacking ?? 1, times);
		expMult *= Math.pow(stats?.hacking_exp ?? 1, times);
	};
	for (const aug of ready) if (aug !== NEUROFLUX) boost(statsOf.get(aug));
	const levels = neurofluxLevels + (ready.includes(NEUROFLUX) ? 1 : 0);
	if (levels > 0) boost(statsOf.get(NEUROFLUX), levels);
	const settings = RESET_RULE.afterRedPill ?? {};
	const stayMs = (Math.max(0, expFor(daemonLevel, mult) - exp) / rate) * 1000;
	const resetMs = (expFor(daemonLevel, mult * hackMult) / (rate * expMult * (settings.rebuildFactor ?? 0.5))) * 1000
		+ RESET_RULE.overheadMinutes * 60_000;
	if (resetMs * (1 + RESET_RULE.waitMargin) < stayMs) {
		return { reset: true, reason: `The Red Pill is installed and ${ready.length} augment(s) (hack x${hackMult.toFixed(2)}, exp x${expMult.toFixed(2)}) ` +
			`reach ${DAEMON}'s level ${daemonLevel} in about ${eta(resetMs)} after a reset, sooner than ${eta(stayMs)} without one. Resetting.` };
	}
	return { reset: false, reason: `The Red Pill is installed: hacking ${level} of ${daemonLevel} for ${DAEMON} in about ${eta(stayMs)}. ` +
		`A reset with the ${ready.length} augment(s) ready would take about ${eta(resetMs)}, so keep hacking.` };
}

/** Hack exp per second from the snapshot in the last plan (same rules as the rep rates). */
function hackExpRate(previous, sameRun, exp) {
	const now = Date.now();
	const last = sameRun ? previous?.hackExp : null;
	if (!last || exp < last.exp) return { time: now, exp, perSecond: 0 };
	const gap = now - last.time;
	if (gap < RESET_RULE.minRateGapMs) return last;
	if (gap > RESET_RULE.maxRateGapMs) return { time: now, exp, perSecond: 0 };
	return { time: now, exp, perSecond: (exp - last.exp) / (gap / 1000) };
}

/**
 * Daedalus push (resetRule.daedalusPush): Daedalus hasn't invited you and every invite requirement
 * except the installed augment count is met (hack level, money). Then the count is what stands
 * between the run and The Red Pill, and any augment counts the same, so the cheapest win.
 * NeuroFlux levels count as one augment however many there are. Returns
 * { need, installed, missing } (missing after the bought-but-not-installed ones), or null.
 */
function daedalusPush(ns, factions, installed, queued) {
	if (!RESET_RULE.daedalusPush || factions.includes(DAEDALUS) || installed.has(RED_PILL)) return null;
	const requirements = ns.singularity.getFactionInviteRequirements(DAEDALUS);
	const count = requirements.find((entry) => entry.type === "numAugmentations");
	if (!count || installed.size >= count.numAugmentations) return null;
	const player = ns.getPlayer();
	if (!requirements.filter((entry) => entry !== count).every((entry) => requirementMet(entry, player))) return null;
	return { need: count.numAugmentations, installed: installed.size, missing: Math.max(0, count.numAugmentations - installed.size - queued.length) };
}

/** Is one invite requirement met? Unknown kinds count as not met, so the push only starts when sure. */
function requirementMet(entry, player) {
	switch (entry.type) {
		case "money": return player.money >= entry.money;
		case "skills": return Object.entries(entry.skills).every(([skill, level]) => (player.skills[skill] ?? 0) >= level);
		case "someCondition": return entry.conditions.some((inner) => requirementMet(inner, player));
		case "everyCondition": return entry.conditions.every((inner) => requirementMet(inner, player));
		default: return false;
	}
}

/** Up to `count` augments, cheapest first, that fit the cash when bought most expensive first. */
function cheapestFill(pool, cash, count) {
	const picked = [];
	for (const entry of [...pool].sort((first, second) => first.price - second.price)) {
		if (picked.length >= count) break;
		const trial = [...picked, entry].sort((first, second) => second.price - first.price);
		const cost = trial.reduce((sum, item, index) => sum + item.price * Math.pow(PRICE_MULT, index), 0);
		if (cost <= cash) picked.push(entry);
	}
	return picked.map((entry) => entry.aug);
}

/** Rep needed in total for this much favor, and back (the game's formulas). */
function favorToRep(favor) {
	return 25_000 * (Math.pow(1.02, favor) - 1);
}
function repToFavor(rep) {
	return Math.log(rep / 25_000 + 1) / Math.log(1.02);
}

function round(number) {
	return Math.round(number * 1000) / 1000;
}

/** Most expensive first, each later one 1.9x dearer; skips ones that don't fit (like a real run). */
function whatFits(plan, cash) {
	const augs = [];
	let cost = 0;
	let mult = 1;
	for (const entry of plan) {
		if (cost + entry.price * mult > cash) continue;
		cost += entry.price * mult;
		mult *= PRICE_MULT;
		augs.push(entry.aug);
	}
	return { augs, cost, mult };
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

function readPlan(ns) {
	try {
		return JSON.parse(ns.read(PLAN_FILE));
	} catch {
		return null;
	}
}

/**
 * Rep gained per second for each faction, from the rep snapshot in the last plan file.
 * Snapshots closer than 2 minutes are too noisy, so then the old snapshot and rates are
 * kept. A snapshot from before the last install (or rep that went down) starts afresh.
 */
function repRates(ns, previous, rep) {
	const now = Date.now();
	const current = Object.fromEntries(rep);
	const lastReset = ns.getResetInfo().lastAugReset;
	if (!previous?.rep || previous.time < lastReset) return { snapshot: current, snapshotTime: now, perSecond: {} };

	const gap = now - previous.time;
	if (gap < RESET_RULE.minRateGapMs) return { snapshot: previous.rep, snapshotTime: previous.time, perSecond: previous.perSecond ?? {} };
	if (gap > RESET_RULE.maxRateGapMs) return { snapshot: current, snapshotTime: now, perSecond: {} };

	const perSecond = {};
	for (const [faction, value] of Object.entries(current)) {
		const before = previous.rep[faction];
		if (before !== undefined && value >= before) perSecond[faction] = (value - before) / (gap / 1000);
	}
	return { snapshot: current, snapshotTime: now, perSecond };
}

/** The --dry report: the augments in buy order, then the reset decision and why. */
function showAdvice(ns, plan, cash, stocks, sellers, boosts, skipped, upcoming, queued, fit, decision, rates, income, incomeModel) {
	const money = (amount) => "$" + ns.format.number(amount);
	const { source } = readIncomeRate(ns);
	const available = cash + stocks;
	const timeFor = (amount) => (amount <= 0 ? "now" : income > 0 ? ns.format.time(timeToEarn(income, incomeModel, amount) * 1000) : "never (no income)");
	const sinceInstallMs = Date.now() - ns.getResetInfo().lastAugReset;

	ns.tprint(`${plan.length} useful augment(s) unlocked, ${queued.length} bought but not installed. Cash ${money(cash)}` +
		`${stocks > 0 ? ` + ${money(stocks)} in stocks` : ""}, income ${money(income)}/s (${source}). Run is ${ns.format.time(sinceInstallMs)} old.`);
	ns.tprint(incomeModel.growth > 0
		? `Income curve: growing ${((Math.exp(incomeModel.growth) - 1) * 100).toFixed(0)}%/h (${incomeModel.source}, ${incomeModel.samples} samples), ` +
			`forecast ${money(income * incomeMultAt(incomeModel, 1))}/s in 1h, ${money(income * incomeMultAt(incomeModel, RESET_RULE.horizonHours))}/s in ${RESET_RULE.horizonHours}h.`
		: `Income curve: taken as flat (${incomeModel.source === "flat" ? "not enough samples yet" : `not growing, ${incomeModel.source}`}).`);
	if (plan.length > 0) ns.tprint(`  ${"price now".padStart(10)}  ${"all so far".padStart(10)}  ${"value".padStart(5)}  augment   (+ = affordable now)`);
	let total = 0;
	let mult = 1;
	for (const entry of plan) {
		total += entry.price * mult;
		mult *= PRICE_MULT;
		const mark = fit.augs.includes(entry.aug) ? "+" : " ";
		ns.tprint(`${mark} ${money(entry.price).padStart(10)}  ${money(total).padStart(10)}  ${entry.value.toFixed(2).padStart(5)}  ${entry.aug} (${sellers.get(entry.aug)}): ${boosts.get(entry.aug)}`);
	}
	if (fit.augs.length < plan.length) {
		ns.tprint(`  All ${plan.length} together: ${money(total)}, ${money(total - available)} more, about ${timeFor(total - available)} on the income curve, if none of it is spent.`);
	}

	const working = Object.entries(rates.perSecond).filter(([, rate]) => rate > 0);
	if (working.length > 0) {
		ns.tprint(`Rep gain: ${working.map(([faction, rate]) => `${faction} ${ns.format.number(rate * 60)}/min`).join(", ")}`);
	}
	if (upcoming.length > 0) {
		const order = [...upcoming].sort((first, second) => (first.etaMs ?? Infinity) - (second.etaMs ?? Infinity) || first.missing - second.missing);
		const eta = (entry) => (entry.etaMs === null ? "not being worked on" : `~${ns.format.time(entry.etaMs)}`);
		ns.tprint(`Next rep unlocks: ${order.slice(0, 3).map((entry) => `${entry.aug} (${entry.faction}, value ${entry.value.toFixed(2)}, ${ns.format.number(entry.missing)} rep, ${eta(entry)})`).join("; ")}`);
	}
	if (skipped.length > 0) ns.tprint(`Skipped (no hacking/rep stats, use --all to buy): ${skipped.join(", ")}`);

	// The forecast the decision came from: batch value and value per hour of run, now and later.
	const shown = decision.curve.filter((point, index) => index === 0 || [30, 60, 120, 240, 360, 720].includes(point.inMinutes)
		|| point.inMinutes === decision.best?.inMinutes);
	ns.tprint(`Reset at: ${shown.map((point) => `${point.inMinutes === 0 ? "now" : `+${point.inMinutes}m`} x${Math.exp(point.value).toFixed(2)} ${point.rate.toFixed(3)}/h`).join(" | ")}`);

	ns.tprint("");
	if (decision.reset) {
		ns.tprint(`RESET NOW: ${decision.reason}`);
		ns.tprint("  Sell stocks, run buy-augs, then install-augs (auto-reset does all three by itself when not in --dry).");
	} else {
		ns.tprint(`WAIT: ${decision.reason}`);
		ns.tprint("  Don't buy yet either: prices only go up, and nothing works until it's installed.");
	}
}

/**
 * What tools/status.js needs to show how far the BitNode is from ending: The Red Pill's rep
 * requirement and price, and, while Daedalus hasn't invited you yet, its invite requirements.
 */
function bitnodeGoal(ns, factions) {
	return {
		redPill: { rep: ns.singularity.getAugmentationRepReq(RED_PILL), price: ns.singularity.getAugmentationPrice(RED_PILL) },
		daedalusInvite: factions.includes(DAEDALUS) ? null : ns.singularity.getFactionInviteRequirements(DAEDALUS),
	};
}
