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
import { pickStage, budgetFor, nextPurchase, AUG_VALUE_PORT } from "/sleeves/plan.js";

const SCRIPT = "sleeves/sleeve-shop.js";
const TAG = "[sleeves]";
const MAX_BUYS = 25;                  // purchases per pass
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
	const stage = pickStage(rule.buying, readIncomeRate(ns).perSecond);
	let budget = budgetFor(ns.getPlayer().money, stage);
	let count = ns.sleeve.getNumSleeves();
	const bought = [];

	// Augmentations on offer, with their values (asked from the Singularity API once per few hours).
	let augs = [];
	if (rule.buy.augments) {
		augs = offers(ns, count);
		const values = await augValues(ns, info, [...new Set(augs.map((aug) => aug.name))]);
		for (const aug of augs) aug.value = values[aug.name];
	}

	for (let step = 0; step < MAX_BUYS; step++) {
		const memory = [];
		if (canBuy && rule.buy.memory) {
			for (let index = 0; index < count; index++) memory.push({ index, memory: ns.sleeve.getSleeve(index).memory, cost: ns.sleeve.getMemoryUpgradeCost(index, 1) });
		}
		const sleeveCost = canBuy && rule.buy.sleeves ? ns.sleeve.getSleeveCost() : Infinity;
		const next = nextPurchase({ budget, canBuy, buy: rule.buy, sleeveCost, memory, augs });
		if (!next) break;
		if (next.type === "sleeve") {
			if (!ns.sleeve.purchaseSleeve().success) break;
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
	}

	const summary = bought.length ? `bought ${bought.length}: ${bought.slice(0, 4).join(", ")}${bought.length > 4 ? ", ..." : ""}` : `nothing bought (stage ${stage.name}, budget $${ns.format.number(budget)})`;
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
