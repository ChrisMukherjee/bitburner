// utils/aug-price.js: the augmentation price step (1.9, less with Source-File 11), and the scripts that price a batch
// with it: singularity/buy-augs.js, singularity/donate-rep.js and singularity/workers/faction-goals.js. Each used 1.9
// whatever Source-File 11 said. (The Bladeburner route model's step is in bladeburner.test.mjs.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { loadConfig } from "/utils/config.js";
import { BASE_PRICE_STEP, augPriceStep } from "/utils/aug-price.js";
import { setAugConfig, whatFits, cheapestFill } from "/singularity/buy-augs.js";
import { otherDonation } from "/singularity/donate-rep.js";
import { main as factionGoals, GOALS_PORT } from "/singularity/workers/faction-goals.js";

const close = (actual, expected, what = "") => assert.ok(Math.abs(actual - expected) < 1e-9, `${what} ${actual} != ${expected}`);
const withSF11 = (level) => new Map([[1, 3], [11, level]]);

test("the price step is 1.9, and 0.96, 0.94 and 0.93 of that at Source-File 11 levels 1 to 3 (the game's numbers)", () => {
	assert.equal(BASE_PRICE_STEP, 1.9);
	close(augPriceStep(new Map()), 1.9);
	close(augPriceStep(null), 1.9, "no Source-Files known");
	close(augPriceStep(new Map([[1, 3], [5, 1]])), 1.9, "other Source-Files");
	close(augPriceStep(withSF11(1)), 1.824);
	close(augPriceStep(withSF11(2)), 1.786);
	close(augPriceStep(withSF11(3)), 1.767);
});

test("regression: buy-augs plans the batch with the run's price step (it always used 1.9)", (t) => {
	const augments = loadConfig(fakeNs()).augments;
	t.after(() => setAugConfig(augments)); // back to 1.9
	const plan = [{ aug: "A", price: 100 }, { aug: "B", price: 50 }, { aug: "C", price: 10 }];
	const pool = [{ aug: "d", price: 1000 }, { aug: "c", price: 30 }, { aug: "a", price: 10 }, { aug: "b", price: 20 }];

	setAugConfig(augments);
	assert.deepEqual(whatFits(plan, 220).augs, ["A", "B"], "C would cost 10 x 1.9^2 = 36.1 more: 231.1 in all");
	assert.deepEqual(cheapestFill(pool, 100, 3), ["a", "b"], "a, b and c in price order cost 104.1");

	setAugConfig(augments, augPriceStep(withSF11(3)));
	const fit = whatFits(plan, 220);
	assert.deepEqual(fit.augs, ["A", "B", "C"]);
	close(fit.cost, 100 + 50 * 1.767 + 10 * 1.767 ** 2, "cost");
	close(fit.mult, 1.767 ** 3, "price multiplier after the batch");
	assert.deepEqual(cheapestFill(pool, 100, 3), ["a", "b", "c"], "30 + 20 x 1.767 + 10 x 1.767^2 = 96.6");
});

/** donate-rep's view of one wanted augment at a joined faction with the favor; the game prices it at 100 today. */
function donationWorld(plan) {
	return fakeNs({
		files: { "data/aug-plan.json": JSON.stringify({ checkedAt: Date.now(), unlockable: [{ aug: "U", faction: "F", repNeeded: 10, value: 1 }], ...plan }) },
		overrides: {
			singularity: { getFactionFavor: () => 200, getFactionRep: () => 0, getAugmentationPrice: () => 100 },
		},
	});
}
const donation = (ns) => otherDonation(ns, { anyFaction: true, safety: 1 }, { factions: ["F"] }, 150, new Set(), 1);

test("regression: donate-rep prices the augment after the planned purchases only, at the plan's price step", () => {
	// The game's price (100) already counts the three augments bought but not installed. The old code raised it again
	// for them, at 1.9: 100 x 1.9^5 = 2476 instead of 100 x 1.767^2 = 312.
	const other = donation(donationWorld({ affordable: ["X", "Y"], queued: ["Q1", "Q2", "Q3"], cost: 1000, priceStep: 1.767 }));
	assert.equal(other.aug, "U");
	assert.equal(other.amount, 11, "10 rep at 1 rep per dollar, plus 1%, rounded up");
	close(other.required, 1000 + 11 + 100 * 1.767 ** 2, "required cash");
	// A plan written before buy-augs.js recorded the step means 1.9.
	const older = donation(donationWorld({ affordable: ["X", "Y"], queued: ["Q1", "Q2", "Q3"], cost: 1000 }));
	close(older.required, 1000 + 11 + 100 * 1.9 ** 2, "required cash with an older plan");
});

/** faction-goals.js in a run with `cash`, two wanted augments at faction F ($100 and $50) and these Source-Files. */
async function goalsFor(ownedSF, cash) {
	const prices = { A: 100, B: 50 };
	const ns = fakeNs({
		money: cash,
		overrides: {
			args: [JSON.stringify({ factions: ["F"] })],
			getPlayer: () => ({ factions: ["F"] }),
			getResetInfo: () => ({ lastAugReset: Date.now() - 3600_000, ownedSF }),
			getTotalScriptIncome: () => [0, 0],
			singularity: {
				getOwnedAugmentations: () => [],
				getAugmentationsFromFaction: () => ["A", "B"],
				getAugmentationStats: () => ({ hacking: 1.1 }),
				getAugmentationPrice: (aug) => prices[aug],
				getAugmentationRepReq: () => 1000,
				getAugmentationPrereq: () => [],
				getFactionRep: () => 0,
			},
		},
	});
	await factionGoals(ns);
	return ns.portJson(GOALS_PORT).goals.F;
}

test("regression: faction-goals counts the augments the money covers at the run's price step", async () => {
	// $190. B first (same value, cheaper); both, most expensive first, cost 100 + 50 x 1.9 = 195 at 1.9, but
	// 100 + 50 x 1.767 = 188.4 at Source-File 11.3.
	assert.deepEqual(await goalsFor(new Map(), 190), { rep: 1000, aug: "B", count: 1, skipped: 1 });
	const sf11 = await goalsFor(withSF11(3), 190);
	assert.equal(sf11.count, 2);
	assert.equal(sf11.skipped, 0);
});
