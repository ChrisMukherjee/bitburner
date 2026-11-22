// A small corporation for corp/corp-manager.js: the Corporation API over plain objects, with the game's prices, unlocks and
// rules about what each call needs (APIs unlocked, funds, warehouses, offices, export routes), and a simplified economy each
// market cycle (production from workers and boost materials, sales, research points, product development, salaries, the
// valuation and investment offers by the game's formulas). The manager's worker (corp/workers/call.js) runs for real: exec
// starts it with its own ns, and that ns charges each corporation function's RAM once and throws, as the game does, when a
// call needs more RAM than the worker was started with.
//
//   const sim = corpSim({ node: 3 });
//   await sim.run(main, 6 * HOUR);   // corp/corp-manager.js against simulated time
//   sim.corp.funds; sim.workers      // [{ ram, calls }] every worker started
//   sim.errors                       // funds below zero after a cycle; sim.callErrors: every call that threw ("fn: message")
import { fakeNs } from "./fake-ns.mjs";
import { main as callWorker } from "/corp/workers/call.js";

export const CITIES = ["Sector-12", "Aevum", "Chongqing", "New Tokyo", "Ishima", "Volhaven"];
const STATES = ["START", "PURCHASE", "PRODUCTION", "EXPORT", "SALE"];
export const INDUSTRIES = {
	Agriculture: { startingCost: 40e9, realEstateFactor: 0.72, scienceFactor: 0.5, hardwareFactor: 0.2, robotFactor: 0.3, aiCoreFactor: 0.3, advertisingFactor: 0.04, requiredMaterials: { Water: 0.5, Chemicals: 0.2 }, producedMaterials: ["Plants", "Food"], makesMaterials: true, makesProducts: false },
	Chemical: { startingCost: 70e9, realEstateFactor: 0.25, scienceFactor: 0.75, hardwareFactor: 0.2, robotFactor: 0.25, aiCoreFactor: 0.2, advertisingFactor: 0.07, requiredMaterials: { Plants: 1, Water: 0.5 }, producedMaterials: ["Chemicals"], makesMaterials: true, makesProducts: false },
	Tobacco: { startingCost: 20e9, realEstateFactor: 0.15, scienceFactor: 0.75, hardwareFactor: 0.15, robotFactor: 0.2, aiCoreFactor: 0.15, advertisingFactor: 0.2, requiredMaterials: { Plants: 1 }, makesMaterials: false, makesProducts: true, product: { name: "Product" } },
	Restaurant: { startingCost: 10e9, realEstateFactor: 0.05, scienceFactor: 0.12, hardwareFactor: 0.15, robotFactor: 0.3, aiCoreFactor: 0.25, advertisingFactor: 0.25, requiredMaterials: { Food: 0.5, Water: 0.5 }, makesMaterials: false, makesProducts: true, product: { name: "Restaurant" } },
};
export const SIZES = { Water: 0.05, Chemicals: 0.05, Plants: 0.05, Food: 0.03, Hardware: 0.06, Robots: 0.5, "AI Cores": 0.1, "Real Estate": 0.005 };
export const PRICES = { Water: 1.5e3, Chemicals: 9e3, Plants: 3e3, Food: 5e3, Hardware: 8e3, Robots: 75e3, "AI Cores": 27e3, "Real Estate": 80e3 };
const BOOSTS = { Hardware: "hardwareFactor", Robots: "robotFactor", "AI Cores": "aiCoreFactor", "Real Estate": "realEstateFactor" };
const UPGRADES = {
	"Smart Factories": [2e9, 1.06], "Smart Storage": [2e9, 1.06], "Wilson Analytics": [4e9, 2], "Nuoptimal Nootropic Injector Implants": [1e9, 1.06],
	"Speech Processor Implants": [1e9, 1.06], "Neural Accelerators": [1e9, 1.06], "FocusWires": [1e9, 1.06], "ABC SalesBots": [1e9, 1.07], "Project Insight": [5e9, 1.07],
};
const UNLOCKS = { "Export": 20e9, "Smart Supply": 25e9, "Market Research - Demand": 5e9, "Market Data - Competition": 5e9, "Shady Accounting": 500e12, "Government Partnership": 2e15, "Warehouse API": 50e9, "Office API": 50e9 };
const RESEARCH = {
	"Hi-Tech R&D Laboratory": 5e3, "Market-TA.I": 20e3, "Market-TA.II": 50e3, "Overclock": 15e3, "Sti.mu": 30e3, "Automatic Drug Administration": 10e3,
	"Go-Juice": 25e3, "CPH4 Injections": 25e3, "Drones": 5e3, "Drones - Assembly": 25e3, "Drones - Transport": 30e3, "Self-Correcting Assemblers": 25e3,
	"uPgrade: Fulcrum": 10e3, "uPgrade: Capacity.I": 20e3, "uPgrade: Capacity.II": 30e3, "uPgrade: Dashboard": 5e3, "AutoBrew": 12e3, "AutoPartyManager": 15e3,
	"HRBuddy-Recruitment": 15e3, "HRBuddy-Training": 20e3,
};
const PRODUCTS_ONLY = ["uPgrade: Fulcrum", "uPgrade: Capacity.I", "uPgrade: Capacity.II", "uPgrade: Dashboard"];
const RAM = { info: 10, action: 20 };
const FREE = new Set(["hasCorporation", "canCreateCorporation", "getConstants", "getBonusTime", "nextUpdate"]);
const INFO = new Set(["hasUnlock", "getUnlockCost", "getUpgradeLevel", "getUpgradeLevelCost", "getInvestmentOffer", "getIndustryData", "getMaterialData",
	"getCorporation", "getDivision", "getWarehouse", "getProduct", "getMaterial", "getUpgradeWarehouseCost", "hasWarehouse", "getOffice", "getHireAdVertCost",
	"getHireAdVertCount", "getResearchCost", "hasResearched", "getOfficeSizeUpgradeCost"]);
