// The corporation's formulas (corp/formulas.js), the planner's rules (corp/plan.js), the capability helper
// (utils/corporation.js) and the startup ready check (corp/ready.js). The manager's loop against a simulated corporation
// is in tests/corp-sim.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { CITIES as SIM_CITIES, INDUSTRIES, SIZES, PRICES } from "./support/fake-corp.mjs";
import { loadConfig } from "/utils/config.js";
import {
	UPGRADES, upgradeCost, officeUpgradeCost, warehouseUpgradeCost, advertCost, warehouseSize, boostQuantities, cityMult,
	divisionProductionMult, partyCostPerEmployee, FUNDING_ROUNDS, offerFor, playerDividends, BOOSTS,
} from "/corp/formulas.js";
import {
	CITIES, packBatches, distribute, acceptOffer, offerGrowth, dividendRate, priceStep, exportRoutes, researchPhase, planCorp,
	newMemory, nextProductName, readDivisionCalls, assembleSnapshot, activeRoles,
} from "/corp/plan.js";
import { corpApiFromInfo, seedMoneyFromInfo, corpApisFreeFromInfo, createRefusal } from "/utils/corporation.js";
import { corpReady } from "/corp/ready.js";

const config = loadConfig(fakeNs());
const settings = config.corp;
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) <= Math.abs(expected) * 1e-9 + 1e-9, `${message}: ${actual} vs ${expected}`);

// ---- formulas (game)
test("game: a levelled upgrade's price for several levels is the sum of each level's base x mult^level", () => {
	for (const name of Object.keys(UPGRADES)) {
		const { base, mult } = UPGRADES[name];
		const each = [5, 6, 7].reduce((sum, level) => sum + base * mult ** level, 0);
		close(upgradeCost(name, 5, 3), each, name);
	}
});

test("game: office growth price (calculateOfficeSizeUpgradeCost) adds up step by step, and 3 -> 6 costs 4e9 x 1.09 / 0.09 x 0.09", () => {
	close(officeUpgradeCost(3, 6), officeUpgradeCost(3, 3) + officeUpgradeCost(6, 3), "growing 3 then 3 costs what growing 6 at once does");
	close(officeUpgradeCost(3, 3), 4e9 / 0.09 * 1.09 * 0.09, "the formula at size 3, +3");
	assert.equal(officeUpgradeCost(3, 0), 0);
});

test("game: warehouse levels cost 1e9 x 1.07^(level+1) each; adverts 1e9 x 1.06^count; size is level x 100 x Smart Storage", () => {
	close(warehouseUpgradeCost(1, 2), 1e9 * 1.07 ** 2 + 1e9 * 1.07 ** 3, "two levels above level 1");
	close(advertCost(3), 1e9 * 1.06 ** 3, "the fourth advert");
	close(warehouseSize(3, 2), 3 * 100 * 1.2, "level 3 with Smart Storage 2");
});

test("game: the party that restores morale solves (morale x perf + x/1e6)(1 + x/1e7) = max", () => {
	for (const [morale, max, perf] of [[80, 100, 1], [95, 100, 1.002], [50, 120, 1]]) {
		const x = partyCostPerEmployee(morale, max, perf);
		close((morale * perf + x / 1e6) * (1 + x / 1e7), max, `morale ${morale} -> ${max}`);
	}
	assert.equal(partyCostPerEmployee(100, 100), 0, "no party at full morale");
});

test("game: investment offers are valuation x the round's share x its multiplier; dividends are the owned share ^ (1 - tribute)", () => {
	FUNDING_ROUNDS.forEach((round, index) => close(offerFor(1e12, index + 1), 1e12 * round.shares * round.mult, `round ${index + 1}`));
	assert.equal(offerFor(1e12, 5), 0, "there is no fifth round");
	close(playerDividends(1e6, 0.5, 1e9, 1.5e9, 0.15), (1e9 * 0.5 * 1e6 * 10 / 1.5e9) ** 0.85, "half of 10s of $1m/s profit, two thirds owned");
	assert.equal(playerDividends(-5, 0.5, 1, 1, 0.1), 0);
});

