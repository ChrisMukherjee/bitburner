const NEUROFLUX = "NeuroFlux Governor";
const PLAN_FILE = "data/aug-plan.json";
const PRICE_MULT = 1.9; // every purchase multiplies the price of the rest

/**
 * Buys every augment you have the rep for, most expensive first (each purchase raises
 * the price of the rest by 1.9x, so the big ones go first), then spends what's left on
 * NeuroFlux Governor levels. It doesn't install them: run install-augs.js for that.
 *
 * Prerequisites aren't looked up (getAugmentationPrereq would cost another 5GB). A
 * purchase that fails is simply retried after the next one succeeds, so e.g. Cranial
 * Signal Processors Gen II goes through once Gen I is bought.
 *
 * Est. 23GB RAM, so it needs a 32GB home. It runs once and exits.
 *
 *   run singularity/buy-augs.js                  buy everything affordable
 *   run singularity/buy-augs.js --dry            only show what it would buy
 *   run singularity/buy-augs.js --no-neuroflux   skip NeuroFlux Governor
 *   run singularity/buy-augs.js --reserve 1e9    leave $1b untouched
 *   run singularity/buy-augs.js --plan           buy nothing; write what it could buy to
 *                                                data/aug-plan.json (used by auto-reset.js)
 */
export async function main(ns) {
	ns.disableLog("ALL");
	const flags = ns.flags([["dry", false], ["no-neuroflux", false], ["reserve", 0], ["plan", false]]);
	const cash = () => ns.getServerMoneyAvailable("home") - flags.reserve;
	const money = (amount) => "$" + ns.format.number(amount);

	const factions = ns.getPlayer().factions;
	const owned = new Set(ns.singularity.getOwnedAugmentations(true));
	const rep = new Map(factions.map((faction) => [faction, ns.singularity.getFactionRep(faction)]));

	// Augment -> a joined faction with enough rep to sell it.
	const sellers = new Map();
	for (const faction of factions) {
		for (const aug of ns.singularity.getAugmentationsFromFaction(faction)) {
			if (aug === NEUROFLUX || owned.has(aug) || sellers.has(aug)) continue;
			if (rep.get(faction) >= ns.singularity.getAugmentationRepReq(aug)) sellers.set(aug, faction);
		}
	}

	if (flags.plan) {
		// Same order as a real run: most expensive first, each later one 1.9x dearer.
		const byPrice = [...sellers.keys()]
			.map((aug) => ({ aug, price: ns.singularity.getAugmentationPrice(aug) }))
			.sort((first, second) => second.price - first.price);
		const affordable = [];
		let spent = 0;
		let mult = 1;
		for (const entry of byPrice) {
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
		const plan = [...sellers.keys()]
			.map((aug) => ({ aug, price: ns.singularity.getAugmentationPrice(aug) }))
			.sort((first, second) => second.price - first.price);
		ns.tprint(`${plan.length} augment(s) available, cash ${money(cash())}. Prices before the 1.9x increases:`);
		for (const entry of plan) ns.tprint(`  ${money(entry.price).padStart(10)}  ${entry.aug} (${sellers.get(entry.aug)})`);
		return;
	}

	let bought = 0;
	let progress = true;
	while (progress && sellers.size > 0) {
		progress = false;
		const byPrice = [...sellers.keys()]
			.map((aug) => ({ aug, price: ns.singularity.getAugmentationPrice(aug) }))
			.filter((entry) => entry.price <= cash())
			.sort((first, second) => second.price - first.price);
		for (const entry of byPrice) {
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
