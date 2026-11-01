import { readIncomeRate } from "/utils/income.js";
const NEUROFLUX = "NeuroFlux Governor";
const PLAN_FILE = "data/aug-plan.json";
const PRICE_MULT = 1.9; // every purchase multiplies the price of the rest

// Stats that matter for a hacking run. Rep gain is in because it speeds up every later aug.
const HACKING_STATS = {
	hacking: "hack", hacking_exp: "hack exp", hacking_chance: "hack chance", hacking_speed: "hack speed",
	hacking_money: "hack money", hacking_grow: "grow", faction_rep: "faction rep", company_rep: "company rep",
	hacknet_node_money: "hacknet money", dnet_money: "darknet money",
};
// Lower is better for these (hacknet costs).
const COST_STATS = {
	hacknet_node_purchase_cost: "hacknet node cost", hacknet_node_ram_cost: "hacknet RAM cost",
	hacknet_node_core_cost: "hacknet core cost", hacknet_node_level_cost: "hacknet level cost",
};
// No multipliers, but always worth it.
const SPECIAL = {
	"The Red Pill": "lets you destroy the BitNode",
	"Neuroreceptor Manager": "no penalty for unfocused work",
	"CashRoot Starter Kit": "$1m and BruteSSH.exe after every reset",
};

// When to reset (used by --dry and --plan, so `augs` and auto-reset.js always agree).
const RESET_RULE = {
	keyAugs: ["The Red Pill", "Neuroreceptor Manager"], // reset as soon as one of these is ready
	minAugs: 5,          // a normal reset: at least this many useful augments ready...
	soonMinutes: 30,     // ...unless another one you could afford unlocks within this long (then wait for it)
	maxWaitMinutes: 60,  // ...but once a batch is ready, wait at most this long IN TOTAL for more
	plentyAugs: 10,      // ...and with this many ready, don't wait for anything
	stallMinAugs: 2,     // a smaller reset is fine when progress has stalled: this many ready,
	minRunHours: 3,      //   the run is at least this old,
	stallHours: 4,       //   and either nothing you could afford unlocks within this long
	maxSmallWaitHours: 3, //  or you've already waited this long for the batch to grow
	minRateGapMs: 120_000, // rep rates need two snapshots at least 2 minutes apart
	maxRateGapMs: 3 * 3600_000,
};

/**
 * Buys the augments worth having (by default: ones that help hacking, hacknet, darknet or
 * rep gain, plus The Red Pill, Neuroreceptor Manager and CashRoot) that you have the rep
 * for, most expensive first (each purchase raises the price of the rest by 1.9x, so the
 * big ones go first), then spends what's left on NeuroFlux Governor levels. Combat,
 * charisma, crime and Bladeburner augments are skipped, since they'd only make the useful
 * ones dearer. It doesn't install them: run install-augs.js for that.
 *
 * Prerequisites aren't looked up (getAugmentationPrereq would cost another 5GB). A
 * purchase that fails is retried after the next one succeeds, so e.g. Cranial Signal
 * Processors Gen II goes through once Gen I is bought.
 *
 * Est. 29GB RAM. It runs once and exits.
 *
 *   run singularity/buy-augs.js                  buy the useful ones you can afford
 *   run singularity/buy-augs.js --dry            list them with what each one boosts, the
 *                                                cost of the whole set and whether to wait
 *   run singularity/buy-augs.js --all            buy every augment, useful or not
 *   run singularity/buy-augs.js --no-neuroflux   skip NeuroFlux Governor
 *   run singularity/buy-augs.js --reserve 1e9    leave $1b untouched
 *   run singularity/buy-augs.js --plan           buy nothing; write what it could buy and
 *                                                whether to reset to data/aug-plan.json
 *                                                (used by auto-reset.js)
 *   --min-augs N   with --dry/--plan: the batch size for a normal reset (default 5)
 *
 * --dry and --plan both end with the same reset decision (see decideReset), so what
 * `augs` tells you is exactly what auto-reset.js will do.
 */