test("game: boost materials from the guide's closed form: within the space, best mix (no small move of space between two raises production)", () => {
	const factors = Object.fromEntries(Object.entries(BOOSTS).map(([material, key]) => [material, INDUSTRIES.Agriculture[key]]));
	for (const space of [50, 500, 5000]) {
		const units = boostQuantities(factors, SIZES, space);
		const used = Object.entries(units).reduce((sum, [material, count]) => sum + count * SIZES[material], 0);
		assert.ok(used <= space + 1e-9, `uses at most the space (${used} of ${space})`);
		assert.ok(Object.values(units).every((count) => count >= 0 && Number.isInteger(count)));
		const best = cityMult(factors, units);
		for (const from of Object.keys(units)) {
			for (const to of Object.keys(units)) {
				if (from === to || units[from] < 1) continue;
				const moved = { ...units };
				const room = Math.min(units[from], Math.ceil(space * 0.01 / SIZES[from]));
				moved[from] -= room;
				moved[to] += Math.floor(room * SIZES[from] / SIZES[to]);
				assert.ok(cityMult(factors, moved) <= best * (1 + 1e-6), `moving ${from} space to ${to} at ${space} does not do better`);
			}
		}
	}
	assert.deepEqual(boostQuantities({ Hardware: 0, Robots: 0.5 }, SIZES, 100), { Hardware: 0, Robots: 200 }, "a material with no factor gets nothing");
});

test("game: a division's production multiplier sums each city's ^0.73 and is at least 1", () => {
	close(divisionProductionMult([16, 16]), 2 * 16 ** 0.73, "two cities");
	assert.equal(divisionProductionMult([]), 1);
});

// ---- capability helper
test("game: the Corporation API works in BitNode 3 or with Source-File 3; seed money only in BitNode 3; free APIs in BitNode 3 or at SF3.3", () => {
	const info = (node, sf3) => ({ currentNode: node, ownedSF: new Map(sf3 ? [[3, sf3]] : []) });
	assert.equal(corpApiFromInfo(info(3, 0)), true);
	assert.equal(corpApiFromInfo(info(1, 1)), true);
	assert.equal(corpApiFromInfo(info(1, 0)), false);
	assert.equal(seedMoneyFromInfo(info(1, 3)), false);
	assert.equal(corpApisFreeFromInfo(info(1, 2)), false);
	assert.equal(corpApisFreeFromInfo(info(1, 3)), true);
	assert.match(createRefusal("DisabledBySoftCap"), /does not allow/);
});

test("corpReady: off with the kill switch or without the API; on with a corporation, on seed money, or once cash covers selfFundCash x $150b", () => {
	const ns = ({ node = 3, sf = [], has = false, check = "Success", money = 0 }) => fakeNs({
		money, overrides: {
			getResetInfo: () => ({ currentNode: node, ownedSF: new Map(sf) }),
			corporation: { hasCorporation: () => has, canCreateCorporation: () => check },
		},
	});
	assert.equal(corpReady(ns({}), config), true, "BitNode 3: seed money");
	assert.equal(corpReady(ns({}), { corp: { ...settings, enabled: false } }), false, "kill switch");
	assert.equal(corpReady(ns({ node: 1 }), config), false, "no Source-File 3");
	assert.equal(corpReady(ns({ node: 1, sf: [[3, 1]], has: true }), config), true, "a corporation exists");
	assert.equal(corpReady(ns({ node: 9, check: "DisabledBySoftCap" }), config), false, "the game refuses");
	const cost = 150e9 * settings.selfFundCash;
	assert.equal(corpReady(ns({ node: 1, sf: [[3, 1]], money: cost - 1 }), config), false, "short of selfFundCash x the price");
	assert.equal(corpReady(ns({ node: 1, sf: [[3, 1]], money: cost }), config), true);
	assert.equal(corpReady(ns({ node: 1, sf: [[3, 1]], money: cost }), { corp: { ...settings, selfFund: false } }), false, "selfFund off");
});

// ---- running calls
test("packBatches keeps the calls in order, charges each function once per batch, and never goes over the RAM (except a lone call)", () => {
	const cost = (name) => (name.startsWith("get") ? 10 : 20);
	const calls = [["getA"], ["getA"], ["doB"], ["getC"], ["doB"], ["doD"], ["getA"]];
	const batches = packBatches(calls, cost, 45, 1.6);
	assert.deepEqual(batches.flatMap((batch) => batch.calls), calls, "order and every call kept");
	for (const batch of batches) {
		const names = [...new Set(batch.calls.map((call) => call[0]))];
		close(batch.ram, 1.6 + names.reduce((sum, name) => sum + cost(name), 0), "base + each distinct function once");
		assert.ok(batch.ram <= 45);
	}
	assert.deepEqual(packBatches([["doHuge"]], () => 100, 45, 1.6), [{ calls: [["doHuge"]], ram: 101.6 }], "a call that fits nowhere still gets a batch");
});

