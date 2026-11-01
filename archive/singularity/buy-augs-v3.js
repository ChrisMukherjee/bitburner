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
 *   run singularity/buy-augs.js --dry            list them with what each one boosts
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
	for (const faction of factions) {
		for (const aug of ns.singularity.getAugmentationsFromFaction(faction)) {
			if (aug === NEUROFLUX || owned.has(aug) || sellers.has(aug) || boosts.has(aug)) continue;
			const summary = describeBoosts(ns, aug);
			boosts.set(aug, summary);
			if (rep.get(faction) < ns.singularity.getAugmentationRepReq(aug)) continue;
			if (summary || flags.all) sellers.set(aug, faction);
			else skipped.push(aug);
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
		const plan = byPrice();
		ns.tprint(`${plan.length} useful augment(s) unlocked, cash ${money(cash())}. Prices before the 1.9x increases:`);
		for (const entry of plan) {
			ns.tprint(`  ${money(entry.price).padStart(10)}  ${entry.aug} (${sellers.get(entry.aug)}): ${boosts.get(entry.aug) || "no hacking stats"}`);
		}
		if (skipped.length > 0) ns.tprint(`Skipped (no hacking/rep stats, use --all to buy): ${skipped.join(", ")}`);
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