export async function main(ns) {
	ns.disableLog("ALL");
	const flags = ns.flags([["dry", false], ["all", false], ["no-neuroflux", false], ["reserve", 0], ["plan", false], ["min-augs", RESET_RULE.minAugs]]);
	const cash = () => ns.getServerMoneyAvailable("home") - flags.reserve;
	const money = (amount) => "$" + ns.format.number(amount);

	const factions = ns.getPlayer().factions;
	const owned = new Set(ns.singularity.getOwnedAugmentations(true));
	const rep = new Map(factions.map((faction) => [faction, ns.singularity.getFactionRep(faction)]));

	// Augment -> a joined faction with enough rep to sell it; and what it boosts.
	const sellers = new Map();
	const boosts = new Map();
	const skipped = [];
	const locked = []; // useful, but the faction rep isn't there yet
	for (const faction of factions) {
		for (const aug of ns.singularity.getAugmentationsFromFaction(faction)) {
			if (aug === NEUROFLUX || owned.has(aug) || sellers.has(aug)) continue;
			// Several factions can sell the same augment: read its stats once, but check the rep at each.
			if (!boosts.has(aug)) boosts.set(aug, describeBoosts(ns, aug));
			const summary = boosts.get(aug);
			const repNeeded = ns.singularity.getAugmentationRepReq(aug);
			if (rep.get(faction) < repNeeded) {
				if (summary) locked.push({ aug, faction, missing: repNeeded - rep.get(faction), price: ns.singularity.getAugmentationPrice(aug) });
				continue;
			}
			if (summary || flags.all) sellers.set(aug, faction);
			else if (!skipped.includes(aug)) skipped.push(aug);
		}
	}
	const byPrice = () => [...sellers.keys()]
		.map((aug) => ({ aug, price: ns.singularity.getAugmentationPrice(aug) }))
		.sort((first, second) => second.price - first.price);

	if (flags.plan || flags.dry) {
		const installed = new Set(ns.singularity.getOwnedAugmentations(false));
		const queued = [...owned].filter((aug) => !installed.has(aug));
		const previous = readPlan(ns);
		const rates = repRates(ns, previous, rep);
		const plan = byPrice();
		const fit = whatFits(plan, cash());

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
		const lastReset = ns.getResetInfo().lastAugReset;
		const sinceInstallMs = Date.now() - lastReset;
		const income = readIncomeRate(ns).perSecond; // not getTotalScriptIncome: it misses batcher hacks
		// The wait timers carry over between checks (same run only), so waiting can't go on forever.
		// A plan from this run without them was written by the old rule (before the timers existed):
		// then assume the batch has been ready a long time rather than starting a fresh wait.
		const sameRun = previous?.checkedAt >= lastReset;
		const timers = !sameRun ? {}
			: previous.decision && "fullSince" in previous.decision ? previous.decision
				: { fullSince: lastReset, smallSince: lastReset + RESET_RULE.minRunHours * 3600_000 };
		const decision = decideReset({
			queued, plan, fit, cash: cash(), income, upcoming, sinceInstallMs, minAugs: flags["min-augs"], timers,
		});

		ns.write(PLAN_FILE, JSON.stringify({
			time: rates.snapshotTime, rep: rates.snapshot, perSecond: rates.perSecond, checkedAt: Date.now(),
			queued, affordable: fit.augs, cost: fit.cost, decision,
		}), "w");
		if (flags.dry) showAdvice(ns, plan, cash(), sellers, boosts, skipped, upcoming, queued, fit, decision, rates, sinceInstallMs, income);
		return;
	}

	let bought = 0;
	let progress = true;
	while (progress && sellers.size > 0) {
		progress = false;
		for (const entry of byPrice().filter((candidate) => candidate.price <= cash())) {
			if (ns.singularity.purchaseAugmentation(sellers.get(entry.aug), entry.aug)) {
				ns.tprint(`Bought ${entry.aug} from ${sellers.get(entry.aug)} for ${money(entry.price)}`);
				sellers.delete(entry.aug);
				bought++;
				progress = true;
				break; // prices just went up: re-read them
			}
		}
	}
	if (sellers.size > 0) ns.tprint(`Left for later (money or prerequisites): ${[...sellers.keys()].join(", ")}`);

	let neuroflux = 0;
	if (!flags["no-neuroflux"]) {
		// Buy from the joined faction with the most rep, since its rep requirement climbs per level.
		const best = factions.reduce((top, faction) => (rep.get(faction) > (rep.get(top) ?? -1) ? faction : top), null);
		while (best && rep.get(best) >= ns.singularity.getAugmentationRepReq(NEUROFLUX)
			&& ns.singularity.getAugmentationPrice(NEUROFLUX) <= cash()
			&& ns.singularity.purchaseAugmentation(best, NEUROFLUX)) {
			neuroflux++;
		}
	}

	ns.tprint(`Done: ${bought} augment(s) and ${neuroflux} NeuroFlux level(s) bought, cash left ${money(cash() + flags.reserve)}.`);
	if (bought + neuroflux > 0) ns.tprint("Run singularity/install-augs.js when you're ready to install them (this resets the run).");
}