test("readDivisionCalls reads materials only where the last pass found a warehouse (all cities when nothing is known yet)", () => {
	const divisions = { Agriculture: { industry: "Agriculture", cities: ["Sector-12", "Aevum"], products: [], makesProducts: false } };
	const all = readDivisionCalls(divisions, INDUSTRIES, { office: true, warehouse: true });
	const some = readDivisionCalls(divisions, INDUSTRIES, { office: true, warehouse: true }, { Agriculture: ["Sector-12"] });
	const cities = (calls) => [...new Set(calls.filter((call) => call[0] === "corporation.getMaterial").map((call) => call[2]))];
	assert.deepEqual(cities(all), ["Sector-12", "Aevum"]);
	assert.deepEqual(cities(some), ["Sector-12"]);
	assert.ok(some.some((call) => call[0] === "corporation.getWarehouse" && call[2] === "Aevum"), "the warehouse itself is still checked");
	const none = readDivisionCalls(divisions, INDUSTRIES, { office: false, warehouse: false });
	assert.ok(none.every((call) => call[0] === "corporation.hasResearched"), "without the APIs only research is read");
});

test("assembleSnapshot puts each result in its place and leaves failed reads out", () => {
	const calls = [["corporation.getCorporation"], ["corporation.getWarehouse", "Agri", "Aevum"], ["corporation.getMaterial", "Agri", "Sector-12", "Food"]];
	const snap = assembleSnapshot(calls, [{ ok: true, value: { funds: 5 } }, { ok: false, error: "no warehouse" }, { ok: true, value: { stored: 3 } }]);
	assert.equal(snap.corp?.funds, 5);
	assert.deepEqual(snap.divisions.Agri.warehouses, {});
	assert.equal(snap.divisions.Agri.materials["Sector-12"].Food.stored, 3);
});

// ---- rules
test("distribute splits people by weight, exactly, the remainder to the largest fractions", () => {
	assert.deepEqual(distribute(10, { Operations: 1, Engineer: 2, Business: 1, Management: 1 }), { Operations: 2, Engineer: 4, Business: 2, Management: 2 });
	for (const count of [0, 1, 7, 33]) {
		const out = distribute(count, { a: 1, b: 1, c: 3 });
		assert.equal(Object.values(out).reduce((sum, value) => sum + value, 0), count);
	}
});

test("divisions by round: the material division from round 1, the support division from 2, the product division from 3", () => {
	assert.deepEqual(activeRoles(1, settings), ["materials"]);
	assert.deepEqual(activeRoles(2, settings), ["materials", "support"]);
	assert.deepEqual(activeRoles(5, settings), ["materials", "support", "product"]);
	assert.deepEqual(activeRoles(3, { ...settings, industries: { ...settings.industries, support: "" } }), ["materials", "product"], "an empty role is skipped");
});

test("acceptOffer: waits for the setup, the research target and a slowing offer; maxHours and a stuck setup take it anyway", () => {
	const base = { setupDone: true, stuck: false, rpDone: true, growth: 0.05, waited: false, minGrowth: 0.2 };
	assert.equal(acceptOffer(base).accept, true, "growth below the hurdle");
	assert.equal(acceptOffer({ ...base, growth: 0.5 }).accept, false, "still growing fast");
	assert.equal(acceptOffer({ ...base, growth: null }).accept, false, "growth not measured yet");
	assert.equal(acceptOffer({ ...base, rpDone: false }).accept, false, "research below the target");
	assert.equal(acceptOffer({ ...base, rpDone: false, waited: true }).accept, true, "the round's longest wait is over");
	assert.equal(acceptOffer({ ...base, setupDone: false, waited: true }).accept, false, "never before the setup...");
	assert.equal(acceptOffer({ ...base, setupDone: false, stuck: true }).accept, true, "...unless only the offer can pay for it");
});

test("offerGrowth is null until the history spans the window, then the relative growth per hour", () => {
	const window = 10 * 60_000;
	assert.equal(offerGrowth([{ t: 0, funds: 100 }, { t: 60_000, funds: 110 }], 60_000, window), null);
	close(offerGrowth([{ t: 0, funds: 100 }, { t: window, funds: 110 }], window, window) ?? NaN, 0.1 * 6, "10% in 10 minutes is 60% an hour");
});

test("dividendRate keeps enough profit to afford the next want within the wait, pays out the rest up to maxRate", () => {
	assert.equal(dividendRate(0, 1e9, 60, 0.9), 0, "no profit, no dividends");
	assert.equal(dividendRate(1e9, 0, 60, 0.9), 0.9, "nothing wanted: the most allowed");
	assert.equal(dividendRate(1e9, 30e9, 60, 0.9), 0.5, "half of 60 cycles' profit pays for the want");
	assert.equal(dividendRate(1e9, 100e9, 60, 0.9), 0, "a want bigger than the wait's profit keeps everything");
});