/** The game's RAM cost of a function under ns ("corporation.getOffice"). */
export function corpRamCost(name) {
	const [space, fn] = String(name).split(".");
	if (space === "singularity") return 3;
	if (space !== "corporation") return 0;
	if (FREE.has(fn)) return 0;
	return INFO.has(fn) ? RAM.info : RAM.action;
}

class SimEnd extends Error {}

/**
 * @param {object} [options]
 * @param {number} [options.node]          current BitNode
 * @param {Array<[number, number]>} [options.sourceFiles]
 * @param {number} [options.money]         player cash
 * @param {number} [options.ram]           home RAM (the only server)
 * @param {Record<string, string>} [options.files] e.g. data/config.json
 * @param {number} [options.demand]        product sales scale (higher: products sell at a higher price)
 */
export function corpSim({ node = 3, sourceFiles = [], money = 1e6, ram = 2048, files = {}, demand = 1 } = {}) {
	let now = 1_000_000;
	let end = Infinity;
	let state = 0;
	let nextPid = 1;
	const running = new Set();
	const sim = {
		/** @type {any} */ corp: null, player: { money, factions: [] }, workers: /** @type {{ ram: number, calls: any[] }[]} */ ([]),
		errors: /** @type {string[]} */ ([]), callErrors: /** @type {string[]} */ ([]), cycles: 0, ramErrors: 0, maxRam: ram, events: /** @type {{ t: number, what: string }[]} */ ([]),
		history: /** @type {{ t: number, funds: number, round: number, public: boolean }[]} */ ([]),
	};
	const ownedSF = new Map(sourceFiles);
	const resetInfo = () => ({ currentNode: node, ownedSF, lastNodeReset: 0, lastAugReset: 0, ownedAugs: new Map(), bitNodeOptions: {} });
	const corpOrThrow = () => {
		if (!sim.corp) throw new Error("cannot be called without a corporation");
		return sim.corp;
	};
	const need = (unlock) => {
		if (!corpOrThrow().unlocks.has(unlock)) throw new Error("You do not have access to this API.");
	};
	const division = (name) => {
		const found = corpOrThrow().divisions.get(name);
		if (!found) throw new Error(`No division named '${name}'`);
		return found;
	};
	const spend = (cost, what) => {
		const corp = corpOrThrow();
		if (corp.funds < cost) throw new Error(`not enough funds for ${what}`);
		corp.funds -= cost;
	};
	const newOffice = () => ({ size: 3, jobs: {}, next: {}, avgEnergy: 100, avgMorale: 100, maxEnergy: 100, maxMorale: 100, tea: false, party: 0 });
	const newWarehouse = (corp, div) => ({ level: 1, smartSupplyEnabled: corp.unlocks.has("Smart Supply"), materials: Object.fromEntries(Object.keys(SIZES).map((name) => [name, { stored: 0, exports: [], sellAmount: "", sellPrice: "", produced: 0, sold: 0 }])), div });
	const employees = (office) => Object.values(office.next).reduce((sum, count) => sum + count, 0);
	const size = (corp, warehouse) => warehouse.level * 100 * (1 + 0.1 * corp.upgrades["Smart Storage"]) * (warehouse.div.research.has("Drones - Transport") ? 1.5 : 1);
	const used = (warehouse) => Object.entries(warehouse.materials).reduce((sum, [name, item]) => sum + item.stored * SIZES[name], 0)
		+ [...warehouse.div.products.values()].reduce((sum, product) => sum + (product.stored[warehouse.city] ?? 0) * 0.1, 0);

	const api = {
		hasCorporation: () => !!sim.corp,
		canCreateCorporation: (selfFund) => {
			if (!(node === 3 || ownedSF.has(3))) return "NoSf3OrDisabled";
			if (sim.corp) return "CorporationExists";
			if (node !== 3 && !selfFund) return "UseSeedMoneyOutsideBN3";
			return "Success";
		},
		createCorporation: (name, selfFund = true) => {
			if (api.canCreateCorporation(selfFund) !== "Success") return false;
			if (selfFund) {
				if (sim.player.money < 150e9) return false;
				sim.player.money -= 150e9;
			}
			sim.corp = {
				name, funds: 150e9, revenue: 0, expenses: 0, public: false, totalShares: selfFund ? 1e9 : 1.5e9, numShares: 1e9, fundingRound: 0,
				dividendRate: 0, valuations: [], valuation: 10e9, unlocks: new Set(node === 3 || (ownedSF.get(3) ?? 0) >= 3 ? ["Warehouse API", "Office API"] : []),
				upgrades: Object.fromEntries(Object.keys(UPGRADES).map((key) => [key, 0])), divisions: new Map(), lastAssets: 150e9, assets: 150e9, facilities: 0,
			};
			sim.events.push({ t: now, what: `created ${selfFund ? "self-funded" : "seed"}` });
			return true;
		},
		getConstants: () => ({ officeInitialCost: 4e9, warehouseInitialCost: 5e9, teaCostPerEmployee: 500e3, bribeThreshold: 100e12, bribeAmountPerReputation: 1e9, maxProductsBase: 3, dividendMaxRate: 1 }),
		getBonusTime: () => 0,
		nextUpdate: async () => {
			if (now >= end) throw new SimEnd();
			now += 2000;
			if (sim.corp) {
				const name = STATES[state];
				if (name === "START") startState();
				state = (state + 1) % STATES.length;
				return name;
			}
			return "START";
		},
		getIndustryData: (industry) => {
			corpOrThrow();
			if (!INDUSTRIES[industry]) throw new Error(`invalid industry ${industry}`);
			return structuredClone(INDUSTRIES[industry]);
		},
		getMaterialData: (name) => {
			corpOrThrow();
			return { name, size: SIZES[name] };
		},
		getCorporation: () => {
			const corp = corpOrThrow();
			return {
				name: corp.name, funds: corp.funds, revenue: corp.revenue, expenses: corp.expenses, public: corp.public, totalShares: corp.totalShares,
				numShares: corp.numShares, valuation: corp.valuation, dividendRate: corp.dividendRate, divisions: [...corp.divisions.keys()], nextState: STATES[state],
			};
		},
		getInvestmentOffer: () => {
			const corp = corpOrThrow();
			const rounds = [[0.1, 3], [0.35, 2], [0.25, 2], [0.2, 1.5]];
			if (corp.public || corp.fundingRound >= 4) return { funds: 0, shares: 0, round: corp.fundingRound + 1 };
			const [share, mult] = rounds[corp.fundingRound];
			return { funds: corp.valuation * share * mult, shares: Math.floor(1e9 * share), round: corp.fundingRound + 1 };
		},
		acceptInvestmentOffer: () => {
			const corp = corpOrThrow();
			const offer = api.getInvestmentOffer();
			if (!(offer.funds > 0)) return false;
			corp.funds += offer.funds;
			corp.numShares -= offer.shares;
			corp.fundingRound++;
			sim.events.push({ t: now, what: `accepted round ${offer.round}` });
			return true;
		},
		goPublic: (shares) => {
			const corp = corpOrThrow();
			if (corp.public) throw new Error("Corporation is already public");
			corp.public = true;
			corp.totalShares += shares;
			sim.events.push({ t: now, what: "public" });
			return true;
		},
		issueDividends: (rate) => {
			const corp = corpOrThrow();
			if (!corp.public) throw new Error("not public");
			if (rate < 0 || rate > 1) throw new Error("bad rate");
			corp.dividendRate = rate;
		},
		hasUnlock: (name) => corpOrThrow().unlocks.has(name),
		purchaseUnlock: (name) => {
			const corp = corpOrThrow();
			if (corp.unlocks.has(name)) throw new Error(`${name} has already been unlocked.`);
			spend(UNLOCKS[name], name);
			corp.unlocks.add(name);
		},
		getUpgradeLevel: (name) => corpOrThrow().upgrades[name],
		levelUpgrade: (name) => {
			const corp = corpOrThrow();
			const [base, mult] = UPGRADES[name];
			spend(base * mult ** corp.upgrades[name], name);
			corp.upgrades[name]++;
		},
		expandIndustry: (industry, name) => {
			const corp = corpOrThrow();
			if (corp.divisions.has(name)) throw new Error(`Division name ${name} is already in use!`);
			if (corp.divisions.size >= 20) throw new Error("too many divisions");
			spend(INDUSTRIES[industry].startingCost, "division");
			const div = { name, industry, awareness: 0, popularity: 0, researchPoints: 0, numAdVerts: 0, offices: {}, warehouses: {}, products: new Map(), research: new Set() };
			div.offices["Sector-12"] = newOffice();
			div.warehouses["Sector-12"] = { ...newWarehouse(corp, div), city: "Sector-12" };
			corp.divisions.set(name, div);
			corp.facilities += 2;
		},
		getDivision: (name) => {
			const div = division(name);
			const data = INDUSTRIES[div.industry];
			return {
				name, industry: div.industry, awareness: div.awareness, popularity: div.popularity, researchPoints: div.researchPoints, numAdVerts: div.numAdVerts,
				cities: Object.keys(div.offices), products: [...div.products.keys()], makesProducts: data.makesProducts,
				maxProducts: 3 + (div.research.has("uPgrade: Capacity.I") ? 1 : 0), lastCycleRevenue: div.revenue ?? 0, lastCycleExpenses: div.expenses ?? 0,
			};
		},
		expandCity: (name, city) => {
			const div = division(name);
			if (div.offices[city]) throw new Error(`You have already expanded into ${city}`);
			spend(4e9, "office");
			div.offices[city] = newOffice();
			corpOrThrow().facilities++;
		},
		purchaseWarehouse: (name, city) => {
			need("Warehouse API");
			const div = division(name);
			if (!div.offices[city] || div.warehouses[city]) return;
			spend(5e9, "warehouse");
			div.warehouses[city] = { ...newWarehouse(corpOrThrow(), div), city };
			corpOrThrow().facilities++;
		},
		upgradeWarehouse: (name, city, amount = 1) => {
			need("Warehouse API");
			const warehouse = division(name).warehouses[city];
			if (!warehouse) throw new Error("no warehouse");
			let cost = 0;
			for (let index = 0; index < amount; index++) cost += 1e9 * 1.07 ** (warehouse.level + 1 + index);
			spend(cost, "warehouse level");
			warehouse.level += amount;
		},
		getWarehouse: (name, city) => {
			need("Warehouse API");
			const warehouse = division(name).warehouses[city];
			if (!warehouse) throw new Error(`${name} does not have a warehouse in '${city}'`);
			const corp = corpOrThrow();
			return { level: warehouse.level, city, size: size(corp, warehouse), sizeUsed: used(warehouse), smartSupplyEnabled: warehouse.smartSupplyEnabled };
		},
		getMaterial: (name, city, material) => {
			need("Warehouse API");
			const warehouse = division(name).warehouses[city];
			if (!warehouse) throw new Error("no warehouse");
			const item = warehouse.materials[material];
			return {
				name: material, stored: item.stored, quality: 1, marketPrice: PRICES[material], productionAmount: item.produced / 10, actualSellAmount: item.sold / 10,
				desiredSellAmount: item.sellAmount, desiredSellPrice: item.sellPrice, exports: item.exports.map((entry) => ({ ...entry })), buyAmount: 0, importAmount: 0,
			};
		},
		setSmartSupply: (name, city, on) => {
			need("Warehouse API");
			if (!corpOrThrow().unlocks.has("Smart Supply")) throw new Error("no Smart Supply");
			division(name).warehouses[city].smartSupplyEnabled = on;
		},
		sellMaterial: (name, city, material, amount, price) => {
			need("Warehouse API");
			const item = division(name).warehouses[city].materials[material];
			item.sellAmount = String(amount).toUpperCase();
			item.sellPrice = String(price).toUpperCase();
		},
		bulkPurchase: (name, city, material, amount) => {
			need("Warehouse API");
			const warehouse = division(name).warehouses[city];
			if (used(warehouse) + amount * SIZES[material] > size(corpOrThrow(), warehouse) + 1e-6) throw new Error("You do not have enough warehouse size to fit this purchase");
			spend(amount * PRICES[material], "materials");
			warehouse.materials[material].stored += amount;
		},
		exportMaterial: (from, fromCity, to, toCity, material, amount) => {
			need("Warehouse API");
			if (!corpOrThrow().unlocks.has("Export")) throw new Error("You have not unlocked the Export feature!");
			const item = division(from).warehouses[fromCity].materials[material];
			if (!division(to).warehouses[toCity]) throw new Error("no warehouse there");
			if (item.exports.some((entry) => entry.division === to && entry.city === toCity)) throw new Error("Tried to initialize an export to a duplicate warehouse.");
			item.exports.push({ division: to, city: toCity, amount: String(amount).replace(/\s+/g, "").toUpperCase() });
		},
		cancelExportMaterial: (from, fromCity, to, toCity, material) => {
			need("Warehouse API");
			const item = division(from).warehouses[fromCity].materials[material];
			item.exports = item.exports.filter((entry) => !(entry.division === to && entry.city === toCity));
		},
		getOffice: (name, city) => {
			need("Office API");
			const office = division(name).offices[city];
			if (!office) throw new Error(`${name} has not expanded to '${city}'`);
			return { city, size: office.size, numEmployees: employees(office), avgEnergy: office.avgEnergy, avgMorale: office.avgMorale, maxEnergy: office.maxEnergy, maxMorale: office.maxMorale, employeeJobs: { ...office.jobs } };
		},
		upgradeOfficeSize: (name, city, increase) => {
			need("Office API");
			const office = division(name).offices[city];
			const cost = 4e9 / 0.09 * 1.09 ** (office.size / 3) * (1.09 ** (increase / 3) - 1);
			if (corpOrThrow().funds < cost) return;
			spend(cost, "office size");
			office.size += increase;
		},
		hireEmployee: (name, city, job = "Unassigned") => {
			need("Office API");
			const office = division(name).offices[city];
			if (employees(office) >= office.size) return false;
			office.next[job] = (office.next[job] ?? 0) + 1;
			return true;
		},
		setJobAssignment: (name, city, job, amount) => {
			need("Office API");
			const office = division(name).offices[city];
			const diff = amount - (office.next[job] ?? 0);
			if (diff === 0) return true;
			if (diff > (office.next.Unassigned ?? 0)) throw new Error("not enough unassigned employees");
			office.next.Unassigned = (office.next.Unassigned ?? 0) - diff;
			office.next[job] = amount;
			return true;
		},
		buyTea: (name, city) => {
			need("Office API");
			const office = division(name).offices[city];
			spend(500e3 * employees(office), "tea");
			office.tea = true;
			return true;
		},
		throwParty: (name, city, perEmployee) => {
			need("Office API");
			const office = division(name).offices[city];
			spend(perEmployee * employees(office), "party");
			office.party = perEmployee;
			return 1 + perEmployee / 1e7;
		},
		hireAdVert: (name) => {
			need("Office API");
			const div = division(name);
			const cost = 1e9 * 1.06 ** div.numAdVerts;
			if (corpOrThrow().funds < cost) return;
			spend(cost, "advert");
			const mult = 1 + 0.005 * corpOrThrow().upgrades["Wilson Analytics"];
			div.awareness = (div.awareness + 3 * mult) * 1.005 * mult;
			div.popularity = (div.popularity + mult) * 1.01 * mult;
			div.numAdVerts++;
		},
		hasResearched: (name, research) => {
			need("Office API");
			const div = division(name);
			if (!RESEARCH[research] || (PRODUCTS_ONLY.includes(research) && !INDUSTRIES[div.industry].makesProducts)) throw new Error(`No research named '${research}'`);
			return div.research.has(research);
		},
		research: (name, research) => {
			need("Office API");
			const div = division(name);
			if (div.research.has(research)) return;
			if (div.researchPoints < RESEARCH[research]) throw new Error(`You do not have enough Scientific Research for ${research}`);
			div.researchPoints -= RESEARCH[research];
			div.research.add(research);
		},
		makeProduct: (name, city, product, design, marketing) => {
			need("Warehouse API");
			const div = division(name);
			if (!div.offices[city]) throw new Error("Cannot develop a product in a city without an office!");
			if (div.products.size >= 3) throw new Error(`You are already at the max products (3) for division: ${name}!`);
			if (div.products.has(product)) throw new Error("You already have a product with this name!");
			spend(design + marketing, "product investment");
			div.products.set(product, { progress: 0, rating: 0, stored: {}, produced: {}, sold: {}, price: "", amount: "", ta2: false });
		},
		discontinueProduct: (name, product) => {
			need("Warehouse API");
			division(name).products.delete(product);
		},
		getProduct: (name, city, product) => {
			need("Warehouse API");
			const item = division(name).products.get(product);
			if (!item) throw new Error(`Invalid product name: '${product}'`);
			return {
				name: product, developmentProgress: item.progress, rating: item.rating, effectiveRating: item.rating, stored: item.stored[city] ?? 0,
				productionAmount: (item.produced[city] ?? 0) / 10, actualSellAmount: (item.sold[city] ?? 0) / 10, desiredSellPrice: item.price, desiredSellAmount: item.amount,
				productionCost: 1000,
			};
		},
		sellProduct: (name, city, product, amount, price) => {
			need("Warehouse API");
			const item = division(name).products.get(product);
			item.amount = String(amount).toUpperCase();
			item.price = String(price).toUpperCase();
		},
		setProductMarketTA2: (name, product, on) => {
			need("Warehouse API");
			const div = division(name);
			if (!div.research.has("Market-TA.II")) throw new Error("You have not researched Market-TA.II");
			div.products.get(product).ta2 = on;
		},
		bribe: (faction, cash) => {
			const corp = corpOrThrow();
			if (corp.valuation < 100e12 || corp.funds < cash) return false;
			corp.funds -= cash;
			sim.rep[faction] = (sim.rep[faction] ?? 0) + cash / 1e9;
			return true;
		},
	};
	sim.rep = /** @type {Record<string, number>} */ ({});

	/** One market cycle of the simplified economy, at START (the manager reads right after it). */
	function startState() {
		const corp = sim.corp;
		sim.cycles++;
		let revenue = 0;
		let expenses = 0;
		for (const div of corp.divisions.values()) {
			const data = INDUSTRIES[div.industry];
			div.revenue = 0;
			div.expenses = 0;
			for (const [city, office] of Object.entries(div.offices)) {
				office.jobs = { ...office.next };
				const count = employees(office);
				if (count >= 9) {
					office.avgEnergy = Math.max(10, office.avgEnergy - 0.4);
					office.avgMorale = Math.max(10, office.avgMorale - 0.4);
				}
				if (office.tea) office.avgEnergy = Math.min(office.maxEnergy, office.avgEnergy + 2);
				if (office.party) office.avgMorale = Math.min(office.maxMorale, office.avgMorale + office.party / 1e6 + 1);
				office.tea = false;
				office.party = 0;
				const salary = count * 5e4;
				div.expenses += salary;
				const rnd = office.jobs["Research & Development"] ?? 0;
				div.researchPoints += 0.5 * rnd * (office.avgEnergy * office.avgMorale / 1e4);
				const workers = (office.jobs.Operations ?? 0) + (office.jobs.Engineer ?? 0) + (office.jobs.Management ?? 0);
				const warehouse = div.warehouses[city];
				if (!warehouse) continue;
				let mult = 1;
				for (const [material, key] of Object.entries(BOOSTS)) mult *= (0.002 * warehouse.materials[material].stored + 1) ** (data[key] ?? 0);
				const productivity = workers * (mult ** 0.73) * (1 + 0.03 * corp.upgrades["Smart Factories"]) * (office.avgEnergy * office.avgMorale / 1e4);
				const salesForce = 0.4 + 0.6 * Math.min(1, ((office.jobs.Business ?? 0) + 1) / (workers + 1));
				if (data.makesMaterials) {
					// Output is capped by free warehouse space; MAX sells the Business share of everything stored (exports leave first)
					const unitSize = data.producedMaterials.reduce((sum, material) => sum + SIZES[material], 0);
					const room = Math.max(0, size(corp, warehouse) - used(warehouse)) / unitSize;
					const made = Math.min(productivity * 20, room) * (warehouse.smartSupplyEnabled ? 1 : 0);
					for (const material of data.producedMaterials) {
						const item = warehouse.materials[material];
						item.produced = made;
						let available = item.stored + made;
						for (const entry of item.exports) {
							const target = corp.divisions.get(entry.division)?.warehouses[entry.city];
							if (!target) continue;
							const moved = available * 0.3;
							target.materials[material].stored += moved;
							available -= moved;
						}
						const quality = 1 + Math.sqrt(div.researchPoints) / 20;
						const sold = item.sellAmount === "MAX" ? available * salesForce : 0;
						item.stored = available - sold;
						item.sold = sold;
						div.revenue += sold * PRICES[material] * quality;
					}
					div.expenses += made * PRICES.Water * 0.1;
				}
				if (data.makesProducts) {
					for (const [name, product] of div.products) {
						if (product.progress < 100) {
							if (city === "Sector-12") {
								product.progress = Math.min(100, product.progress + 2 + workers * 0.5);
								if (product.progress >= 100) product.rating = 50 + Math.sqrt(div.researchPoints) * 2 + workers;
							}
							continue;
						}
						const made = productivity * 5;
						const stored = (product.stored[city] ?? 0) + made;
						const kStar = demand * (2 + product.rating / 10) * (1 + 0.002 * div.numAdVerts);
						const k = product.ta2 ? kStar : Number(String(product.price).replace(/^MP\*?/, "") || (product.price === "MP" ? 1 : 0)) || (product.price === "MP" ? 1 : 0);
						const fraction = k <= 0 ? 0 : k <= kStar ? 1 : (kStar / k) ** 2;
						const sold = product.amount === "MAX" ? Math.min(stored, (made * 1.5 + 1) * fraction * salesForce) : 0;
						product.stored[city] = stored - sold;
						product.produced[city] = made;
						product.sold[city] = sold;
						div.revenue += sold * 1000 * k * 20;
						void name;
					}
				}
			}
			revenue += div.revenue / 10;
			expenses += div.expenses / 10;
		}
		corp.revenue = revenue;
		corp.expenses = expenses;
		const profit = (revenue - expenses) * 10;
		corp.funds += profit;
		if (corp.public && corp.dividendRate > 0 && profit > 0) {
			const total = corp.dividendRate * profit;
			corp.funds -= total;
			sim.player.money += (corp.numShares * total / corp.totalShares) ** 0.85;
		}
		let value = corp.public ? corp.funds + Math.max(0, profit / 10) * 85e3 : 10e9 + corp.funds / 3 + Math.max(0, profit / 10) * 315e3;
		value *= 1.0079741404289038 ** corp.facilities; // 1.1^(1/12) per office or warehouse (determineCycleValuation)
		corp.valuations.push(Math.max(10e9, value));
		if (corp.valuations.length > 10) corp.valuations.shift();
		corp.valuation = corp.valuations.reduce((sum, item) => sum + item, 0) / corp.valuations.length;
		sim.history.push({ t: now, funds: corp.funds, round: corp.fundingRound + 1, public: corp.public });
		if (corp.funds < -1) sim.errors.push(`funds went negative at cycle ${sim.cycles}: ${corp.funds}`);
	}

	/** An ns for a worker: corporation calls charged once each against the RAM it was started with. */
	function workerNs(allowed, args) {
		const charged = new Set();
		let usedRam = 1.6;
		const corporation = {};
		for (const [fn, impl] of Object.entries(api)) {
			corporation[fn] = (...rest) => {
				const name = `corporation.${fn}`;
				if (!charged.has(name)) {
					charged.add(name);
					usedRam += corpRamCost(name);
					if (usedRam > allowed * 1.00000000000001) {
						sim.ramErrors++;
						throw new Error(`Dynamic RAM usage calculated to be greater than RAM allocation (${usedRam} > ${allowed})`);
					}
				}
				try {
					return impl(...rest);
				} catch (error) {
					sim.callErrors.push(`${fn}: ${error.message}`);
					throw error;
				}
			};
		}
		return {
			args, corporation,
			singularity: { getFactionRep: (faction) => sim.rep[faction] ?? 0 },
			writePort: (port, data) => { ns.writePort(port, data); },
		};
	}

	const ns = fakeNs({
		files,
		overrides: {
			getResetInfo: resetInfo,
			corporation: api,
			getFunctionRamCost: (name) => corpRamCost(name),
			getScriptRam: () => 1.6,
			getHostname: () => "home",
			scan: () => [],
			hasRootAccess: () => true,
			getServerMaxRam: () => sim.maxRam,
			getServerUsedRam: () => 0,
			getServerMoneyAvailable: () => sim.player.money,
			getPlayer: () => ({ money: sim.player.money, factions: sim.player.factions }),
			fileExists: () => false,
			scp: () => true,
			dnet: { isDarknetServer: () => false },
			exec: (script, host, options, ...args) => {
				const allowed = typeof options === "object" ? options.ramOverride ?? 1.6 : 1.6;
				if (allowed > sim.maxRam) return 0;
				const calls = JSON.parse(String(args[0] ?? "[]"));
				sim.workers.push({ ram: allowed, calls });
				const pid = nextPid++;
				running.add(pid);
				callWorker(/** @type {any} */ (workerNs(allowed, args))).finally(() => running.delete(pid));
				return pid;
			},
			isRunning: (pid) => running.has(pid),
			sleep: async (ms) => {
				now += ms;
				if (now >= end) throw new SimEnd();
				await Promise.resolve();
			},
		},
	});
	sim.ns = ns;
	/** Runs `main` for `ms` of simulated time (Date.now follows the simulated clock). */
	sim.run = async (main, ms) => {
		end = now + ms;
		const realNow = Date.now;
		Date.now = () => now;
		try {
			await main(ns);
		} catch (error) {
			if (!(error instanceof SimEnd)) throw error;
		} finally {
			Date.now = realNow;
		}
	};
	sim.now = () => now;
	/** The summary the manager posted on port 48. */
	sim.summary = () => ns.portJson(48);
	return sim;
}
