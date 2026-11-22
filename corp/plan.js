// Design: docs/corporation.md
// @ts-check
import {
	UPGRADES, UNLOCKS, RESEARCH, BOOSTS, BOOST_SIZES, upgradeCost, officeUpgradeCost, warehouseUpgradeCost, advertCost,
	boostQuantities, cityMult, partyCostPerEmployee,
} from "/corp/formulas.js";

/**
 * The corporation manager's decisions, as pure functions of plain values (0GB), so `npm test` covers them and
 * corp/corp-manager.js only reads the game and carries the calls out. Design: docs/corporation.md.
 *
 * A call is an array: [the function's name under ns ("corporation.expandCity"), ...its arguments]. The manager runs a list
 * of them with corp/workers/call.js, as few workers as the free RAM allows (packBatches), in order.
 *
 * Ports (written and read by the corp/ scripts):
 *   48 summary { time, title, script, lines, memory }, shown by `status` (memory: what the planner keeps between passes)
 *   49 a worker's results: JSON [{ ok, value } | { ok: false, error }], one per call, in order
 */
export const SUMMARY_PORT = 48;
export const RESULT_PORT = 49;

/** The six cities (CityName), in the order offices are opened. */
export const CITIES = ["Sector-12", "Aevum", "Chongqing", "New Tokyo", "Ishima", "Volhaven"];
/** Jobs the planner fills (Intern and Unassigned are always set to 0). */
export const JOBS = ["Operations", "Engineer", "Business", "Management", "Research & Development"];
/** The in-game guide's export amount: this cycle's consumption plus a tenth of the stock already there (Miscellany -> Export). */
export const EXPORT_AMOUNT = "(IPROD+IINV/10)*(-1)";
/** A city's production multiplier grows by 1.1^(1/12) per office or warehouse, so a new 6-city division (12) adds 10% (determineCycleValuation). */
const VALUATION_PER_FACILITY = 1.0079741404289038;
/** One market cycle is 10 seconds of game time (secondsPerMarketCycle). */
const SECONDS_PER_CYCLE = 10;
/**
 * How long after a research phase the last cycle's profit is still the phase's: new jobs start at the next START, produce
 * in that cycle, and show in the profit read at the START after (3 cycles leaves one spare).
 */
const SETTLE_MS = 3 * SECONDS_PER_CYCLE * 1000;

/**
 * @typedef {{ funds: number, revenue: number, expenses: number, public: boolean, numShares: number, totalShares: number,
 *   valuation: number, dividendRate: number, tributeModifier?: number, divisions: string[], [key: string]: any }} CorpInfo
 * @typedef {{ name: string, industry: string, awareness: number, popularity: number, researchPoints: number, numAdVerts: number,
 *   cities: string[], products: string[], makesProducts: boolean, maxProducts: number, lastCycleRevenue: number,
 *   lastCycleExpenses: number, researched: Record<string, boolean>, offices: Record<string, any>, warehouses: Record<string, any>,
 *   materials: Record<string, Record<string, any>>, productData: Record<string, Record<string, any>> }} DivisionInfo
 * @typedef {{ corp: CorpInfo | null, offer: { funds: number, shares: number, round: number }, unlocks: Record<string, boolean>,
 *   upgrades: Record<string, number>, divisions: Record<string, DivisionInfo>, industries: Record<string, any>,
 *   materialSizes: Record<string, number>, constants: any, maxDivisions?: number, factionRep?: Record<string, number> | null,
 *   goals?: Record<string, { rep: number }> | null, factions?: string[] }} Snapshot
 */