test("priceStep finds the highest price that still sells what is made (a market that takes up to 1.5 x made x (5/k)^2)", () => {
	const kStar = 5;
	const limit = kStar * Math.sqrt(1.5); // where the market takes exactly what is made
	const entry = { k: 1, dir: 0, step: settings.price.step };
	let stored = 0;
	const made = 100;
	const ks = [];
	for (let cycle = 0; cycle < 200; cycle++) {
		const available = stored + made;
		const sold = Math.min(available, entry.k <= kStar ? available : (made * 1.5) * (kStar / entry.k) ** 2);
		stored = available - sold;
		priceStep(entry, [{ stored, productionAmount: made / 10, actualSellAmount: sold / 10 }], settings.price);
		ks.push(entry.k);
	}
	const late = ks.slice(-50);
	const step = settings.price.step;
	assert.ok(Math.min(...late) >= limit / step && Math.max(...late) <= limit * step, `stays within one base step of the market's limit (${Math.min(...late)}..${Math.max(...late)})`);
	assert.ok(ks.every((k) => k >= settings.price.minK), "never below the market price");
	// Demand doubles: the old ceiling is wrong now and the price follows
	const kNew = 10;
	for (let cycle = 0; cycle < 200; cycle++) {
		const available = stored + made;
		const sold = Math.min(available, entry.k <= kNew ? available : (made * 1.5) * (kNew / entry.k) ** 2);
		stored = available - sold;
		priceStep(entry, [{ stored, productionAmount: made / 10, actualSellAmount: sold / 10 }], settings.price);
	}
	const newLimit = kNew * Math.sqrt(1.5);
	assert.ok(entry.k >= newLimit / step && entry.k <= newLimit * step, `follows a demand change (${entry.k} for ${newLimit})`);
});

test("exportRoutes: Plants to the product division first, then the support division; the support division's Chemicals back", () => {
	const snap = { industries: INDUSTRIES, divisions: { Agriculture: { industry: "Agriculture" }, Chemical: { industry: "Chemical" }, Tobacco: { industry: "Tobacco" } } };
	const routes = exportRoutes(/** @type {any} */ (snap), { materials: "Agriculture", support: "Chemical", product: "Tobacco" });
	assert.deepEqual(routes, [
		{ from: "Agriculture", material: "Plants", to: ["Tobacco", "Chemical"] },
		{ from: "Chemical", material: "Chemicals", to: ["Agriculture"] },
	]);
});

test("nextProductName takes the next number after the highest", () => {
	assert.equal(nextProductName("Tobacco", []), "Tobacco-1");
	assert.equal(nextProductName("Tobacco", ["Tobacco-3", "Tobacco-7"]), "Tobacco-8");
});

// ---- planCorp
const OFFICE = (size, jobs = {}) => ({ size, numEmployees: Object.values(jobs).reduce((sum, count) => sum + count, 0), avgEnergy: 100, avgMorale: 100, maxEnergy: 100, maxMorale: 100, employeeJobs: jobs });
/** A division as the reads find it, open in `cities` with a warehouse in each. */
function division(name, industry, { cities = SIM_CITIES, size = 4, jobs = { Operations: 1, Engineer: 1, Business: 1, Management: 1 }, rp = 0, adverts = 0, stored = {} } = {}) {
	const data = INDUSTRIES[industry];
	const materials = Object.fromEntries(cities.map((city) => [city, Object.fromEntries(Object.keys(SIZES).map((material) => [material, {
		stored: stored[material] ?? 0, marketPrice: PRICES[material], desiredSellAmount: "MAX", desiredSellPrice: "MP", exports: [], productionAmount: 0, actualSellAmount: 0,
	}]))]));
	return {
		name, industry, awareness: 0, popularity: 0, researchPoints: rp, numAdVerts: adverts, cities: [...cities], products: [], makesProducts: data.makesProducts,
		maxProducts: data.makesProducts ? 3 : 0, lastCycleRevenue: 0, lastCycleExpenses: 0, researched: {},
		offices: Object.fromEntries(cities.map((city) => [city, OFFICE(size, jobs)])),
		warehouses: Object.fromEntries(cities.map((city) => [city, { level: 1, size: 100, sizeUsed: 0, smartSupplyEnabled: true }])),
		materials, productData: {},
	};
}
function snapshot({ funds = 150e9, revenue = 0, expenses = 0, round = 1, offer = 0, unlocks = ["Warehouse API", "Office API", "Smart Supply"], divisions = {} } = {}) {
	return {
		corp: { name: "Corp", funds, revenue, expenses, public: false, numShares: 1e9, totalShares: 1.5e9, valuation: 10e9, dividendRate: 0, divisions: Object.keys(divisions) },
		offer: { funds: offer, shares: 1e8, round }, unlocks: Object.fromEntries(unlocks.map((name) => [name, true])), upgrades: {}, divisions,
		industries: INDUSTRIES, materialSizes: SIZES, maxDivisions: 20,
		constants: { officeInitialCost: 4e9, warehouseInitialCost: 5e9, teaCostPerEmployee: 500e3, bribeThreshold: 100e12, bribeAmountPerReputation: 1e9 },
	};
}
const names = (plan) => plan.calls.map((call) => call[0].replace("corporation.", ""));

