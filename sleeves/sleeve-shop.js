// Design: docs/sleeves.md
// @ts-check
import { loadConfig } from "/utils/config.js";
import { notify } from "/utils/notify.js";
import { startHelper } from "/utils/start-helper.js";
import { adviseMissing } from "/utils/api-advice.js";
import { sleevesApiFromInfo, sleevesBuyableFromInfo } from "/utils/sleeves.js";
import { singularityFromInfo } from "/utils/singularity.js";
import { readIncomeRate } from "/utils/income.js";
import { postPass } from "/utils/pass-log.js";
import { sleeveHold, postSleeveHold, readSleeveHold, covenantAccess, covenantGap } from "/utils/sleeve-hold.js";
import { pickStage, budgetFor, nextPurchase, AUG_VALUE_PORT } from "/sleeves/plan.js";

const SCRIPT = "sleeves/sleeve-shop.js";
const TAG = "[sleeves]";
const MAX_BUYS = 25;                  // purchases per pass (50 with --spend-all)
const VALUES_MAX_AGE_MS = 3 * 3600_000; // the sleeve augmentations' values are asked for again after this

// The worker that values augmentations (needs the Singularity API); `valuesImports` is what it imports, copied along off home.
export const CONFIG = {
	valuesHelper: "sleeves/workers/aug-values.js",
	valuesImports: ["/utils/config.js", "/config.js", "/utils/notify.js", "/utils/aug-filter.js"],
};

/**
 * One buying pass: sleeves (BitNode 10 only), memory upgrades (BitNode 10 only) and sleeve augmentations, in that order of
 * preference, within the spending stage for the current income (`sleeves.buying`: never below the reserve, at most maxFraction
 * of the cash per pass). Sleeve augmentations are kept through installs. Which augmentation is worth it comes from the stats
 * (`sleeves.augments`) where the Singularity API is cheap enough (1x or 4x); otherwise the cheapest goes first.
 * Design: docs/sleeves.md. About 36GB, for a moment.
 */
