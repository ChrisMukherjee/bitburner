// Design: docs/aug-reset.md
// @ts-check
import { loadConfig } from "/utils/config.js";
import { notify } from "/utils/notify.js";
import { postGate } from "/singularity/ready.js";
import { BASE_PRICE_STEP } from "/utils/aug-price.js";
const GATE_KEY = "donate";
const MONEY_PER_REP = 1e6; // the game's donation rate before the rep multiplier
const MARGIN = 1.01;       // a little extra, in case a BitNode multiplier shrinks donations
const PLAN_FILE = "data/aug-plan.json";
const PLAN_MAX_AGE_MS = 30 * 60_000; // an older plan says nothing about what this reset will buy
const TOP_UPS = 3;         // donate again (at the rate just seen) if the first one fell short

/**
 * One-shot: buys the rep for a key augment (resetRule.keyAugs in the config, The Red Pill by
 * default) with money, once a joined faction that sells it has the favor to take donations
 * (getFavorToDonate, 150). Without this, the favor the Daedalus rule resets for is never used
 * and the next run grinds the rep by work. After the donation the augment is unlocked, so the
 * next auto-reset check (buy-augs.js) finds it ready and resets for it at once.
 *
 * With `augments.donations.anyFaction` it also buys the missing rep for other wanted augments (the plan's
 * `unlockable` list in data/aug-plan.json) at joined factions with the favor, but only from cash beyond the
 * planned purchases (see otherDonation below).
 *
 * Posts on port 33 for startup.js (singularity/ready.js donateReady): done for the run when every
 * key augment is owned or no seller has the favor (favor only changes on an install, and startup
 * clears the gates then); otherwise the cash it needs (0 while the seller hasn't invited you yet).
 *
 *   run /singularity/donate-rep.js             (startup.js runs it every 2 minutes while ready)
 *   run /singularity/donate-rep.js --dry       say what it would donate, donate nothing
 */
/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	const flags = ns.flags([["dry", false]]);
	const money = (amount) => "$" + ns.format.number(amount);
	const keyAugs = loadConfig(ns).augments.resetRule.keyAugs;
	const owned = new Set(ns.singularity.getOwnedAugmentations(true));
	const threshold = ns.getFavorToDonate();
	const player = ns.getPlayer();

	let needCash = Infinity;
	let waiting = false;
	for (const aug of keyAugs.filter((name) => !owned.has(name))) {
		const repNeeded = ns.singularity.getAugmentationRepReq(aug);
		for (const faction of ns.singularity.getAugmentationFactions(aug)) {
			if (ns.singularity.getFactionFavor(faction) < threshold) continue;
			if (!player.factions.includes(faction)) {
				waiting = true; // the favor is there; the invite comes later this run
				continue;
			}
			let missing = repNeeded - ns.singularity.getFactionRep(faction);
			if (missing <= 0) {
				waiting = true; // unlocked: auto-reset buys it on its next check
				continue;
			}
			let perDollar = player.mults.faction_rep / MONEY_PER_REP;
			for (let round = 0; round < TOP_UPS && missing > 0; round++) {
				const amount = Math.ceil((missing / perDollar) * MARGIN);
				const cash = ns.getServerMoneyAvailable("home");
				if (amount > cash) {
					needCash = Math.min(needCash, amount);
					ns.print(`[donate] ${aug}: ${ns.format.number(missing)} ${faction} rep costs ${money(amount)}, have ${money(cash)}`);
					break;
				}
				if (flags.dry) {
					ns.tprint(`donate-rep: would donate ${money(amount)} to ${faction} for ${ns.format.number(missing)} rep (${aug})`);
					break;
				}
				const before = ns.singularity.getFactionRep(faction);
				if (!ns.singularity.donateToFaction(faction, amount)) break;
				const gained = ns.singularity.getFactionRep(faction) - before;
				if (gained > 0) perDollar = gained / amount;
				missing = repNeeded - ns.singularity.getFactionRep(faction);
				if (missing <= 0) notify(ns, "[donate]", `donated ${money(amount)} to ${faction}: ${aug} is unlocked, auto-reset buys it next check`, "success", true);
			}
			if (missing > 0) waiting = true;
		}
	}
	const other = otherDonation(ns, loadConfig(ns).augments.donations, player, threshold, owned, perDollarNow(player));
	if (other) {
		if (other.required > ns.getServerMoneyAvailable("home")) needCash = Math.min(needCash, other.required);
		else if (flags.dry) ns.tprint(`donate-rep: would donate ${money(other.amount)} to ${other.faction} for ${ns.format.number(other.missing)} rep (${other.aug})`);
		else if (ns.singularity.donateToFaction(other.faction, other.amount)) {
			notify(ns, "[donate]", `donated ${money(other.amount)} to ${other.faction} for ${other.aug} (cash beyond this reset's purchases); it is bought on the next reset`, "success", true);
		}
		waiting = true;
	}
	if (flags.dry) return;
	if (Number.isFinite(needCash)) postGate(ns, GATE_KEY, { needCash });
	else if (waiting) postGate(ns, GATE_KEY, { needCash: 0 });
	else postGate(ns, GATE_KEY, { done: true });
}

function perDollarNow(player) {
	return player.mults.faction_rep / MONEY_PER_REP;
}

/**
 * The best wanted augment (besides the key ones) whose faction rep money can unlock, or null. Needs
 * `augments.donations.anyFaction`, a plan from the last 30 minutes, a joined faction with the favor, and cash for the
 * donation plus everything the reset already plans to buy plus this augment at the price after those
 * (times `safety`), so a donation never takes money from augments that were affordable. Picks the most
 * augment value per dollar of donation + price. Returns { aug, faction, missing, amount, required }.
 */
export function otherDonation(ns, settings, player, threshold, owned, perDollar) {
	if (!settings?.anyFaction) return null;
	let plan = null;
	try {
		plan = JSON.parse(ns.read(PLAN_FILE) || "null");
	} catch {
		return null;
	}
	if (!plan || Date.now() - (plan.checkedAt ?? 0) > PLAN_MAX_AGE_MS || !Array.isArray(plan.unlockable)) return null;
	// This augment's price after the planned purchases. The game's price already counts the augments bought but not
	// installed, so only the planned ones raise it further, each by the run's price step (buy-augs.js writes it: 1.9,
	// less with Source-File 11; an older plan without it means 1.9).
	const planned = plan.affordable?.length ?? 0;
	const priceStep = plan.priceStep ?? BASE_PRICE_STEP;
	const planCost = plan.cost ?? 0;
	let best = null;
	for (const entry of plan.unlockable) {
		if (owned.has(entry.aug) || !player.factions.includes(entry.faction)) continue;
		if (ns.singularity.getFactionFavor(entry.faction) < threshold) continue;
		const missing = entry.repNeeded - ns.singularity.getFactionRep(entry.faction);
		if (missing <= 0) continue;
		const amount = Math.ceil((missing / perDollar) * MARGIN);
		const price = ns.singularity.getAugmentationPrice(entry.aug) * priceStep ** planned;
		const required = (planCost + amount + price) * (settings.safety ?? 1.25);
		const score = (entry.value ?? 0) / (amount + price);
		if (!best || score > best.score) best = { aug: entry.aug, faction: entry.faction, missing, amount, required, score };
	}
	return best;
}