test("planCorp without the Office and Warehouse APIs buys them first, and nothing else until it has both", () => {
	const plan = planCorp(/** @type {any} */ (snapshot({ unlocks: [] })), null, config, 1e6);
	assert.deepEqual(plan.calls.slice(0, 2), [["corporation.purchaseUnlock", "Warehouse API"], ["corporation.purchaseUnlock", "Office API"]]);
	const short = planCorp(/** @type {any} */ (snapshot({ funds: 60e9, unlocks: [] })), null, config, 1e6);
	assert.deepEqual(short.calls, [["corporation.purchaseUnlock", "Warehouse API"]], "one API affordable: nothing that needs the other");
});

test("planCorp on a new corporation: the material division, Smart Supply before any new city, and hires onto research while below the round's target", () => {
	const plan = planCorp(/** @type {any} */ (snapshot({ unlocks: ["Warehouse API", "Office API"] })), null, config, 1e6);
	const order = names(plan);
	assert.equal(order[0], "expandIndustry");
	assert.ok(order.indexOf("purchaseUnlock") < order.indexOf("expandCity"), "Smart Supply comes before the cities");
	assert.deepEqual(plan.calls.find((call) => call[0] === "corporation.purchaseUnlock"), ["corporation.purchaseUnlock", "Smart Supply"]);
	assert.equal(plan.calls.filter((call) => call[0] === "corporation.expandCity").length, 5, "the five other cities");
	const hires = plan.calls.filter((call) => call[0] === "corporation.hireEmployee");
	assert.equal(hires.length, 6 * settings.rounds[1].office.materials, "every office filled to the round's size");
	assert.ok(hires.every((call) => call[3] === "Research & Development"), "research points first, as the round's target asks");
});

test("planCorp holds growth spending during a research phase and spends once the target is met", () => {
	const target = settings.rounds[1].rp.materials;
	const below = planCorp(/** @type {any} */ (snapshot({ divisions: { Agriculture: division("Agriculture", "Agriculture", { rp: target / 2, adverts: 2, jobs: { "Research & Development": 4 } }) } })), null, config, 1e6);
	assert.ok(!names(below).some((name) => ["bulkPurchase", "levelUpgrade", "upgradeWarehouse"].includes(name)), "no growth while researching");
	assert.ok(below.lines.some((line) => /research phase/.test(line)));
	const above = planCorp(/** @type {any} */ (snapshot({ divisions: { Agriculture: division("Agriculture", "Agriculture", { rp: target, adverts: 2 }) } })), null, config, 1e6);
	assert.ok(names(above).includes("bulkPurchase"), "boost materials once the target is met");
});

test("researchPhase: the time to the target from the rate measured between passes", () => {
	const snap = snapshot({ divisions: { Agriculture: division("Agriculture", "Agriculture", { rp: 10 }) } });
	const rates = {};
	const first = researchPhase(snap, settings, 1, rates, 0);
	assert.deepEqual(first, { active: true, eta: null, etaSeconds: 0 }, "no rate yet");
	snap.divisions.Agriculture.researchPoints = 15;
	const second = researchPhase(snap, settings, 1, rates, 10_000);
	close(second.etaSeconds, (settings.rounds[1].rp.materials - 15) / 0.5, "5 points in 10 s");
	assert.equal(researchPhase(snap, settings, 3, null, 0).active, false, "no research targets from round 3");
});