/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	const config = loadConfig(ns);
	const rule = config.sleeves;
	if (rule?.enabled === false) return;
	const info = ns.getResetInfo();
	if (!sleevesApiFromInfo(info)) {
		adviseMissing(ns, "sleeves", info, config);
		return;
	}
	const canBuy = sleevesBuyableFromInfo(info);
	// --spend-all [--reserve n]: just before an install (singularity/install-augs.js): the cash would be wiped but sleeves and their
	// augmentations are kept, so everything above the reserve may go.
	const flags = ns.flags([["spend-all", false], ["reserve", 0]]);
	const stage = flags["spend-all"] ? { name: "before install", reserve: Number(flags.reserve) || 0, maxFraction: 1 } : pickStage(rule.buying, readIncomeRate(ns).perSecond);
	const cash = ns.getPlayer().money;
	let budget = budgetFor(cash, stage);
	// A sleeve is permanent and the Covenant's price is far above any stage's share of the cash, so it may use more of it.
	const sleeveShare = budgetFor(cash, { reserve: stage.reserve, maxFraction: rule.sleeveFraction ?? 1 });
	let spent = 0;
	let count = ns.sleeve.getNumSleeves();
	const bought = [];
	let refused = "";

	// Augmentations on offer, with their values (asked from the Singularity API once per few hours).
	let augs = [];
	if (rule.buy.augments) {
		augs = offers(ns, count);
		const values = await augValues(ns, info, [...new Set(augs.map((aug) => aug.name))]);
		for (const aug of augs) aug.value = values[aug.name];
	}

	for (let step = 0; step < MAX_BUYS * (flags["spend-all"] ? 2 : 1); step++) {
		const memory = [];
		if (canBuy && rule.buy.memory) {
			for (let index = 0; index < count; index++) memory.push({ index, memory: ns.sleeve.getSleeve(index).memory, cost: ns.sleeve.getMemoryUpgradeCost(index, 1) });
		}
		const sleeveCost = canBuy && rule.buy.sleeves ? ns.sleeve.getSleeveCost() : Infinity;
		const next = nextPurchase({ budget, sleeveBudget: sleeveShare - spent, canBuy, buy: rule.buy, sleeveCost, memory, augs });
		if (!next) break;
		if (next.type === "sleeve") {
			const result = ns.sleeve.purchaseSleeve();
			if (!result.success) {
				// Say why (the game only sells to Covenant members), so a stuck shop isn't silent.
				refused = ` The game refused sleeve #${count} ($${ns.format.number(next.cost)}, affordable): ${result.message ?? "no reason given"}.`;
				break;
			}
			count++;
			bought.push(`sleeve #${count - 1} for $${ns.format.number(next.cost)}`);
			notify(ns, TAG, `bought sleeve #${count - 1} for $${ns.format.number(next.cost)}`, "success");
			if (rule.buy.augments) augs = [...augs, ...offers(ns, count).filter((aug) => aug.index === count - 1)];
		} else if (next.type === "memory") {
			if (!ns.sleeve.upgradeMemory(next.index, 1).success) break;
			bought.push(`memory for sleeve #${next.index}`);
		} else {
			if (!ns.sleeve.purchaseSleeveAug(next.index, next.name)) {
				augs = augs.filter((aug) => !(aug.index === next.index && aug.name === next.name));
				continue;
			}
			augs = augs.filter((aug) => !(aug.index === next.index && aug.name === next.name));
			bought.push(`${next.name} for sleeve #${next.index}`);
		}
		budget -= next.cost;
		spent += next.cost;
	}

	// Whether the next sleeve is worth keeping this BitNode open for (utils/sleeve-hold.js; auto-destroy, auto-reset and the spenders read it).
	let holdNote = "";
	if (canBuy) {
		const player = ns.getPlayer();
		const now = Date.now();
		// How long the player has already been asked to train for the Covenant (the last post's `since`, while it is recent).
		const before = readSleeveHold(ns, now);
		const since = before?.train && typeof before.since === "number" ? before.since : now;
		const decision = sleeveHold({
			cost: rule.buy.sleeves ? ns.sleeve.getSleeveCost() : Infinity, cash: player.money, income: readIncomeRate(ns).perSecond,
			runMs: now - info.lastNodeReset, access: covenantAccess(player), canBuy, missing: covenantGap(player),
			trainingMs: before?.train ? now - since : 0,
		}, rule.hold);
		postSleeveHold(ns, { ...decision, progress: rule.hold?.progress, since: decision.train ? since : null });
		if (decision.hold) holdNote = ` Holding BitNode 10: ${decision.reason}.`;
		else if (decision.train) holdNote = ` ${decision.reason}.`;
		else if (decision.cost !== null) holdNote = ` Not holding BitNode 10: ${decision.reason}.`;
	}

	const summary = (bought.length ? `bought ${bought.length}: ${bought.slice(0, 4).join(", ")}${bought.length > 4 ? ", ..." : ""}` : `nothing bought (stage ${stage.name}, budget $${ns.format.number(budget)})`) + refused + holdNote;
	postPass(ns, SCRIPT, [summary]);
	ns.print(`${TAG} ${summary}`);
}

/** What the game offers each sleeve: [{ index, name, cost }]. */
function offers(ns, count) {
	const found = [];
	for (let index = 0; index < count; index++) {
		for (const aug of ns.sleeve.getSleevePurchasableAugs(index)) found.push({ index, name: aug.name, cost: aug.cost, value: /** @type {number | undefined} */ (undefined) });
	}
	return found;
}

/**
 * The worth of each augmentation name ({ name: value }), from port 42 when it is recent, else from aug-values.js (Singularity,
 * only at 4x RAM or less). Names with no value stay out, and the shop treats them as worth 1 (cheapest first).
 */
async function augValues(ns, info, names) {
	const read = () => {
		try {
			const posted = JSON.parse(ns.peek(AUG_VALUE_PORT));
			return posted?.time >= Date.now() - VALUES_MAX_AGE_MS && posted.time >= info.lastNodeReset ? posted.values ?? {} : {};
		} catch {
			return {};
		}
	};
	let values = read();
	const missing = names.filter((name) => !(name in values));
	const singularity = singularityFromInfo(info);
	if (missing.length && singularity.available && singularity.ramMultiplier <= 4) {
		const pid = startHelper(ns, CONFIG.valuesHelper, CONFIG.valuesImports, JSON.stringify(missing));
		if (pid !== 0) {
			while (ns.isRunning(pid)) await ns.sleep(100);
			values = read();
		}
	}
	return values;
}
