// Design: docs/corporation.md
// @ts-check
/**
 * The game's corporation formulas and price tables (bitburner-src v3.0.0: Corporation/helpers.ts, Actions.ts, Division.ts,
 * data/CorporationUpgrades.ts, data/CorporationUnlocks.ts, ResearchMap.ts, data/BaseResearchTree.ts, and the in-game guide
 * "Corporation" under Documentation -> Advanced Mechanics), plus the boost-material optimizer. Pure, 0GB, no imports, so the
 * planner and the tests share one copy. A number here only changes when the game's does.
 */

/** Levelled corporation upgrades: price of the next level is base x mult^level; each level adds `benefit` to a 1x multiplier. */
export const UPGRADES = {
	"Smart Factories": { base: 2e9, mult: 1.06, benefit: 0.03 },
	"Smart Storage": { base: 2e9, mult: 1.06, benefit: 0.1 },
	"Wilson Analytics": { base: 4e9, mult: 2, benefit: 0.005 },
	"Nuoptimal Nootropic Injector Implants": { base: 1e9, mult: 1.06, benefit: 0.1 },
	"Speech Processor Implants": { base: 1e9, mult: 1.06, benefit: 0.1 },
	"Neural Accelerators": { base: 1e9, mult: 1.06, benefit: 0.1 },
	"FocusWires": { base: 1e9, mult: 1.06, benefit: 0.1 },
	"ABC SalesBots": { base: 1e9, mult: 1.07, benefit: 0.01 },
	"Project Insight": { base: 5e9, mult: 1.07, benefit: 0.05 },
};

/** One-time unlocks and their price in corporation funds. */
export const UNLOCKS = {
	"Export": 20e9,
	"Smart Supply": 25e9,
	"Market Research - Demand": 5e9,
	"Market Data - Competition": 5e9,
	"Shady Accounting": 500e12,
	"Government Partnership": 2e15,
	"Warehouse API": 50e9,
	"Office API": 50e9,
};

/** Research: its cost in research points and the research it needs first (null: the root). Product industries also have the uPgrade branch. */
export const RESEARCH = {
	"Hi-Tech R&D Laboratory": { cost: 5e3, after: null },
	"AutoBrew": { cost: 12e3, after: "Hi-Tech R&D Laboratory" },
	"AutoPartyManager": { cost: 15e3, after: "Hi-Tech R&D Laboratory" },
	"Automatic Drug Administration": { cost: 10e3, after: "Hi-Tech R&D Laboratory" },
	"Go-Juice": { cost: 25e3, after: "Automatic Drug Administration" },
	"CPH4 Injections": { cost: 25e3, after: "Automatic Drug Administration" },
	"Drones": { cost: 5e3, after: "Hi-Tech R&D Laboratory" },
	"Drones - Assembly": { cost: 25e3, after: "Drones" },
	"Drones - Transport": { cost: 30e3, after: "Drones" },
	"HRBuddy-Recruitment": { cost: 15e3, after: "Hi-Tech R&D Laboratory" },
	"HRBuddy-Training": { cost: 20e3, after: "HRBuddy-Recruitment" },
	"Market-TA.I": { cost: 20e3, after: "Hi-Tech R&D Laboratory" },
	"Market-TA.II": { cost: 50e3, after: "Market-TA.I" },
	"Overclock": { cost: 15e3, after: "Hi-Tech R&D Laboratory" },
	"Sti.mu": { cost: 30e3, after: "Overclock" },
	"Self-Correcting Assemblers": { cost: 25e3, after: "Hi-Tech R&D Laboratory" },
	"uPgrade: Fulcrum": { cost: 10e3, after: "Hi-Tech R&D Laboratory", productsOnly: true },
	"uPgrade: Capacity.I": { cost: 20e3, after: "uPgrade: Fulcrum", productsOnly: true },
	"uPgrade: Capacity.II": { cost: 30e3, after: "uPgrade: Capacity.I", productsOnly: true },
	"uPgrade: Dashboard": { cost: 5e3, after: "uPgrade: Fulcrum", productsOnly: true },
};

/** The four boost materials and the industry-data key of each one's factor. */
export const BOOSTS = { "Hardware": "hardwareFactor", "Robots": "robotFactor", "AI Cores": "aiCoreFactor", "Real Estate": "realEstateFactor" };
/** Storage space per unit of each boost material (MaterialInfo sizes), used when the game's material data has not been read. */
export const BOOST_SIZES = { "Hardware": 0.06, "Robots": 0.5, "AI Cores": 0.1, "Real Estate": 0.005 };

/** Price of `amount` levels of a levelled upgrade starting at `level` (calculateUpgradeCost). */
export function upgradeCost(name, level, amount = 1) {
	const upgrade = UPGRADES[name];
	if (!upgrade) return Infinity;
	return upgrade.base * upgrade.mult ** level * (1 - upgrade.mult ** amount) / (1 - upgrade.mult);
}