test("planCorp keeps the expected loss of a research phase in reserve (the loss per second x the time to the target)", () => {
	const target = settings.rounds[1].rp.materials;
	const make = (rp) => snapshot({ funds: 100e9, expenses: 1e6, divisions: { Agriculture: division("Agriculture", "Agriculture", { rp, adverts: 0, jobs: { "Research & Development": 4 } }) } });
	const memory = newMemory();
	planCorp(/** @type {any} */ (make(0)), memory, config, 0);
	const plan = planCorp(/** @type {any} */ (make(target / 1e4)), memory, config, 10_000);
	// The planner wants adverts (round 1) but holds the loss until the target: target - rp points at rp/10 per second.
	const eta = (target - target / 1e4) / (target / 1e4 / 10);
	const reserve = 1e6 * 10 * settings.reserveCycles + 1e6 * eta;
	assert.ok(reserve > 100e9, "the test's premise: the reserve is more than the funds");
	assert.ok(!names(plan).includes("hireAdVert"), "nothing bought into the reserve");
});

test("planCorp takes an offer when the setup is stuck with no profit to save, but not while profit can pay for it", () => {
	const agri = () => division("Agriculture", "Agriculture", { cities: ["Sector-12"], rp: 100 });
	const stuck = planCorp(/** @type {any} */ (snapshot({ funds: 2e9, offer: 18e9, divisions: { Agriculture: agri() } })), null, config, 1e6);
	assert.ok(names(stuck).includes("acceptInvestmentOffer"), "no profit: the offer is the only way to open the next city");
	const earning = planCorp(/** @type {any} */ (snapshot({ funds: 2e9, offer: 18e9, revenue: 2e5, expenses: 1e5, divisions: { Agriculture: agri() } })), null, config, 1e6);
	assert.ok(!names(earning).includes("acceptInvestmentOffer"), "profit saves for it instead");
	const tiny = planCorp(/** @type {any} */ (snapshot({ funds: 0, offer: 1e9, divisions: { Agriculture: agri() } })), null, config, 1e6);
	assert.ok(!names(tiny).includes("acceptInvestmentOffer"), "an offer that doesn't pay for the next step isn't taken");
});

test("planCorp buys Export with the support division and routes Plants to it", () => {
	const plan = planCorp(/** @type {any} */ (snapshot({ funds: 500e9, round: 2, divisions: { Agriculture: division("Agriculture", "Agriculture", { size: 8, rp: 1000, adverts: 8 }) } })), null, config, 1e6);
	const order = names(plan);
	assert.ok(order.includes("expandIndustry") && plan.calls.some((call) => call[0] === "corporation.purchaseUnlock" && call[1] === "Export"));
	assert.ok(plan.calls.indexOf(plan.calls.find((call) => call[1] === "Export") ?? []) > order.indexOf("expandIndustry"), "Export with the division that needs it");
});

/** A corporation in round 3 with its three divisions set up (offices at the sizes the earlier rounds left, research done). */
function round3({ funds = 50e9, offer = 1e12, isPublic = false, products = {} } = {}) {
	const agri = division("Agriculture", "Agriculture", { size: 8, jobs: { Operations: 2, Engineer: 2, Business: 2, Management: 2 }, rp: 1000 });
	const chem = division("Chemical", "Chemical", { size: 3, jobs: { Operations: 1, Engineer: 1, Business: 1 }, rp: 500 });
	const tob = division("Tobacco", "Tobacco", { size: 3, jobs: { Operations: 1, Engineer: 1, Business: 1 } });
	tob.products = Object.keys(products);
	tob.productData = Object.fromEntries(Object.entries(products).map(([name, rating]) => [name, { "Sector-12": {
		developmentProgress: 100, effectiveRating: rating, desiredSellPrice: "MP", desiredSellAmount: "MAX", stored: 0, productionAmount: 0, actualSellAmount: 0,
	} }]));
	// The guide's exports already in place, so a test sees only what it is about
	for (const city of SIM_CITIES) {
		agri.materials[city].Plants.exports = ["Tobacco", "Chemical"].map((target) => ({ division: target, city, amount: "(IPROD+IINV/10)*(-1)" }));
		chem.materials[city].Chemicals.exports = [{ division: "Agriculture", city, amount: "(IPROD+IINV/10)*(-1)" }];
	}
	const snap = snapshot({ funds, offer, round: 3, unlocks: ["Warehouse API", "Office API", "Smart Supply", "Export"], divisions: { Agriculture: agri, Chemical: chem, Tobacco: tob } });
	snap.corp.public = isPublic;
	return snap;
}