/** "hack +10%, grow +5%" for the stats that matter, or "" if none. */
function describeBoosts(ns, aug) {
	if (SPECIAL[aug]) return SPECIAL[aug];
	const stats = ns.singularity.getAugmentationStats(aug);
	const parts = [];
	for (const [key, label] of Object.entries(HACKING_STATS)) {
		if (stats[key] > 1) parts.push(`${label} +${Math.round((stats[key] - 1) * 100)}%`);
	}
	for (const [key, label] of Object.entries(COST_STATS)) {
		if (stats[key] < 1) parts.push(`${label} -${Math.round((1 - stats[key]) * 100)}%`);
	}
	return parts.join(", ");
}

/**
 * Should you reset now? Returns { reset, reason, fullSince, smallSince, worth }.
 * Installing wipes faction rep, so the rule waits while more useful augments are about to
 * unlock, and resets once a decent batch is ready (or a key augment is, or progress has
 * stalled). Two things stop "one more is 15 minutes away" from blocking forever:
 *  - an upcoming augment only counts if you could also afford it when it unlocks (price
 *    after the 1.9x markups of the batch, against cash + income until then);
 *  - waiting is capped: once a full batch is ready (fullSince) it waits at most
 *    maxWaitMinutes in total, and once a small reset is allowed (smallSince) at most
 *    maxSmallWaitHours. The timers are kept in the plan file between checks.
 */
