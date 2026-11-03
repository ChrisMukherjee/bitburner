// Design: docs/aug-reset.md
import { homeUpgradeBeatsNeuroFlux } from "/singularity/ready.js";
const PLAN_FILE = "data/aug-plan.json";
const NEUROFLUX = "NeuroFlux Governor";
const MAX_PLAN_AGE_MS = 10 * 60_000; // older plans may list augments that are gone or no longer affordable
const PLANNER = "/singularity/buy-augs.js";

/**
 * One-shot: buys the augments that buy-augs.js listed in data/aug-plan.json (`buyList`, every
 * augment it wants that a joined faction has the rep for), most expensive first at today's
 * prices (each purchase makes the rest 1.9x dearer), then NeuroFlux Governor levels from the
 * faction the plan names, while cash lasts and no home RAM or cores upgrade is affordable (that goes first). A purchase that fails (money or a missing
 * prerequisite) is tried again after the next one succeeds.
 *
 * Kept apart from the planner so a 32GB home can plan and buy: buy-augs.js starts this after
 * it has exited, and auto-reset.js runs it after its --plan check. About 9GB.
 * Afterwards it moves what it bought from `affordable` to `queued` in the plan, so
 * install-augs.js can use the plan without running the planner again.
 *
 *   run /singularity/buy-augs.js                          plan, then buy (starts this)
 *   run /singularity/workers/aug-buyer.js [--reserve N]   buy from a plan made in the last 10 min
 */
/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	const flags = ns.flags([["reserve", 0]]);
	const cash = () => ns.getServerMoneyAvailable("home") - flags.reserve;
	const money = (amount) => "$" + ns.format.number(amount);

	let plan = null;
	try {
		plan = JSON.parse(ns.read(PLAN_FILE));
	} catch { /* handled below */ }
	if (!Array.isArray(plan?.buyList) || Date.now() - plan.checkedAt > MAX_PLAN_AGE_MS) {
		ns.tprint(`aug-buyer: no plan from the last ${MAX_PLAN_AGE_MS / 60_000} min in ${PLAN_FILE}. Run ${PLANNER} (it plans, then starts this).`);
		return;
	}
	if (plan.stocks > 0) ns.tprint(`Note: ${money(plan.stocks)} is in stocks and isn't spent here. Run /stocks/stock-trader.js --liquidate first to use it.`);

	const left = new Map(plan.buyList.map((entry) => [entry.aug, entry.faction]));
	const bought = [];
	let progress = true;
	while (progress && left.size > 0) {
		progress = false;
		const byPrice = [...left.keys()]
			.map((aug) => ({ aug, price: ns.singularity.getAugmentationPrice(aug) }))
			.sort((first, second) => second.price - first.price);
		for (const entry of byPrice.filter((candidate) => candidate.price <= cash())) {
			if (ns.singularity.purchaseAugmentation(left.get(entry.aug), entry.aug)) {
				ns.tprint(`Bought ${entry.aug} from ${left.get(entry.aug)} for ${money(entry.price)}`);
				left.delete(entry.aug);
				bought.push(entry.aug);
				progress = true;
				break; // prices just went up: read them again
			}
		}
	}
	if (left.size > 0) ns.tprint(`Left for later (money or prerequisites): ${[...left.keys()].join(", ")}`);

	// The game refuses once the rep or the money runs out, which ends the loop.
	let neuroflux = 0;
	if (plan.neurofluxFaction) {
		// Cash a home upgrade can use goes to it instead (install-augs.js / startup.js buy it), see ready.js.
		while (ns.singularity.getAugmentationPrice(NEUROFLUX) <= cash() && !homeUpgradeBeatsNeuroFlux(ns, cash())
			&& ns.singularity.purchaseAugmentation(plan.neurofluxFaction, NEUROFLUX)) {
			neuroflux++;
		}
		if (neuroflux === 0 && homeUpgradeBeatsNeuroFlux(ns, cash())) ns.tprint("NeuroFlux skipped: a home upgrade is affordable and gets the cash first.");
	}

	if (bought.length + neuroflux > 0) {
		const queued = new Set([...plan.queued, ...bought]);
		if (neuroflux > 0) queued.add(NEUROFLUX);
		plan.queued = [...queued];
		plan.affordable = plan.affordable.filter((aug) => !queued.has(aug));
		plan.boughtAt = Date.now();
		ns.write(PLAN_FILE, JSON.stringify(plan), "w");
	}
	ns.tprint(`Done: ${bought.length} augment(s) and ${neuroflux} NeuroFlux level(s) bought, cash left ${money(cash() + flags.reserve)}.`);
	if (bought.length + neuroflux > 0) ns.tprint("Run /singularity/install-augs.js when you're ready to install them (this resets the run).");
}