/** Price of growing an office from `size` by `increase` employees (calculateOfficeSizeUpgradeCost; officeInitialCost 4e9). */
export function officeUpgradeCost(size, increase, officeInitialCost = 4e9) {
	if (!(increase > 0)) return 0;
	return officeInitialCost / 0.09 * 1.09 ** (size / 3) * (1.09 ** (increase / 3) - 1);
}

/** Price of `amount` warehouse levels above `level` (upgradeWarehouseCost; warehouseSizeUpgradeCostBase 1e9). */
export function warehouseUpgradeCost(level, amount = 1, base = 1e9) {
	let cost = 0;
	for (let index = 0; index < amount; index++) cost += base * 1.07 ** (level + 1 + index);
	return cost;
}

/** Price of the next Advert for a division that has bought `count` (Division.getAdVertCost). */
export function advertCost(count) {
	return 1e9 * 1.06 ** count;
}

/** A warehouse's size: level x 100 x (1 + 0.1 per Smart Storage level) x the division's research storage multiplier (Warehouse.updateSize). */
export function warehouseSize(level, smartStorageLevel, researchMult = 1) {
	return level * 100 * (1 + UPGRADES["Smart Storage"].benefit * smartStorageLevel) * researchMult;
}

/**
 * The quantities of boost materials that give the highest city production multiplier for `space` units of storage: the
 * in-game guide's closed-form Lagrange solution (Documentation -> Corporation -> Boost material), dropping any material whose
 * share comes out negative (small spaces) and solving again. Materials with no factor for this industry are left out.
 * @param {Record<string, number>} factors material -> its factor for the industry (0 or missing: not a boost here)
 * @param {Record<string, number>} sizes   material -> storage size per unit
 * @param {number} space
 * @returns {Record<string, number>} material -> whole units
 */
export function boostQuantities(factors, sizes, space) {
	let names = Object.keys(factors).filter((name) => factors[name] > 0 && sizes[name] > 0);
	const out = Object.fromEntries(Object.keys(factors).map((name) => [name, 0]));
	if (!(space > 0)) return out;
	while (names.length) {
		const totalFactor = names.reduce((sum, name) => sum + factors[name], 0);
		const totalSize = names.reduce((sum, name) => sum + sizes[name], 0);
		const spaceOf = Object.fromEntries(names.map((name) => {
			const own = factors[name];
			const others = totalFactor - own;
			const otherSizes = totalSize - sizes[name];
			return [name, (space - 500 * (sizes[name] / own * others - otherSizes)) / (totalFactor / own)];
		}));
		const negative = names.filter((name) => spaceOf[name] < 0);
		if (!negative.length) {
			for (const name of names) out[name] = Math.floor(spaceOf[name] / sizes[name]);
			return out;
		}
		names = names.filter((name) => !negative.includes(name));
	}
	return out;
}

/** One city's production multiplier from its boost materials (Division.calculateProductionFactors, before the ^0.73). */
export function cityMult(factors, quantities) {
	let mult = 1;
	for (const [name, factor] of Object.entries(factors)) if (factor > 0) mult *= (0.002 * (quantities[name] ?? 0) + 1) ** factor;
	return mult;
}

/** The division's production multiplier from every city's boosts: the sum of each city's multiplier ^0.73, at least 1. */
export function divisionProductionMult(cityMults) {
	const sum = cityMults.reduce((total, mult) => total + mult ** 0.73, 0);
	return Math.max(1, sum);
}

/**
 * Party spend per employee that brings average morale from `morale` back to `maxMorale` in one cycle (Documentation ->
 * Corporation -> Office: (a k + x/1e6)(1 + x/1e7) = b, solved for x). perfMult is 1.002 under 9 employees, else 1 here
 * (no interns, funds positive).
 */
export function partyCostPerEmployee(morale, maxMorale, perfMult = 1) {
	const ak = morale * perfMult;
	if (ak >= maxMorale) return 0;
	return 500e3 * (Math.sqrt((ak - 10) ** 2 + 40 * maxMorale) - ak - 10);
}

/** Investment round shares and multipliers (data/Constants.ts fundingRoundShares / fundingRoundMultiplier); round is 1-based. */
export const FUNDING_ROUNDS = [{ shares: 0.1, mult: 3 }, { shares: 0.35, mult: 2 }, { shares: 0.25, mult: 2 }, { shares: 0.2, mult: 1.5 }];

/** What an offer of round `round` (1-4) is for a valuation (Corporation.getInvestmentOffer). */
export function offerFor(valuation, round) {
	const entry = FUNDING_ROUNDS[round - 1];
	return entry ? valuation * entry.shares * entry.mult : 0;
}

/**
 * Dividends the player receives per market cycle (Corporation.getCycleDividends): the owned share of rate x profit x 10 s,
 * raised to (1 - tribute modifier).
 */
export function playerDividends(profitPerSecond, rate, ownedShares, totalShares, tributeModifier) {
	const total = rate * profitPerSecond * 10;
	if (!(total > 0) || !(totalShares > 0)) return 0;
	return (ownedShares * total / totalShares) ** (1 - tributeModifier);
}