function decideReset({ queued, plan, fit, cash, income, upcoming, sinceInstallMs, minAugs, timers }) {
	const now = Date.now();
	const ready = [...queued, ...fit.augs];
	const count = ready.length;
	const key = RESET_RULE.keyAugs.filter((aug) => ready.includes(aug));
	const minutes = (ms) => `${Math.max(1, Math.round(ms / 60_000))} min`;
	const hours = (ms) => `${(ms / 3600_000).toFixed(1)}h`;
	const eta = (ms) => (ms < 3600_000 ? minutes(ms) : hours(ms));

	// Locked augments that would actually grow the batch: affordable at unlock time.
	const known = upcoming.filter((entry) => entry.etaMs !== null).sort((first, second) => first.etaMs - second.etaMs);
	const growsBatch = (entry) => {
		const withIt = [...plan, entry].sort((first, second) => second.price - first.price);
		return whatFits(withIt, cash + Math.max(0, income) * entry.etaMs / 1000).augs.length > fit.augs.length;
	};
	const worth = known.filter(growsBatch);
	const next = worth[0];
	const tooDear = known.length > 0 && (!next || known[0].etaMs < next.etaMs) ? known[0] : null;
	const dearNote = tooDear ? ` (${tooDear.aug} unlocks sooner, in ${eta(tooDear.etaMs)}, but you couldn't afford it on top of this batch.)` : "";

	const fullSince = count >= minAugs ? timers.fullSince ?? now : null;
	const smallSince = count >= RESET_RULE.stallMinAugs && sinceInstallMs >= RESET_RULE.minRunHours * 3600_000 ? timers.smallSince ?? now : null;
	const result = (reset, reason) => ({ reset, reason, fullSince, smallSince, worth: worth.map((entry) => entry.aug) });

	if (key.length > 0) return result(true, `${key.join(" and ")} ready: worth resetting for on its own.`);
	if (count === 0) {
		return result(false, plan.length > 0 ? "Useful augments are unlocked but none is affordable yet." : "Nothing useful is unlocked yet: keep earning rep.");
	}

	if (count >= minAugs) {
		const waited = now - fullSince;
		const left = RESET_RULE.maxWaitMinutes * 60_000 - waited;
		const soon = worth.filter((entry) => entry.etaMs <= RESET_RULE.soonMinutes * 60_000);
		if (count >= RESET_RULE.plentyAugs) return result(true, `${count} useful augments ready: plenty, no point waiting for more.`);
		if (soon.length > 0 && soon[0].etaMs <= left) {
			return result(false, `${count} ready, but ${soon[0].aug} unlocks in about ${minutes(soon[0].etaMs)} and you could afford it too. ` +
				`Waiting for it (${minutes(left)} of the ${RESET_RULE.maxWaitMinutes} min wait left).`);
		}
		if (soon.length > 0) {
			return result(true, `${count} useful augments ready and already waited ${minutes(waited)} for more. ${soon[0].aug} (${minutes(soon[0].etaMs)}) can go in the next batch.`);
		}
		return result(true, `${count} useful augments ready and nothing else you could afford unlocks within ${RESET_RULE.soonMinutes} min.${dearNote}`);
	}

	if (smallSince !== null) {
		const waited = now - smallSince;
		if (!next || next.etaMs > RESET_RULE.stallHours * 3600_000) {
			return result(true, `Only ${count} ready, but nothing you could afford unlocks within ${RESET_RULE.stallHours}h and this run is ${hours(sinceInstallMs)} old. Reset to get the rep bonus going.`);
		}
		if (waited >= RESET_RULE.maxSmallWaitHours * 3600_000) {
			return result(true, `Only ${count} ready, but already waited ${hours(waited)} for the batch to reach ${minAugs}. Reset now; ${next.aug} can go in the next one.`);
		}
		return result(false, `Only ${count} of ${minAugs} ready. Next unlock you could afford: ${next.aug} in about ${eta(next.etaMs)}. ` +
			`Resets anyway in ${hours(RESET_RULE.maxSmallWaitHours * 3600_000 - waited)} if the batch doesn't fill up.`);
	}
	const waitingFor = next ? ` Next unlock you could afford: ${next.aug} in about ${eta(next.etaMs)}.`
		: known.length > 0 ? " None of the upcoming unlocks would be affordable on top of this batch yet."
			: " No rep gain measured yet for the factions with locked augments.";
	const smallAt = RESET_RULE.minRunHours * 3600_000 - sinceInstallMs;
	const smallNote = count >= RESET_RULE.stallMinAugs ? ` A smaller reset becomes possible in ${hours(smallAt)} (run ${RESET_RULE.minRunHours}h old).` : "";
	return result(false, `Only ${count} of ${minAugs} ready.${waitingFor}${smallNote}`);
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
	return { augs, cost };
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
function showAdvice(ns, plan, cash, sellers, boosts, skipped, upcoming, queued, fit, decision, rates, sinceInstallMs, income) {
	const money = (amount) => "$" + ns.format.number(amount);
	const { source } = readIncomeRate(ns);
	const timeFor = (amount) => (amount <= 0 ? "now" : income > 0 ? ns.format.time((amount / income) * 1000) : "never (no income)");

	ns.tprint(`${plan.length} useful augment(s) unlocked, ${queued.length} bought but not installed. Cash ${money(cash)}, ` +
		`income ${money(income)}/s (${source}). Run is ${ns.format.time(sinceInstallMs)} old.`);
	if (plan.length > 0) ns.tprint(`  ${"price now".padStart(10)}  ${"all so far".padStart(10)}  augment   (+ = affordable now)`);
	let total = 0;
	let mult = 1;
	for (const entry of plan) {
		total += entry.price * mult;
		mult *= PRICE_MULT;
		const mark = fit.augs.includes(entry.aug) ? "+" : " ";
		ns.tprint(`${mark} ${money(entry.price).padStart(10)}  ${money(total).padStart(10)}  ${entry.aug} (${sellers.get(entry.aug)}): ${boosts.get(entry.aug)}`);
	}
	if (fit.augs.length < plan.length) {
		ns.tprint(`  All ${plan.length} together: ${money(total)}, ${money(total - cash)} more, about ${timeFor(total - cash)} at current income, if none of it is spent.`);
	}

	const working = Object.entries(rates.perSecond).filter(([, rate]) => rate > 0);
	if (working.length > 0) {
		ns.tprint(`Rep gain: ${working.map(([faction, rate]) => `${faction} ${ns.format.number(rate * 60)}/min`).join(", ")}`);
	}
	if (upcoming.length > 0) {
		const order = [...upcoming].sort((first, second) => (first.etaMs ?? Infinity) - (second.etaMs ?? Infinity) || first.missing - second.missing);
		const eta = (entry) => (entry.etaMs === null ? "not being worked on"
			: `~${ns.format.time(entry.etaMs)}${decision.worth?.includes(entry.aug) ? "" : ", too dear by then"}`);
		ns.tprint(`Next rep unlocks: ${order.slice(0, 3).map((entry) => `${entry.aug} (${entry.faction}, ${ns.format.number(entry.missing)} rep, ${eta(entry)})`).join("; ")}`);
	}
	if (skipped.length > 0) ns.tprint(`Skipped (no hacking/rep stats, use --all to buy): ${skipped.join(", ")}`);

	ns.tprint("");
	if (decision.reset) {
		ns.tprint(`RESET NOW: ${decision.reason}`);
		ns.tprint("  Run buy-augs, then install-augs (auto-reset does both by itself when not in --dry).");
	} else {
		ns.tprint(`WAIT: ${decision.reason}`);
		ns.tprint("  Don't buy yet either: prices only go up, and nothing works until it's installed.");
	}
}