test("products: with every slot full, the lowest-rated product is discontinued and a new one started", () => {
	const plan = planCorp(/** @type {any} */ (round3({ products: { "Tobacco-1": 300, "Tobacco-2": 120, "Tobacco-3": 250 } })), null, config, 1e6);
	assert.deepEqual(plan.calls.filter((call) => call[0] === "corporation.discontinueProduct"), [["corporation.discontinueProduct", "Tobacco", "Tobacco-2"]]);
	const made = plan.calls.find((call) => call[0] === "corporation.makeProduct");
	assert.equal(made?.[3], "Tobacco-4", "the next name after the highest");
	const room = planCorp(/** @type {any} */ (round3({ products: { "Tobacco-1": 300 } })), null, config, 1e6);
	assert.ok(!names(room).includes("discontinueProduct"), "a free slot: nothing discontinued");
});

test("round 3 upgrades: always the cheapest next level", () => {
	const plan = planCorp(/** @type {any} */ (round3()), null, config, 1e6);
	const levels = Object.fromEntries(settings.upgrades.map((name) => [name, 0]));
	const bought = plan.calls.filter((call) => call[0] === "corporation.levelUpgrade" && settings.upgrades.includes(call[1]));
	assert.ok(bought.length > 1, "the test's premise: several levels affordable");
	for (const [, name] of bought) {
		const cheapest = Math.min(...settings.upgrades.map((item) => upgradeCost(item, levels[item])));
		close(upgradeCost(name, levels[name]), cheapest, `${name} at level ${levels[name]} is the cheapest`);
		levels[name]++;
	}
});

test("dummy divisions: bought before going public only while the valuation one adds is worth more than its price", () => {
	const dummy = (snap) => snap.calls.filter((call) => call[0] === "corporation.expandIndustry" && call[1] === settings.industries.dummy);
	assert.equal(dummy(planCorp(/** @type {any} */ (round3({ funds: 500e9, offer: 1e13 })), null, config, 1e6)).length, 1, "a big offer: 10% of it beats the price");
	assert.equal(dummy(planCorp(/** @type {any} */ (round3({ funds: 500e9, offer: 1e11 })), null, config, 1e6)).length, 0, "10% of $100b is less than a six-city division");
	assert.equal(dummy(planCorp(/** @type {any} */ (round3({ funds: 500e9, offer: 1e13, isPublic: true })), null, config, 1e6)).length, 0, "public: no more offers to raise");
	assert.equal(dummy(planCorp(/** @type {any} */ (round3({ funds: 500e9, offer: 1e13 })), null, { corp: { ...settings, dummyDivisions: false } }, 1e6)).length, 0, "switched off");
});

test("exports: routes already in the guide's order are left alone; a wrong order is cancelled and rebuilt", () => {
	const fine = planCorp(/** @type {any} */ (round3()), null, config, 1e6);
	assert.ok(!names(fine).some((name) => /xportMaterial/.test(name)), "nothing to change");
	const snap = round3();
	snap.divisions.Agriculture.materials.Aevum.Plants.exports.reverse();
	const fixed = planCorp(/** @type {any} */ (snap), null, config, 1e6);
	const routes = fixed.calls.filter((call) => /xportMaterial/.test(call[0]));
	assert.deepEqual(routes.map((call) => [call[0].replace("corporation.", ""), call[3]]), [
		["cancelExportMaterial", "Chemical"], ["cancelExportMaterial", "Tobacco"], ["exportMaterial", "Tobacco"], ["exportMaterial", "Chemical"],
	], "only Aevum's Plants, rebuilt product division first");
});

test("morale and energy: a party or tea only once more than keepUpWithin below the maximum", () => {
	const low = round3();
	low.divisions.Agriculture.offices.Aevum.avgMorale = 90;
	low.divisions.Agriculture.offices.Aevum.avgEnergy = 90;
	const plan = planCorp(/** @type {any} */ (low), null, config, 1e6);
	assert.deepEqual(plan.calls.filter((call) => /throwParty|buyTea/.test(call[0])).map((call) => [call[0], call[2]]), [["corporation.buyTea", "Aevum"], ["corporation.throwParty", "Aevum"]]);
	const near = round3();
	near.divisions.Agriculture.offices.Aevum.avgMorale = 100 - settings.keepUpWithin / 2;
	assert.ok(!names(planCorp(/** @type {any} */ (near), null, config, 1e6)).includes("throwParty"), "within keepUpWithin: no party");
});

