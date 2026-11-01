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
 * Est. 28GB RAM. It runs once and exits.
 *
 *   run singularity/buy-augs.js                  buy the useful ones you can afford
 *   run singularity/buy-augs.js --dry            list them with what each one boosts, the
 *                                                cost of the whole set and whether to wait
 *   run singularity/buy-augs.js --all            buy every augment, useful or not
 *   run singularity/buy-augs.js --no-neuroflux   skip NeuroFlux Governor
 *   run singularity/buy-augs.js --reserve 1e9    leave $1b untouched
 *   run singularity/buy-augs.js --plan           buy nothing; write what it could buy to
 *                                                data/aug-plan.json (used by auto-reset.js)
 */
export async function main(ns) {
	ns.disableLog("ALL");
	const flags = ns.flags([["dry", false], ["all", false], ["no-neuroflux", false], ["reserve", 0], ["plan", false]]);
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
				if (summary) locked.push({ aug, faction, missing: repNeeded - rep.get(faction) });
				continue;
			}
			if (summary || flags.all) sellers.set(aug, faction);
			else if (!skipped.includes(aug)) skipped.push(aug);
		}
	}
	const byPrice = () => [...sellers.keys()]
		.map((aug) => ({ aug, price: ns.singularity.getAugmentationPrice(aug) }))
		.sort((first, second) => second.price - first.price);

	if (flags.plan) {
		// Same order as a real run: most expensive first, each later one 1.9x dearer.
		const affordable = [];
		let spent = 0;
		let mult = 1;
		for (const entry of byPrice()) {
			if (spent + entry.price * mult > cash()) continue;
			spent += entry.price * mult;
			mult *= PRICE_MULT;
			affordable.push(entry.aug);
		}
		const installed = new Set(ns.singularity.getOwnedAugmentations(false));
		const queued = [...owned].filter((aug) => !installed.has(aug));
		ns.write(PLAN_FILE, JSON.stringify({ time: Date.now(), queued, affordable, cost: spent }), "w");
		return;
	}

	if (flags.dry) {
		// Keep each locked augment once (the faction closest to unlocking it), and drop ones another faction sells.
		const closest = new Map();
		for (const entry of locked) {
			if (sellers.has(entry.aug)) continue;
			if (!closest.has(entry.aug) || entry.missing < closest.get(entry.aug).missing) closest.set(entry.aug, entry);
		}
		showAdvice(ns, byPrice(), cash(), sellers, boosts, skipped, [...closest.values()]);
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
 * The --dry report. Rows are in buy order with the running cost of buying the whole list
 * in that order (the 1.9x increases included), so "buy all N" is the last row's total.
 */
function showAdvice(ns, plan, cash, sellers, boosts, skipped, locked) {
	const money = (amount) => "$" + ns.format.number(amount);
	const { perSecond: income, source } = readIncomeRate(ns); // not getTotalScriptIncome: it misses batcher hacks
	const timeFor = (amount) => (amount <= 0 ? "now" : income > 0 ? ns.format.time((amount / income) * 1000) : "never (no income)");

	let total = 0;
	let mult = 1;
	ns.tprint(`${plan.length} useful augment(s) unlocked. Cash ${money(cash)}, income ${money(income)}/s (${source}).`);
	ns.tprint(`  ${"price now".padStart(10)}  ${"all so far".padStart(10)}  augment`);
	for (const entry of plan) {
		total += entry.price * mult;
		mult *= PRICE_MULT;
		const mark = total <= cash ? "+" : " ";
		ns.tprint(`${mark} ${money(entry.price).padStart(10)}  ${money(total).padStart(10)}  ${entry.aug} (${sellers.get(entry.aug)}): ${boosts.get(entry.aug)}`);
	}

	// What buy-augs would get right now (it skips ones that don't fit and tries cheaper ones).
	let fitCount = 0;
	let fitCost = 0;
	mult = 1;
	for (const entry of plan) {
		if (fitCost + entry.price * mult > cash) continue;
		fitCost += entry.price * mult;
		mult *= PRICE_MULT;
		fitCount++;
	}

	ns.tprint("");
	if (plan.length === 0) {
		ns.tprint("Advice: nothing useful to buy yet.");
	} else if (fitCount === plan.length) {
		ns.tprint(`Advice: you can buy all ${plan.length} now (${money(total)}). Run buy-augs.`);
	} else {
		const wait = timeFor(total - cash);
		ns.tprint(`Advice: ${fitCount} of ${plan.length} fit now (${money(fitCost)}). All ${plan.length} cost ${money(total)}: ` +
			`${money(total - cash)} more, about ${wait} at current income, if none of it is spent.`);
		ns.tprint(`  Buying the ${fitCount} now makes nothing cheaper: augments only work once installed, so if you`);
		ns.tprint(`  aren't resetting yet, wait and buy the whole set together.`);
	}

	if (locked.length > 0) {
		const nearest = locked.sort((first, second) => first.missing - second.missing).slice(0, 3);
		ns.tprint(`Next rep unlocks: ${nearest.map((entry) => `${entry.aug} (${entry.faction}, ${ns.format.number(entry.missing)} rep to go)`).join("; ")}`);
	}
	if (skipped.length > 0) ns.tprint(`Skipped (no hacking/rep stats, use --all to buy): ${skipped.join(", ")}`);
}