/** What the planner keeps between passes (in the manager, and on the summary port so a restart picks it up). */
export function newMemory() {
	return {
		round: 0, roundStart: 0, offers: /** @type {{ t: number, funds: number }[]} */ ([]),
		price: /** @type {Record<string, PriceEntry>} */ ({}),
		flow: /** @type {Record<string, number>} */ ({}),
		ta2: /** @type {Record<string, boolean>} */ ({}),
		rp: /** @type {Record<string, { rp: number, t: number }>} */ ({}),
		lastResearch: 0,
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading the game: which calls fill a Snapshot, and how their results are put together.

/** The first read of a pass: the corporation, its offer, unlocks and upgrade levels, and each division. */
export function readCorpCalls(divisionNames) {
	return [
		["corporation.getCorporation"],
		["corporation.getInvestmentOffer"],
		...Object.keys(UNLOCKS).map((name) => ["corporation.hasUnlock", name]),
		...Object.keys(UPGRADES).map((name) => ["corporation.getUpgradeLevel", name]),
		...divisionNames.map((name) => ["corporation.getDivision", name]),
	];
}

/**
 * The second read: each division's offices, warehouses, the materials it uses, makes and is boosted by, its products in
 * every city, and its research. Needs the divisions (first read) and the industry data. Office and Warehouse calls fail
 * (and read as missing) until those APIs are unlocked. Materials and products are read only where the last pass found a
 * warehouse (`known`; null reads every city), so a city still without one costs one failed getWarehouse, not one per material.
 * @param {Record<string, any>} divisions name -> getDivision result
 * @param {Record<string, any>} industries industry -> getIndustryData result
 * @param {{ office: boolean, warehouse: boolean }} apis
 * @param {Record<string, string[]> | null} [known] division -> cities whose warehouse the last pass read
 */
export function readDivisionCalls(divisions, industries, apis, known = null) {
	const calls = [];
	for (const [name, division] of Object.entries(divisions)) {
		const materials = materialsOf(industries[division.industry]);
		for (const city of division.cities) {
			if (apis.office) calls.push(["corporation.getOffice", name, city]);
			if (!apis.warehouse) continue;
			calls.push(["corporation.getWarehouse", name, city]);
			if (known && !known[name]?.includes(city)) continue;
			for (const material of materials) calls.push(["corporation.getMaterial", name, city, material]);
			for (const product of division.products) calls.push(["corporation.getProduct", name, city, product]);
		}
		for (const item of researchNames(division.makesProducts)) calls.push(["corporation.hasResearched", name, item]);
	}
	return calls;
}

/** Industry and material data, read once per manager start. */
export function readDataCalls(industryNames, materialNames) {
	return [
		...industryNames.map((name) => ["corporation.getIndustryData", name]),
		...materialNames.map((name) => ["corporation.getMaterialData", name]),
	];
}

/** Every material a division touches: what it needs, what it makes, and the boost materials. */
export function materialsOf(industry) {
	if (!industry) return Object.keys(BOOSTS);
	return [...new Set([...Object.keys(industry.requiredMaterials ?? {}), ...(industry.producedMaterials ?? []), ...Object.keys(BOOSTS)])];
}

/** Research names a division can have (product industries also have the uPgrade branch). */
export function researchNames(makesProducts) {
	return Object.keys(RESEARCH).filter((name) => makesProducts || !RESEARCH[name].productsOnly);
}

/**
 * Puts the reads' results together. `results` holds one entry per call ({ ok, value } or { ok: false }), in the order of
 * `calls`; a failed call leaves its part out (no warehouse in that city, an API not unlocked yet).
 */
export function assembleSnapshot(calls, results, base = {}) {
	/** @type {Snapshot} */
	const snap = {
		corp: null, offer: { funds: 0, shares: 0, round: 0 }, unlocks: {}, upgrades: {}, divisions: {}, industries: {},
		materialSizes: {}, constants: {}, ...base,
	};
	calls.forEach((call, index) => {
		const result = results[index];
		if (!result?.ok) return;
		const [name, ...args] = call;
		const value = result.value;
		const division = () => snap.divisions[args[0]] ??= /** @type {any} */ ({ researched: {}, offices: {}, warehouses: {}, materials: {}, productData: {} });
		switch (name) {
			case "corporation.getCorporation": snap.corp = value; break;
			case "corporation.getInvestmentOffer": snap.offer = value; break;
			case "corporation.hasUnlock": snap.unlocks[args[0]] = !!value; break;
			case "corporation.getUpgradeLevel": snap.upgrades[args[0]] = Number(value) || 0; break;
			case "corporation.getDivision": Object.assign(division(), value); break;
			case "corporation.getOffice": division().offices[args[1]] = value; break;
			case "corporation.getWarehouse": division().warehouses[args[1]] = value; break;
			case "corporation.getMaterial": (division().materials[args[1]] ??= {})[args[2]] = value; break;
			case "corporation.getProduct": (division().productData[args[2]] ??= {})[args[1]] = value; break;
			case "corporation.hasResearched": division().researched[args[1]] = !!value; break;
			case "corporation.getIndustryData": snap.industries[args[0]] = value; break;
			case "corporation.getMaterialData": snap.materialSizes[args[0]] = value?.size; break;
			case "singularity.getFactionRep": (snap.factionRep ??= {})[args[0]] = Number(value) || 0; break;
		}
	});
	return snap;
}

// ---------------------------------------------------------------------------------------------------------------------
// Running calls: one generic worker per batch, with exactly the RAM its functions cost.

/**
 * Splits `calls` into consecutive batches whose RAM (base + each distinct function's cost once) fits in `maxRam`, keeping
 * their order. A single call that doesn't fit on its own still gets a batch (the manager waits for room for it).
 * @param {any[][]} calls
 * @param {(name: string) => number} costOf the game's RAM cost of a function ("corporation.getOffice")
 * @param {number} maxRam the most RAM one worker can have right now
 * @param {number} baseRam the worker's own cost (1.6GB)
 * @returns {{ calls: any[][], ram: number }[]}
 */
export function packBatches(calls, costOf, maxRam, baseRam) {
	const batches = [];
	let current = { calls: /** @type {any[][]} */ ([]), ram: baseRam, names: new Set() };
	for (const call of calls) {
		const name = call[0];
		const extra = current.names.has(name) ? 0 : costOf(name);
		if (current.calls.length && current.ram + extra > maxRam) {
			batches.push({ calls: current.calls, ram: round2(current.ram) });
			current = { calls: [], ram: baseRam, names: new Set() };
		}
		if (!current.names.has(name)) {
			current.names.add(name);
			current.ram += costOf(name);
		}
		current.calls.push(call);
	}
	if (current.calls.length) batches.push({ calls: current.calls, ram: round2(current.ram) });
	return batches;
}

const round2 = (value) => Math.ceil(value * 100 - 1e-6) / 100;

// ---------------------------------------------------------------------------------------------------------------------
// The plan.

/**
 * One pass of decisions. Returns { calls, lines, wants, memory, accepted }: the calls to run in order, the status lines, the
 * purchases the planner would make next but can't afford yet ({ what, cost }), and the memory for the next pass.
 * @param {Snapshot} input what the reads found this pass
 * @param {ReturnType<typeof newMemory> | null} memory what the last pass kept
 * @param {any} config loadConfig(ns): uses config.corp
 * @param {number} [now]
 */
export function planCorp(input, memory, config, now = Date.now()) {
	const snap = /** @type {Snapshot} */ (structuredClone(input));
	const settings = config.corp;
	const kept = memory ?? newMemory();
	const out = { calls: /** @type {any[][]} */ ([]), lines: /** @type {string[]} */ ([]), wants: /** @type {{ what: string, cost: number }[]} */ ([]), memory: kept, accepted: false };
	const corp = snap.corp;
	if (!corp) return out;
	const round = corp.public ? 5 : snap.offer.round;
	if (kept.round !== round) Object.assign(kept, { round, roundStart: now, offers: [] });
	kept.rp ??= {};
	const phase = researchPhase(snap, settings, round, kept.rp, now);
	if (phase.active) kept.lastResearch = now;
	const loss = Math.max(0, corp.expenses - corp.revenue);
	const reserve = Math.max(0, corp.expenses) * SECONDS_PER_CYCLE * settings.reserveCycles + loss * phase.etaSeconds;
	const ctx = { snap, settings, out, memory: kept, now, reserve, left: Math.max(0, corp.funds - reserve), blocked: false, blockedBy: /** @type {{ what: string, cost: number } | null} */ (null) };

	// The Office and Warehouse APIs come first: nothing below can be scripted without them.
	for (const unlock of ["Warehouse API", "Office API"]) {
		if (!snap.unlocks[unlock]) buy(ctx, UNLOCKS[unlock], ["corporation.purchaseUnlock", unlock], unlock, { blocking: true, then: () => { snap.unlocks[unlock] = true; } });
	}
	if (!snap.unlocks["Warehouse API"] || !snap.unlocks["Office API"]) {
		out.lines.unshift(header(snap, kept, now));
		return finish(ctx);
	}

	// Setup, a division at a time in role order (each one earns before the next is bought): the division, every city and
	// warehouse, Smart Supply, the round's office sizes. Blocking: lower spending waits for these.
	const roles = activeRoles(round, settings);
	/** @type {Record<string, string>} role -> division name */
	const named = {};
	for (const role of roles) {
		const name = ensureDivision(ctx, role);
		if (!name) continue;
		named[role] = name;
		setUpDivision(ctx, name, role, round);
	}
	const dummies = Object.keys(snap.divisions).filter((name) => isDummy(snap, name, named, settings));
	for (const name of dummies) setUpDivision(ctx, name, "dummy", round);
	const setupDone = !ctx.blocked && roles.every((role) => named[role] && CITIES.every((city) => snap.divisions[named[role]].warehouses[city]));

	// Upkeep every pass: jobs, energy and morale, sell orders, exports, Smart Supply, product prices.
	for (const [role, name] of Object.entries(named)) upkeep(ctx, name, role, round);
	exportsFor(ctx, named);
	buyResearch(ctx, named, round);

	// Growth with what is left. While a division is on research only, growth waits: nothing it buys raises the offer before
	// production resumes, and the money carries the loss until then.
	if (phase.active) out.lines.push(`research phase: ${phase.eta === null ? "measuring the research rate" : `about ${fmtMinutes(phase.etaSeconds)} to the round's target`}, growth waits`);
	else if (round <= 2) growEarly(ctx, named, round);
	else growLate(ctx, named, round, dummies);

	// Investment rounds, going public, dividends, bribes.
	offers(ctx, named, round, setupDone, phase.active);
	if (corp.public) dividends(ctx);
	bribes(ctx);
	out.lines.unshift(header(snap, kept, now));
	return finish(ctx);
}

function finish(ctx) {
	const { out } = ctx;
	out.wants = out.wants.filter((want) => Number.isFinite(want.cost));
	if (out.wants.length) {
		const next = out.wants.reduce((best, want) => (want.cost < best.cost ? want : best));
		out.lines.push(`saving for ${next.what} (${money(next.cost)})`);
	}
	return out;
}

/** Divisions this round wants, by role (config corp.industries): materials from round 1, support from 2, product from 3. */
export function activeRoles(round, settings) {
	const roles = ["materials"];
	if (round >= 2) roles.push("support");
	if (round >= 3) roles.push("product");
	return roles.filter((role) => settings.industries[role]);
}

/** The division of an industry (the planner's own name for it, else any division of that industry the player made). */
export function divisionOf(snap, industry) {
	if (snap.divisions[industry]?.industry === industry) return industry;
	return Object.keys(snap.divisions).find((name) => snap.divisions[name].industry === industry) ?? null;
}

function isDummy(snap, name, named, settings) {
	return snap.divisions[name].industry === settings.industries.dummy && !Object.values(named).includes(name);
}

/** Spends `cost` on `call` when the budget allows; otherwise notes the want and, for setup steps, stops lower spending. */
function buy(ctx, cost, call, what, { blocking = false, upkeep = false, then = () => {} } = {}) {
	if (ctx.blocked && !upkeep) return false;
	if (cost <= ctx.left) {
		ctx.left -= cost;
		ctx.snap.corp.funds -= cost;
		ctx.out.calls.push(call);
		then();
		return true;
	}
	ctx.out.wants.push({ what, cost });
	if (blocking && !ctx.blocked) {
		ctx.blocked = true;
		ctx.blockedBy = { what, cost };
	}
	return false;
}

function ensureDivision(ctx, role) {
	const { snap, settings } = ctx;
	const industry = settings.industries[role];
	const existing = divisionOf(snap, industry);
	if (existing) return existing;
	const data = snap.industries[industry];
	if (!data) return null;
	if (Object.keys(snap.divisions).length >= (snap.maxDivisions ?? 20)) return null;
	const name = industry;
	const made = buy(ctx, data.startingCost, ["corporation.expandIndustry", industry, name], `the ${industry} division`, {
		blocking: true, then: () => { snap.divisions[name] = newDivision(name, industry, data, snap); },
	});
	return made ? name : null;
}

/** A division as the game makes it: an empty office and a warehouse in Sector-12. */
function newDivision(name, industry, data, snap) {
	return {
		name, industry, awareness: 0, popularity: 0, researchPoints: 0, numAdVerts: 0, cities: ["Sector-12"], products: [],
		makesProducts: !!data.makesProducts, maxProducts: data.makesProducts ? 3 : 0, lastCycleRevenue: 0, lastCycleExpenses: 0,
		researched: {}, offices: { "Sector-12": newOffice(3) }, warehouses: { "Sector-12": newWarehouse(snap) }, materials: {}, productData: {},
	};
}

function newOffice(size) {
	return { size, numEmployees: 0, avgEnergy: 100, avgMorale: 100, maxEnergy: 100, maxMorale: 100, employeeJobs: {} };
}

function newWarehouse(snap) {
	return { level: 1, size: 100 * (1 + 0.1 * (snap.upgrades["Smart Storage"] ?? 0)), sizeUsed: 0, smartSupplyEnabled: !!snap.unlocks["Smart Supply"] };
}

/** Opens every city and warehouse, buys Smart Supply (and Export once a division takes the materials), and grows the offices to this round's size. */
function setUpDivision(ctx, name, role, round) {
	const { snap, settings } = ctx;
	const division = snap.divisions[name];
	const constants = snap.constants;
	// The unlocks first: Smart Supply starts production in the cities already open, which pays for the rest.
	if (role !== "dummy") {
		if (!snap.unlocks["Smart Supply"]) {
			buy(ctx, UNLOCKS["Smart Supply"], ["corporation.purchaseUnlock", "Smart Supply"], "Smart Supply", { blocking: true, then: () => { snap.unlocks["Smart Supply"] = true; } });
		}
		if (role !== "materials" && !snap.unlocks.Export) {
			buy(ctx, UNLOCKS.Export, ["corporation.purchaseUnlock", "Export"], "Export", { blocking: true, then: () => { snap.unlocks.Export = true; } });
		}
	}
	for (const city of CITIES) {
		if (!division.offices[city]) {
			buy(ctx, constants.officeInitialCost ?? 4e9, ["corporation.expandCity", name, city], `${name}'s ${city} office`, {
				blocking: true, then: () => { division.offices[city] = newOffice(3); division.cities.push(city); },
			});
		}
		if (division.offices[city] && !division.warehouses[city]) {
			buy(ctx, constants.warehouseInitialCost ?? 5e9, ["corporation.purchaseWarehouse", name, city], `${name}'s ${city} warehouse`, {
				blocking: true, then: () => { division.warehouses[city] = newWarehouse(snap); },
			});
		}
	}
	if (role === "dummy") return;
	const target = officeTarget(settings, role, round);
	for (const city of CITIES) {
		const office = division.offices[city];
		if (!office) continue;
		if (office.size < target) {
			buy(ctx, officeUpgradeCost(office.size, target - office.size, constants.officeInitialCost), ["corporation.upgradeOfficeSize", name, city, target - office.size],
				`${name}'s ${city} office to ${target}`, { blocking: true, then: () => { office.size = target; } });
		}
		hire(ctx, name, city, role, round);
	}
	if (round <= 2) {
		const adverts = settings.rounds[round]?.advert?.[role] ?? 0;
		while (division.numAdVerts < adverts && buy(ctx, advertCost(division.numAdVerts), ["corporation.hireAdVert", name], `Advert ${division.numAdVerts + 1} for ${name}`, { then: () => { division.numAdVerts++; } }));
	}
}

/** The office size a role wants in round 1 or 2 (config corp.rounds); later rounds grow offices from the budget. */
function officeTarget(settings, role, round) {
	const rounds = settings.rounds;
	if (round <= 2) return rounds[round]?.office?.[role] ?? 3;
	if (role === "product") return 3;
	return Math.max(rounds[1]?.office?.[role] ?? 3, rounds[2]?.office?.[role] ?? 3);
}

/** Fills an office up to its size, each new hire straight into the job its share is short of. */
function hire(ctx, name, city, role, round) {
	const office = ctx.snap.divisions[name].offices[city];
	const missing = office.size - office.numEmployees;
	if (missing <= 0) return;
	const want = jobTargets(ctx, name, city, role, round, office.size);
	const have = { ...office.employeeJobs };
	for (let index = 0; index < missing; index++) {
		const job = JOBS.reduce((best, item) => ((want[item] ?? 0) - (have[item] ?? 0) > (want[best] ?? 0) - (have[best] ?? 0) ? item : best), JOBS[0]);
		have[job] = (have[job] ?? 0) + 1;
		ctx.out.calls.push(["corporation.hireEmployee", name, city, job]);
	}
	office.numEmployees = office.size;
	office.hired = true;
}

/**
 * How many employees each job gets. Rounds 1-2 material divisions put everyone on research until the round's research target
 * (config corp.rounds[n].rp) is met, as the in-game guide does, then spread over production jobs; the product division's main
 * office spreads over production jobs (product development speed), its other offices keep one of each and put the rest on
 * research; from round 3 the material and support divisions weight Engineers double (material quality).
 */
export function jobTargets(ctx, name, city, role, round, count) {
	const { snap, settings } = ctx;
	const division = snap.divisions[name];
	const rpTarget = round <= 2 ? settings.rounds[round]?.rp?.[role] ?? 0 : 0;
	if (role === "dummy") return {};
	if (division.researchPoints < rpTarget) return { "Research & Development": count };
	if (role === "product" && city !== settings.mainCity) {
		const base = count >= 5 ? 1 : 0;
		const out = distribute(count >= 5 ? 4 : count, { Operations: 1, Engineer: 1, Business: 1, Management: 1 });
		if (base) out["Research & Development"] = count - 4;
		return out;
	}
	const weights = role === "product" || round <= 2
		? { Operations: 1, Engineer: 1, Business: 1, Management: 1 }
		: { Operations: 1, Engineer: 2, Business: 1, Management: 1 };
	return distribute(count, weights);
}

/** `count` people over `weights` by largest remainder (ties to the job listed first). */
export function distribute(count, weights) {
	const jobs = Object.keys(weights);
	const total = jobs.reduce((sum, job) => sum + weights[job], 0);
	const out = Object.fromEntries(jobs.map((job) => [job, Math.floor(count * weights[job] / total)]));
	let left = count - jobs.reduce((sum, job) => sum + out[job], 0);
	const order = [...jobs].sort((a, b) => (count * weights[b] / total % 1) - (count * weights[a] / total % 1));
	for (const job of order) {
		if (left <= 0) break;
		out[job]++;
		left--;
	}
	return out;
}

/** Jobs, tea and parties, Smart Supply, sell orders and product prices for one division. */
function upkeep(ctx, name, role, round) {
	const { snap, settings, out } = ctx;
	const division = snap.divisions[name];
	const industry = snap.industries[division.industry] ?? {};
	for (const city of CITIES) {
		const office = division.offices[city];
		if (office && !office.hired && office.numEmployees > 0) {
			const want = jobTargets(ctx, name, city, role, round, office.numEmployees);
			const have = office.employeeJobs ?? {};
			const differs = [...JOBS, "Intern", "Unassigned"].some((job) => (want[job] ?? 0) !== (have[job] ?? 0));
			if (differs) {
				for (const job of [...JOBS, "Intern"]) if (have[job]) out.calls.push(["corporation.setJobAssignment", name, city, job, 0]);
				for (const job of JOBS) if (want[job]) out.calls.push(["corporation.setJobAssignment", name, city, job, want[job]]);
			}
		}
		if (office && office.numEmployees > 0) {
			if (office.avgEnergy < office.maxEnergy - settings.keepUpWithin) {
				buy(ctx, (snap.constants.teaCostPerEmployee ?? 500e3) * office.numEmployees, ["corporation.buyTea", name, city], `tea in ${name} ${city}`, { upkeep: true });
			}
			if (office.avgMorale < office.maxMorale - settings.keepUpWithin) {
				const perEmployee = Math.ceil(partyCostPerEmployee(office.avgMorale, office.maxMorale, office.numEmployees < 9 ? 1.002 : 1));
				if (perEmployee > 0) buy(ctx, perEmployee * office.numEmployees, ["corporation.throwParty", name, city, perEmployee], `a party in ${name} ${city}`, { upkeep: true });
			}
		}
		const warehouse = division.warehouses[city];
		if (!warehouse) continue;
		if (snap.unlocks["Smart Supply"] && !warehouse.smartSupplyEnabled && Object.keys(industry.requiredMaterials ?? {}).length) {
			out.calls.push(["corporation.setSmartSupply", name, city, true]);
		}
		for (const material of industry.producedMaterials ?? []) {
			const info = division.materials[city]?.[material];
			if (!info || String(info.desiredSellAmount).toUpperCase() !== "MAX" || String(info.desiredSellPrice).toUpperCase() !== "MP") {
				out.calls.push(["corporation.sellMaterial", name, city, material, "MAX", "MP"]);
			}
		}
		trackFlow(ctx, name, city);
	}
	if (division.makesProducts) products(ctx, name);
}

/** The most storage the division's work (inputs, outputs, products) has taken in a city lately, beyond its boost materials. */
function trackFlow(ctx, name, city) {
	const { snap, memory } = ctx;
	const division = snap.divisions[name];
	const warehouse = division.warehouses[city];
	const key = `${name}|${city}`;
	const used = warehouse.sizeUsed - boostSpace(snap, division, city);
	const last = memory.flow[key] ?? 0;
	// Decays slowly, so one emptied cycle doesn't hand the space back to boosts at once.
	memory.flow[key] = Math.max(used, last * 0.98);
}

function boostSpace(snap, division, city) {
	let space = 0;
	for (const material of Object.keys(BOOSTS)) space += (division.materials[city]?.[material]?.stored ?? 0) * sizeOf(snap, material);
	return space;
}

function sizeOf(snap, material) {
	return snap.materialSizes[material] ?? BOOST_SIZES[material] ?? 0.05;
}

/** Develops products one after another and prices the finished ones. */
function products(ctx, name) {
	const { snap, settings, memory, out } = ctx;
	const division = snap.divisions[name];
	const main = settings.mainCity;
	if (!division.offices[main]) return;
	const data = (product) => division.productData[product]?.[main];
	const developing = division.products.filter((product) => (data(product)?.developmentProgress ?? 100) < 100);
	const finished = division.products.filter((product) => !developing.includes(product));
	if (!developing.length) {
		if (finished.length >= division.maxProducts && finished.length) {
			const worst = finished.reduce((low, product) => ((data(product)?.effectiveRating ?? 0) < (data(low)?.effectiveRating ?? 0) ? product : low));
			out.calls.push(["corporation.discontinueProduct", name, worst]);
			delete memory.price[`${name}|${worst}`];
			finished.splice(finished.indexOf(worst), 1);
			division.products = division.products.filter((product) => product !== worst);
		}
		const invest = Math.max(1, Math.floor(snap.corp.funds * settings.productInvestShare));
		const productName = nextProductName(name, division.products);
		buy(ctx, 2 * invest, ["corporation.makeProduct", name, main, productName, invest, invest], `a new ${name} product`, { upkeep: true, then: () => {
			division.products.push(productName);
			const ks = Object.entries(memory.price).filter(([key]) => key.startsWith(`${name}|`)).map(([, value]) => value.k);
			memory.price[`${name}|${productName}`] = { k: ks.length ? Math.max(...ks) : 1, dir: 0, step: settings.price.step, lo: null, hi: null };
		} });
	}
	const ta2 = !!division.researched["Market-TA.II"];
	for (const product of finished) {
		const key = `${name}|${product}`;
		const first = data(product);
		if (!first) continue;
		if (ta2) {
			if (!memory.ta2[key]) {
				out.calls.push(["corporation.setProductMarketTA2", name, product, true]);
				memory.ta2[key] = true;
			}
			if (String(first.desiredSellPrice).toUpperCase() !== "MP") out.calls.push(["corporation.sellProduct", name, main, product, "MAX", "MP", true]);
			continue;
		}
		const cities = Object.values(division.productData[product] ?? {});
		const entry = memory.price[key] ??= { k: 1, dir: 0, step: settings.price.step, lo: null, hi: null };
		priceStep(entry, cities, settings.price);
		const price = `MP*${round4(entry.k)}`;
		if (String(first.desiredSellPrice).toUpperCase() !== price.toUpperCase() || String(first.desiredSellAmount).toUpperCase() !== "MAX") {
			out.calls.push(["corporation.sellProduct", name, main, product, "MAX", price, true]);
		}
	}
	const progress = developing.map((product) => `${product} ${Math.floor(data(product)?.developmentProgress ?? 0)}%`);
	const best = finished.map((product) => data(product)?.effectiveRating ?? 0);
	out.lines.push(`${name}: ${finished.length}/${division.maxProducts} products${best.length ? `, best rating ${fmt(Math.max(...best))}` : ""}${progress.length ? `, developing ${progress.join(", ")}` : ""}${ta2 ? ", Market-TA.II prices" : ""}`);
}

const round4 = (value) => Math.round(value * 1e4) / 1e4;

/** The next free "<division>-<n>" product name. */
export function nextProductName(division, existing) {
	const numbers = existing.map((name) => Number(String(name).split("-").pop())).filter((value) => Number.isFinite(value));
	return `${division}-${(numbers.length ? Math.max(...numbers) : 0) + 1}`;
}

/**
 * @typedef {{ k: number, dir: number, step: number, lo?: number | null, hi?: number | null }} PriceEntry k: price = market price x k;
 *   lo: the highest k seen selling out, hi: the lowest k seen piling up stock (null: not known, or found stale)
 */

/**
 * Moves a product's price multiplier (price = market price x k) toward the highest price that still sells what is made, the
 * job Market-TA.II does once researched. A cycle that sells out the stock means k can go up, one where stock piles up means
 * it must come down. Until both sides are known the step grows while the direction holds (up to maxStep); then it bisects
 * between them (geometric mean). Demand drifts (awareness, competition, a new product), so when the two bounds meet (within
 * 1%) the one on the side the market now points to moves out by one base step and the search goes on. Never below the
 * market price (k >= minK).
 * @param {PriceEntry} entry
 * @param {{ stored: number, productionAmount: number, actualSellAmount: number }[]} cities this product in each city
 * @param {{ step: number, maxStep: number, minK: number }} options
 */
export function priceStep(entry, cities, options) {
	const stored = cities.reduce((sum, item) => sum + (item.stored ?? 0), 0);
	const made = cities.reduce((sum, item) => sum + (item.productionAmount ?? 0), 0) * SECONDS_PER_CYCLE;
	const sold = cities.reduce((sum, item) => sum + (item.actualSellAmount ?? 0), 0) * SECONDS_PER_CYCLE;
	let dir = 0;
	if (made > 0 && stored <= made * 0.5) dir = 1;
	else if (stored > Math.max(made, 1) * 2 && sold < made + stored * 0.1) dir = -1;
	if (!dir) return entry;
	entry.lo ??= null;
	entry.hi ??= null;
	if (dir > 0) {
		entry.lo = entry.k;
		// A ceiling at (or under) a price that just sold out was wrong, or demand grew: probe one step above
		if (entry.hi !== null && entry.hi <= entry.k * 1.01) entry.hi = entry.k * options.step;
	} else {
		entry.hi = entry.k;
		if (entry.lo !== null && entry.lo >= entry.k / 1.01) entry.lo = entry.k / options.step;
	}
	if (entry.lo !== null && entry.hi !== null) {
		entry.step = options.step;
		entry.k = Math.sqrt(entry.lo * entry.hi);
	} else {
		entry.step = dir === entry.dir ? Math.min(entry.step * 1.5, options.maxStep) : options.step;
		entry.k = dir > 0 ? entry.k * entry.step : entry.k / entry.step;
	}
	entry.k = Math.max(options.minK, entry.k);
	entry.dir = dir;
	return entry;
}

/**
 * Exports, in the in-game guide's order (export routes are served first come, first served): Plants from the material
 * division to the product division, then to the support division; the support division's output (Chemicals) back to the
 * material division. A city's routes are rebuilt when they differ from that order.
 */
function exportsFor(ctx, named) {
	const { snap, out } = ctx;
	if (!snap.unlocks.Export) return;
	const routes = exportRoutes(snap, named);
	for (const route of routes) {
		const source = snap.divisions[route.from];
		for (const city of CITIES) {
			const material = source.materials[city]?.[route.material];
			if (!material || !source.warehouses[city]) continue;
			const want = route.to.filter((target) => snap.divisions[target]?.warehouses[city]);
			const have = (material.exports ?? []).map((item) => ({ division: item.division, city: item.city, amount: String(item.amount) }));
			const same = have.length === want.length && want.every((target, index) => have[index].division === target && have[index].city === city && have[index].amount === EXPORT_AMOUNT);
			if (same) continue;
			for (const item of have) out.calls.push(["corporation.cancelExportMaterial", route.from, city, item.division, item.city, route.material]);
			for (const target of want) out.calls.push(["corporation.exportMaterial", route.from, city, target, city, route.material, EXPORT_AMOUNT]);
		}
	}
}

/** Which division sends which material where: each produced material to every planned division that needs it, product division first. */
export function exportRoutes(snap, named) {
	const routes = [];
	const order = ["product", "support", "materials"];
	for (const role of ["materials", "support"]) {
		const from = named[role];
		if (!from) continue;
		const industry = snap.industries[snap.divisions[from].industry] ?? {};
		for (const material of industry.producedMaterials ?? []) {
			const to = order.map((target) => named[target]).filter((target) => target && target !== from && Object.keys(snap.industries[snap.divisions[target]?.industry]?.requiredMaterials ?? {}).includes(material));
			if (to.length) routes.push({ from, material, to });
		}
	}
	return routes;
}

/**
 * Research with research points, from round 3 (before that the points are the material quality the offers need), in the
 * config's order (corp.researchOrder: the in-game guide's), each only when it costs at most its share of the division's points.
 * A group (Market-TA.I and II) is bought together.
 */
function buyResearch(ctx, named, round) {
	const { snap, settings, out } = ctx;
	if (round <= 2) return;
	for (const name of Object.values(named)) {
		const division = snap.divisions[name];
		for (const item of settings.researchOrder) {
			const group = [item.name, ...(item.with ?? [])].filter((entry) => RESEARCH[entry] && !division.researched[entry]);
			if (!group.length) continue;
			if (group.some((entry) => RESEARCH[entry].productsOnly && !division.makesProducts)) continue;
			if (item.productsOnly && !division.makesProducts) continue;
			const cost = group.reduce((sum, entry) => sum + RESEARCH[entry].cost, 0);
			const ready = group.every((entry, index) => !RESEARCH[entry].after || division.researched[RESEARCH[entry].after] || group.slice(0, index).includes(RESEARCH[entry].after));
			if (!ready || cost > division.researchPoints * item.pointShare) continue;
			for (const entry of group) {
				out.calls.push(["corporation.research", name, entry]);
				division.researched[entry] = true;
			}
			division.researchPoints -= cost;
		}
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// Growth.

/**
 * Rounds 1 and 2: production is what the offer needs, so the money goes where it raises the material division's production
 * the most per dollar: boost materials into free storage, Smart Storage, a warehouse level in every city, Smart Factories
 * (round 2). Each option is priced with the boost materials that would fill its new space, and scored with the game's
 * production formula. The support division gets its round's warehouse level and its boost materials.
 */
function growEarly(ctx, named, round) {
	const { snap, settings } = ctx;
	if (ctx.blocked) return;
	const main = named.materials;
	if (round >= 2 && named.support) {
		const support = snap.divisions[named.support];
		const level = settings.rounds[2]?.warehouse?.support ?? 1;
		for (const city of CITIES) {
			const warehouse = support.warehouses[city];
			if (warehouse && warehouse.level < level) {
				buy(ctx, warehouseUpgradeCost(warehouse.level, level - warehouse.level), ["corporation.upgradeWarehouse", named.support, city, level - warehouse.level],
					`${named.support}'s ${city} warehouse`, { then: () => { resizeWarehouse(warehouse, level, snap, support); } });
			}
		}
		fillBoosts(ctx, named.support, ctx.left * settings.supportBoostShare);
	}
	if (!main) return;
	for (let step = 0; step < 60 && ctx.left > 0; step++) {
		const options = earlyOptions(ctx, main, round);
		const affordable = options.filter((option) => option.cost > 0 && option.cost <= ctx.left && option.gain > 0);
		if (!affordable.length) {
			// (An option priced from materials the reads haven't seen yet costs Infinity: not a want.)
			const cheapest = options.filter((option) => option.gain > 0 && Number.isFinite(option.cost)).sort((a, b) => a.cost - b.cost)[0];
			if (cheapest) ctx.out.wants.push({ what: cheapest.what, cost: cheapest.cost });
			// What can't be filled whole is filled in part.
			if (options.some((option) => option.kind === "fill" && option.gain > 0)) fillBoosts(ctx, main, ctx.left);
			break;
		}
		const best = affordable.reduce((top, option) => (option.gain / option.cost > top.gain / top.cost ? option : top));
		best.apply();
	}
}

/** The production-per-dollar options for growEarly. */
function earlyOptions(ctx, name, round) {
	const { snap } = ctx;
	const division = snap.divisions[name];
	const factors = boostFactors(snap, division);
	const cities = CITIES.filter((city) => division.warehouses[city]);
	const now = cities.reduce((sum, city) => sum + cityMult(factors, stockOf(division, city)) ** 0.73, 0);
	if (!now) return [];
	const endState = (sizeOf) => {
		let cost = 0;
		let total = 0;
		for (const city of cities) {
			const target = boostTarget(ctx, name, city, sizeOf(city));
			cost += fillCost(snap, division, city, target);
			total += cityMult(factors, maxQuantities(target, stockOf(division, city))) ** 0.73;
		}
		return { cost, gain: total / now - 1 };
	};
	const options = [];
	const fill = endState((city) => division.warehouses[city].size);
	options.push({ kind: "fill", what: `boost materials for ${name}`, cost: fill.cost, gain: fill.gain, apply: () => fillBoosts(ctx, name, ctx.left) });
	const storageLevel = snap.upgrades["Smart Storage"] ?? 0;
	const storageScale = (1 + 0.1 * (storageLevel + 1)) / (1 + 0.1 * storageLevel);
	const storage = endState((city) => division.warehouses[city].size * storageScale);
	const storageCost = upgradeCost("Smart Storage", storageLevel);
	options.push({
		kind: "storage", what: "Smart Storage", cost: storageCost + storage.cost, gain: storage.gain,
		apply: () => buy(ctx, storageCost, ["corporation.levelUpgrade", "Smart Storage"], "Smart Storage", { then: () => {
			snap.upgrades["Smart Storage"] = storageLevel + 1;
			for (const other of Object.values(snap.divisions)) for (const warehouse of Object.values(other.warehouses)) warehouse.size *= storageScale;
		} }),
	});
	const warehouseCost = cities.reduce((sum, city) => sum + warehouseUpgradeCost(division.warehouses[city].level), 0);
	const bigger = endState((city) => division.warehouses[city].size * (division.warehouses[city].level + 1) / division.warehouses[city].level);
	options.push({
		kind: "warehouse", what: `a warehouse level for ${name}`, cost: warehouseCost + bigger.cost, gain: bigger.gain,
		apply: () => {
			for (const city of cities) {
				const warehouse = division.warehouses[city];
				buy(ctx, warehouseUpgradeCost(warehouse.level), ["corporation.upgradeWarehouse", name, city, 1], `${name}'s ${city} warehouse`, { then: () => { resizeWarehouse(warehouse, warehouse.level + 1, snap, division); } });
			}
		},
	});
	if (round >= 2) {
		const level = snap.upgrades["Smart Factories"] ?? 0;
		const cost = upgradeCost("Smart Factories", level);
		options.push({
			kind: "factories", what: "Smart Factories", cost, gain: (1 + 0.03 * (level + 1)) / (1 + 0.03 * level) - 1,
			apply: () => buy(ctx, cost, ["corporation.levelUpgrade", "Smart Factories"], "Smart Factories", { then: () => { snap.upgrades["Smart Factories"] = level + 1; } }),
		});
	}
	return options;
}

function resizeWarehouse(warehouse, level, snap, division) {
	warehouse.size = warehouse.size * level / warehouse.level;
	warehouse.level = level;
}

function boostFactors(snap, division) {
	const industry = snap.industries[division.industry] ?? {};
	return Object.fromEntries(Object.entries(BOOSTS).map(([material, key]) => [material, industry[key] ?? 0]));
}

function stockOf(division, city) {
	return Object.fromEntries(Object.keys(BOOSTS).map((material) => [material, division.materials[city]?.[material]?.stored ?? 0]));
}

const maxQuantities = (target, stock) => Object.fromEntries(Object.keys(target).map((material) => [material, Math.max(target[material], stock[material] ?? 0)]));

/**
 * The boost materials a city should hold: the optimizer's mix for the warehouse's boost space, which is `boostShare` of it
 * less twice the most the division's own work has used there lately (so production never runs out of room).
 */
function boostTarget(ctx, name, city, size) {
	const { snap, settings, memory } = ctx;
	const division = snap.divisions[name];
	const flow = memory.flow[`${name}|${city}`] ?? 0;
	const space = Math.max(0, Math.min(size * settings.boostShare, size - 2 * flow - size * (1 - settings.boostShare)));
	const sizes = Object.fromEntries(Object.keys(BOOSTS).map((material) => [material, sizeOf(snap, material)]));
	return boostQuantities(boostFactors(snap, division), sizes, space);
}

function fillCost(snap, division, city, target) {
	let cost = 0;
	for (const [material, units] of Object.entries(target)) {
		const info = division.materials[city]?.[material];
		const missing = units - (info?.stored ?? 0);
		if (missing > 0) cost += missing * (info?.marketPrice ?? Infinity);
	}
	return cost;
}

/** Buys the missing boost materials in every city of a division (bulkPurchase: paid now, exact), within `cap`. */
function fillBoosts(ctx, name, cap) {
	const { snap } = ctx;
	const division = snap.divisions[name];
	if (!division || !(cap > 0)) return 0;
	const orders = [];
	for (const city of CITIES) {
		const warehouse = division.warehouses[city];
		if (!warehouse) continue;
		const target = boostTarget(ctx, name, city, warehouse.size);
		for (const [material, units] of Object.entries(target)) {
			const info = division.materials[city]?.[material];
			const missing = Math.floor(units - (info?.stored ?? 0));
			if (missing > 0 && info?.marketPrice > 0) orders.push({ city, material, missing, price: info.marketPrice });
		}
	}
	const total = orders.reduce((sum, order) => sum + order.missing * order.price, 0);
	if (!total) return 0;
	const scale = Math.min(1, Math.min(cap, ctx.left) / total);
	let spent = 0;
	for (const order of orders) {
		const units = Math.floor(order.missing * scale);
		if (units <= 0) continue;
		const cost = units * order.price;
		if (buy(ctx, cost, ["corporation.bulkPurchase", name, order.city, order.material, units], `${order.material} for ${name}`)) {
			const info = division.materials[order.city][order.material];
			info.stored = (info.stored ?? 0) + units;
			division.warehouses[order.city].sizeUsed += units * sizeOf(snap, order.material);
			spent += cost;
		}
	}
	return spent;
}

/**
 * Round 3 on: the in-game guide's loop, each part with its share of the money left this pass (config corp.budget): Wilson
 * Analytics whenever it is affordable, Advert for the product division, the product division's main office, the corporation
 * upgrades (cheapest level first), the product division's warehouses and boosts, its other offices, the support divisions,
 * dummy divisions before going public (each raises the valuation 10% for its price), and once public the unlocks that cut
 * the tribute on dividends.
 */
function growLate(ctx, named, round, dummies) {
	const { snap, settings } = ctx;
	if (ctx.blocked) return;
	const budget = settings.budget;
	const pool = ctx.left;
	const product = named.product ? snap.divisions[named.product] : null;
	const cap = (portion) => ({ left: pool * portion });
	const spend = (limit, cost, call, what, then) => {
		if (cost > limit.left) {
			ctx.out.wants.push({ what, cost });
			return false;
		}
		const done = buy(ctx, cost, call, what, { then });
		if (done) limit.left -= cost;
		return done;
	};

	if (product) {
		const wilsonLevel = snap.upgrades["Wilson Analytics"] ?? 0;
		spend(cap(budget.wilson), upgradeCost("Wilson Analytics", wilsonLevel), ["corporation.levelUpgrade", "Wilson Analytics"], "Wilson Analytics",
			() => { snap.upgrades["Wilson Analytics"] = wilsonLevel + 1; });
		const advert = cap(budget.advert);
		while (product.awareness < Number.MAX_VALUE / 2 && spend(advert, advertCost(product.numAdVerts), ["corporation.hireAdVert", named.product], `Advert for ${named.product}`, () => { product.numAdVerts++; }));

		const office = cap(budget.office);
		const main = product.offices[settings.mainCity];
		while (main && spend(office, officeUpgradeCost(main.size, settings.officeStep), ["corporation.upgradeOfficeSize", named.product, settings.mainCity, settings.officeStep],
			`${named.product}'s ${settings.mainCity} office`, () => { main.size += settings.officeStep; }));
		if (main) hire(ctx, named.product, settings.mainCity, "product", round);
	}

	const upgrades = cap(budget.upgrades);
	for (let step = 0; step < 200; step++) {
		const next = settings.upgrades.map((name) => ({ name, level: snap.upgrades[name] ?? 0 }))
			.map((item) => ({ ...item, cost: upgradeCost(item.name, item.level) }))
			.reduce((low, item) => (item.cost < low.cost ? item : low), { name: "", level: 0, cost: Infinity });
		if (!next.name || !spend(upgrades, next.cost, ["corporation.levelUpgrade", next.name], next.name, () => { snap.upgrades[next.name] = next.level + 1; })) break;
	}

	for (const [role, portion] of [["product", budget.productStorage], ["materials", budget.support], ["support", budget.support]]) {
		const name = named[role];
		if (!name) continue;
		const division = snap.divisions[name];
		const limit = cap(portion);
		for (const city of CITIES) {
			const warehouse = division.warehouses[city];
			if (warehouse && warehouse.sizeUsed > warehouse.size * settings.warehouseFull) {
				spend(limit, warehouseUpgradeCost(warehouse.level), ["corporation.upgradeWarehouse", name, city, 1], `${name}'s ${city} warehouse`, () => { resizeWarehouse(warehouse, warehouse.level + 1, snap, division); });
			}
		}
		limit.left -= fillBoosts(ctx, name, limit.left);
		if (role === "product") continue;
		// Support offices grow a step at a time, the smallest first.
		const smallest = CITIES.filter((city) => division.offices[city]).sort((a, b) => division.offices[a].size - division.offices[b].size)[0];
		const office = smallest && division.offices[smallest];
		if (office && spend(limit, officeUpgradeCost(office.size, settings.officeStep), ["corporation.upgradeOfficeSize", name, smallest, settings.officeStep],
			`${name}'s ${smallest} office`, () => { office.size += settings.officeStep; })) hire(ctx, name, smallest, role, round);
	}

	if (product) {
		const limit = cap(budget.supportOffices);
		const others = CITIES.filter((city) => city !== settings.mainCity && product.offices[city]);
		const mainSize = product.offices[settings.mainCity]?.size ?? 0;
		for (const city of others.sort((a, b) => product.offices[a].size - product.offices[b].size)) {
			const office = product.offices[city];
			if (office.size + settings.officeStep > Math.max(settings.officeStep, mainSize * settings.supportOfficeRatio)) continue;
			if (spend(limit, officeUpgradeCost(office.size, settings.officeStep), ["corporation.upgradeOfficeSize", named.product, city, settings.officeStep],
				`${named.product}'s ${city} office`, () => { office.size += settings.officeStep; })) hire(ctx, named.product, city, "product", round);
			else break;
		}
	}

	if (!snap.corp.public && settings.dummyDivisions && dummies.length + Object.keys(named).length < (snap.maxDivisions ?? 20)) {
		const data = snap.industries[settings.industries.dummy];
		const constants = snap.constants;
		if (data) {
			const cost = data.startingCost + 5 * ((constants.officeInitialCost ?? 4e9) + (constants.warehouseInitialCost ?? 5e9));
			const gain = snap.offer.funds * (VALUATION_PER_FACILITY ** 12 - 1);
			const name = `${settings.industries.dummy}-${dummies.length + 1}`;
			if (gain > cost && !snap.divisions[name]) {
				spend(cap(budget.dummy), data.startingCost, ["corporation.expandIndustry", settings.industries.dummy, name], `dummy division ${name}`,
					() => { snap.divisions[name] = newDivision(name, settings.industries.dummy, data, snap); });
			}
		}
	}

	if (snap.corp.public) {
		const limit = cap(budget.tribute);
		for (const unlock of ["Shady Accounting", "Government Partnership"]) {
			if (!snap.unlocks[unlock]) spend(limit, UNLOCKS[unlock], ["corporation.purchaseUnlock", unlock], unlock, () => { snap.unlocks[unlock] = true; });
		}
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// Investors, going public, dividends, bribes.

/**
 * The round's research phase (config corp.rounds[n].rp, rounds 1-2): whether a division of the round is still below its
 * research target, and the time until the slowest one reaches it at the rate measured since the last pass (`rates` is the
 * planner memory's { division: { rp, t } }, updated here; null only reads). etaSeconds is 0 when nothing is below target
 * and when the rate isn't measured yet (eta null).
 * @returns {{ active: boolean, eta: number | null, etaSeconds: number }}
 */
export function researchPhase(snap, settings, round, rates, now) {
	const targets = round <= 2 ? settings.rounds[round]?.rp ?? {} : {};
	let active = false;
	/** @type {number | null} */
	let eta = 0;
	for (const [role, target] of Object.entries(targets)) {
		const name = divisionOf(snap, settings.industries[role]);
		const division = name ? snap.divisions[name] : null;
		if (!division) continue;
		const before = rates?.[name];
		if (rates) rates[name] = { rp: division.researchPoints, t: now };
		if (division.researchPoints >= target) continue;
		active = true;
		const rate = before && now > before.t ? (division.researchPoints - before.rp) / ((now - before.t) / 1000) : 0;
		if (!(rate > 0)) eta = null;
		else if (eta !== null) eta = Math.max(eta, (target - division.researchPoints) / rate);
	}
	return { active, eta: active ? eta : 0, etaSeconds: active && eta !== null ? eta : 0 };
}

/**
 * Takes the investment offer once the round's setup is done (and in rounds 1-2 its research target is met) and the offer has
 * stopped growing fast enough to be worth the wait: less than `offers.minGrowthPerHour` over the last `offers.windowMinutes`
 * (the valuation behind it is the game's 10-cycle average, so a minute or two of history is noise). `offers.maxHours` in a
 * round takes it anyway. After the fourth round the corporation goes public with no new shares.
 */
function offers(ctx, named, round, setupDone, researching) {
	const { snap, settings, memory, out, now } = ctx;
	const corp = snap.corp;
	if (corp.public) return;
	if (snap.offer.funds <= 0 && round > 4) {
		if (settings.ipo) out.calls.push(["corporation.goPublic", 0]);
		return;
	}
	if (!(snap.offer.funds > 0)) return;
	memory.offers.push({ t: now, funds: snap.offer.funds });
	const windowMs = settings.offers.windowMinutes * 60_000;
	while (memory.offers.length > 2 && now - memory.offers[1].t >= windowMs) memory.offers.shift();
	const growth = offerGrowth(memory.offers, now, windowMs);
	const rpDone = !researchPhase(snap, settings, round, null, now).active;
	const waited = now - memory.roundStart >= settings.offers.maxHours * 3.6e6;
	// Stuck: the setup waits on a purchase, there is no profit to save for it (and no research phase that will end), and the
	// offer pays for it.
	const settled = !researching && now - (memory.lastResearch ?? 0) > SETTLE_MS;
	const stuck = !setupDone && settled && corp.revenue - corp.expenses <= 0 && !!ctx.blockedBy && ctx.left + snap.offer.funds >= ctx.blockedBy.cost;
	const decision = acceptOffer({ setupDone, stuck, rpDone, growth, waited, minGrowth: settings.offers.minGrowthPerHour });
	out.lines.push(`round ${round} offer ${money(snap.offer.funds)} for ${fmtPercent(snap.offer.shares / corp.totalShares)} of the shares, ${growth === null ? "measuring its growth" : `growing ${fmtPercent(growth)} an hour`}${decision.accept ? "" : `; waiting: ${decision.why}`}`);
	if (decision.accept && settings.acceptOffers) {
		out.calls.push(["corporation.acceptInvestmentOffer"]);
		out.accepted = true;
	}
}

/** The offer's growth per hour over the window (relative), or null until the history spans the window. */
export function offerGrowth(history, now, windowMs) {
	if (history.length < 2) return null;
	const first = history[0];
	const last = history[history.length - 1];
	if (now - first.t < windowMs * 0.9 || !(first.funds > 0)) return null;
	return (last.funds / first.funds - 1) / ((last.t - first.t) / 3.6e6);
}

/**
 * The acceptance rule (offers): { accept, why }. `stuck`: the setup waits on a purchase, there is no profit to save for it
 * (a self-funded corporation that paid for the APIs), and the offer pays for it, so the offer is the only way on.
 */
export function acceptOffer({ setupDone, stuck = false, rpDone, growth, waited, minGrowth }) {
	if (!setupDone) return stuck ? { accept: true, why: "the setup can't be paid from profit" } : { accept: false, why: "the round's setup isn't done" };
	if (waited) return { accept: true, why: "waited the longest a round may take" };
	if (!rpDone) return { accept: false, why: "research points below the round's target" };
	if (growth === null) return { accept: false, why: "measuring the offer's growth" };
	if (growth >= minGrowth) return { accept: false, why: `still growing faster than ${fmtPercent(minGrowth)} an hour` };
	return { accept: true, why: "growth has slowed" };
}

/**
 * Once public: the dividend rate. Profit the planner can't use soon goes to the player: the rate keeps enough of each cycle's
 * profit to afford the next thing the planner wants within `dividends.waitMinutes`, and pays the rest out (up to maxRate).
 */
function dividends(ctx) {
	const { snap, settings, out } = ctx;
	if (!settings.dividends.enabled) return;
	const corp = snap.corp;
	const profit = (corp.revenue - corp.expenses) * SECONDS_PER_CYCLE;
	const next = out.wants.length ? Math.min(...out.wants.map((want) => want.cost)) : 0;
	const rate = dividendRate(profit, next, settings.dividends.waitMinutes * 60 / SECONDS_PER_CYCLE, settings.dividends.maxRate);
	if (Math.abs(rate - corp.dividendRate) >= settings.dividends.minChange || (rate === 0 && corp.dividendRate > 0)) {
		out.calls.push(["corporation.issueDividends", rate]);
		corp.dividendRate = rate;
	}
	out.lines.push(`public: dividends ${fmtPercent(corp.dividendRate)} of profit`);
}

/** The dividend rule: the share of profit not needed to afford `nextWant` within `cycles` cycles, at most maxRate; 0 without profit. */
export function dividendRate(profitPerCycle, nextWant, cycles, maxRate) {
	if (!(profitPerCycle > 0)) return 0;
	if (!(nextWant > 0)) return maxRate;
	const keep = nextWant / (cycles * profitPerCycle);
	return Math.round(Math.max(0, Math.min(maxRate, 1 - keep)) * 100) / 100;
}

/**
 * Bribes factions for the reputation the augmentation plan still needs (port 23 goals), with money the planner has left this
 * pass (bribes.cashShare of it), once the valuation allows bribes. Needs each faction's current reputation (the Singularity API);
 * without it nothing is bribed.
 */
function bribes(ctx) {
	const { snap, settings, out } = ctx;
	if (!settings.bribes.enabled || !snap.goals || !snap.factionRep) return;
	if (!(snap.corp.valuation >= (snap.constants.bribeThreshold ?? 100e12))) return;
	const perRep = snap.constants.bribeAmountPerReputation ?? 1e9;
	let pot = ctx.left * settings.bribes.cashShare;
	for (const [faction, goal] of Object.entries(snap.goals)) {
		if (pot <= 0) break;
		const have = snap.factionRep[faction];
		if (have === undefined || !(goal.rep > have) || !(snap.factions ?? []).includes(faction)) continue;
		const cash = Math.min(pot, (goal.rep - have) * perRep);
		if (cash < perRep) continue;
		if (buy(ctx, cash, ["corporation.bribe", faction, cash], `a bribe to ${faction}`)) {
			pot -= cash;
			out.lines.push(`bribed ${faction}: ${money(cash)} for ${fmt(cash / perRep)} reputation`);
		}
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// Status text.

function header(snap, memory, now) {
	const corp = snap.corp;
	const profit = corp.revenue - corp.expenses;
	const divisions = Object.keys(snap.divisions).length;
	const stage = corp.public ? "public" : `round ${snap.offer.round}`;
	return `${corp.name ?? "corporation"} (${stage}): funds ${money(corp.funds)}, profit ${money(profit)}/s, ${divisions} division${divisions === 1 ? "" : "s"}, valuation ${money(corp.valuation)}`;
}

function money(value) {
	return `$${fmt(value)}`;
}

function fmt(value) {
	/** @type {[number, string][]} */
	const units = [[1e15, "q"], [1e12, "t"], [1e9, "b"], [1e6, "m"], [1e3, "k"]];
	const abs = Math.abs(value);
	for (const [size, unit] of units) if (abs >= size) return `${(value / size).toFixed(abs / size >= 100 ? 0 : 2)}${unit}`;
	return Number.isFinite(value) ? value.toFixed(abs >= 100 ? 0 : 2) : String(value);
}

function fmtMinutes(seconds) {
	return `${Math.max(1, Math.round(seconds / 60))} min`;
}

function fmtPercent(value) {
	return `${Math.round(value * 1000) / 10}%`;
}