test("bribes: once the valuation passes the game's threshold, for joined factions short of their goal", () => {
	const make = (valuation) => {
		const snap = round3({ funds: 2e12 });
		snap.corp.valuation = valuation;
		Object.assign(snap, { goals: { Alpha: { rep: 1e6 }, Beta: { rep: 10 }, Gamma: { rep: 1e6 } }, factionRep: { Alpha: 0, Beta: 100, Gamma: 0 }, factions: ["Alpha", "Beta"] });
		return snap;
	};
	const bribes = (plan) => plan.calls.filter((call) => call[0] === "corporation.bribe").map((call) => call[1]);
	assert.deepEqual(bribes(planCorp(/** @type {any} */ (make(1e15)), null, config, 1e6)), ["Alpha"], "Beta has its rep, Gamma isn't joined");
	assert.deepEqual(bribes(planCorp(/** @type {any} */ (make(1e13)), null, config, 1e6)), [], "below the bribe threshold");
});

test("research from round 3: Market-TA.I only together with II, and product-only research never for a material division", () => {
	const snap = round3();
	snap.divisions.Tobacco.researchPoints = 2e5; // the pair (70k) within Market-TA's share of the points
	snap.divisions.Tobacco.researched = { "Hi-Tech R&D Laboratory": true };
	snap.divisions.Agriculture.researchPoints = 1e5;
	snap.divisions.Agriculture.researched = { "Hi-Tech R&D Laboratory": true };
	const plan = planCorp(/** @type {any} */ (snap), null, config, 1e6);
	const of = (name) => plan.calls.filter((call) => call[0] === "corporation.research" && call[1] === name).map((call) => call[2]);
	const tobacco = of("Tobacco");
	assert.ok(tobacco.includes("Market-TA.I") && tobacco.indexOf("Market-TA.II") === tobacco.indexOf("Market-TA.I") + 1, "the pair together");
	assert.ok(!of("Agriculture").some((name) => /^Market-TA|^uPgrade/.test(name)), "Market-TA and uPgrade are for products");
	const poor = round3();
	poor.divisions.Tobacco.researchPoints = 60e3; // TA.I (20k) alone would fit its share (30k), the pair (70k) doesn't
	poor.divisions.Tobacco.researched = { "Hi-Tech R&D Laboratory": true };
	const none = planCorp(/** @type {any} */ (poor), null, config, 1e6).calls.filter((call) => call[0] === "corporation.research" && /^Market/.test(call[2]));
	assert.deepEqual(none, [], "not one without the other");
});

test("product division jobs: the main office spreads over the four production jobs; the others keep one each and the rest research", () => {
	const snap = round3();
	for (const office of Object.values(snap.divisions.Tobacco.offices)) Object.assign(office, { size: 9, numEmployees: 9, employeeJobs: { Unassigned: 9 } });
	const plan = planCorp(/** @type {any} */ (snap), null, config, 1e6);
	const jobs = (city) => Object.fromEntries(plan.calls.filter((call) => call[0] === "corporation.setJobAssignment" && call[1] === "Tobacco" && call[2] === city && call[4] > 0).map((call) => [call[3], call[4]]));
	assert.deepEqual(jobs(settings.mainCity), distribute(9, { Operations: 1, Engineer: 1, Business: 1, Management: 1 }));
	assert.deepEqual(jobs("Aevum"), { Operations: 1, Engineer: 1, Business: 1, Management: 1, "Research & Development": 5 });
});

test("going public: after the fourth round with no new shares, unless corp.ipo is off", () => {
	const after = () => { const snap = round3(); snap.offer = { funds: 0, shares: 0, round: 5 }; return snap; };
	assert.deepEqual(planCorp(/** @type {any} */ (after()), null, config, 1e6).calls.filter((call) => call[0] === "corporation.goPublic"), [["corporation.goPublic", 0]]);
	assert.ok(!names(planCorp(/** @type {any} */ (after()), null, { corp: { ...settings, ipo: false } }, 1e6)).includes("goPublic"));
	assert.ok(!names(planCorp(/** @type {any} */ (round3()), null, config, 1e6)).includes("goPublic"), "not while an offer is open");
});

test("choice: the corp defaults: on, accepting offers and going public, the in-game guide's research targets (55; 700 and 390)", () => {
	assert.equal(settings.enabled, true);
	assert.equal(settings.acceptOffers, true);
	assert.equal(settings.ipo, true);
	assert.deepEqual([settings.rounds[1].rp.materials, settings.rounds[2].rp.materials, settings.rounds[2].rp.support], [55, 700, 390]);
	assert.deepEqual(settings.industries, { materials: "Agriculture", support: "Chemical", product: "Tobacco", dummy: "Restaurant" });
	assert.equal(CITIES.length, 6);
});
