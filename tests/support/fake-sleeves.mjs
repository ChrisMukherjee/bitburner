// A small game world with sleeves, for the scripts in sleeves/: the Sleeve API over a mutable list of sleeves (tasks, shock, sync,
// memory, augmentations on offer), plus the one-shot workers the manager and the shop start, played with the real worker code
// (exec runs the worker's main at once and it exits).
//
//   const sim = sleeveWorld({ node: 10, sleeves: [{ shock: 90 }, {}], money: 1e9 });
//   await main(sim.ns);               // sleeves/sleeve-manager.js
//   sim.sleeves[0].task               // { type: "RECOVERY" }
//   sim.calls("setToCommitCrime")     // [[1, "Shoplift"]] (arguments of each call)
import { fakeWorld } from "./fake-world.mjs";
import { main as recover } from "/sleeves/workers/recover.js";
import { main as crime } from "/sleeves/workers/crime.js";
import { main as train } from "/sleeves/workers/train.js";
import { main as work } from "/sleeves/workers/work.js";
import { main as blade } from "/sleeves/workers/blade.js";
import { main as crimeStats } from "/sleeves/workers/crime-stats.js";
import { main as augValues } from "/sleeves/workers/aug-values.js";

const WORKERS = {
	"sleeves/workers/recover.js": recover, "sleeves/workers/crime.js": crime, "sleeves/workers/train.js": train,
	"sleeves/workers/work.js": work, "sleeves/workers/blade.js": blade, "sleeves/workers/crime-stats.js": crimeStats,
	"sleeves/workers/aug-values.js": augValues,
};
const SKILLS = { hacking: 200, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 };
const CRIME_TABLE = {
	Shoplift: { difficulty: 0.05, time: 2000, money: 15e3, karma: 0.1, hacking_success_weight: 0, strength_success_weight: 0, defense_success_weight: 0, dexterity_success_weight: 1, agility_success_weight: 1, charisma_success_weight: 0 },
	Homicide: { difficulty: 1, time: 3000, money: 45e3, karma: 3, hacking_success_weight: 0, strength_success_weight: 2, defense_success_weight: 2, dexterity_success_weight: 0.5, agility_success_weight: 0.5, charisma_success_weight: 0 },
};

/**
 * @param {object} [options]
 * @param {number} [options.node]  current BitNode
 * @param {Array<[number, number]>} [options.sourceFiles]
 * @param {Array<Partial<{ shock: number, sync: number, memory: number, city: string, skills: Record<string, number>, task: any }>>} [options.sleeves]
 * @param {number} [options.money]
 * @param {number} [options.sleeveCost]    price of the next sleeve (Infinity = none for sale)
 * @param {number} [options.memoryCost]
 * @param {Array<{ name: string, cost: number }>} [options.augs] on offer to every sleeve
 * @param {string[]} [options.refuse]      setTo* kinds the game refuses ("faction", "company", "bb", "crime"...)
 * @param {Record<string, any>} [options.ports]
 * @param {Record<string, string>} [options.files]
 * @param {(script: string) => number} [options.scriptRam] RAM of each script (2GB by default)
 * @param {Record<string, any>} [options.overrides]
 */
export function sleeveWorld({
	node = 10, sourceFiles = [], sleeves = [{}], money = 0, sleeveCost = 1e6, memoryCost = 1e5, augs = [], refuse = [], ports = {}, files = {}, scriptRam = () => 2, overrides = {},
} = {}) {
	const list = sleeves.map((sleeve) => ({
		shock: 0, sync: 100, memory: 50, city: "Sector-12", task: null, augs: [], ...sleeve,
		skills: { ...SKILLS, ...sleeve.skills },
	}));
	const log = [];
	const record = (name, args) => log.push({ name, args });
	const take = (kind, index, task) => {
		record(kind, [index]);
		if (refuse.includes(kind)) return false;
		list[index].task = task;
		return true;
	};
	const wallet = { money };
	const api = {
		getNumSleeves: () => list.length,
		getSleeve: (index) => ({ ...list[index], mults: { crime_success: 1 }, hp: {}, exp: {}, storedCycles: 0 }),
		getTask: (index) => list[index].task,
		setToShockRecovery: (index) => take("recover", index, { type: "RECOVERY" }),
		setToSynchronize: (index) => take("sync", index, { type: "SYNCHRO" }),
		setToCommitCrime: (index, crimeType) => { record("setToCommitCrime", [index, crimeType]); return take("crime", index, { type: "CRIME", crimeType }); },
		setToGymWorkout: (index, gym, stat) => {
			record("setToGymWorkout", [index, gym, stat]);
			return take("gym", index, { type: "CLASS", classType: { str: "GYMSTRENGTH", def: "GYMDEFENSE", dex: "GYMDEXTERITY", agi: "GYMAGILITY" }[stat], location: gym });
		},
		setToUniversityCourse: (index, university, course) => { record("setToUniversityCourse", [index, university, course]); return take("class", index, { type: "CLASS", classType: "STUDYCOMPUTERSCIENCE", location: university }); },
		travel: (index, city) => { record("travel", [index, city]); if (refuse.includes("travel")) return false; list[index].city = city; return true; },
		setToFactionWork: (index, faction, workType) => { record("setToFactionWork", [index, faction, workType]); return take("faction", index, { type: "FACTION", factionName: faction, factionWorkType: workType }); },
		setToCompanyWork: (index, company) => { record("setToCompanyWork", [index, company]); return take("company", index, { type: "COMPANY", companyName: company }); },
		setToBladeburnerAction: (index, action, contract) => { record("setToBladeburnerAction", [index, action, contract]); return take("bb", index, { type: "BLADEBURNER", actionType: "Contracts", actionName: contract ?? action }); },
		getSleeveCost: () => (list.length >= 8 ? Infinity : sleeveCost), // the game sells up to 8 in all
		purchaseSleeve: () => {
			record("purchaseSleeve", []);
			if (wallet.money < sleeveCost) return { success: false, message: "no money" };
			wallet.money -= sleeveCost;
			list.push({ shock: 100, sync: 1, memory: 1, city: "Sector-12", task: null, augs: [], skills: { ...SKILLS } });
			return { success: true };
		},
		getMemoryUpgradeCost: () => memoryCost,
		upgradeMemory: (index, amount) => {
			record("upgradeMemory", [index, amount]);
			if (wallet.money < memoryCost) return { success: false, message: "no money" };
			wallet.money -= memoryCost;
			list[index].memory += amount;
			return { success: true };
		},
		getSleevePurchasableAugs: (index) => augs.filter((aug) => !list[index].augs.includes(aug.name)),
		purchaseSleeveAug: (index, name) => {
			record("purchaseSleeveAug", [index, name]);
			const aug = augs.find((item) => item.name === name);
			if (!aug || wallet.money < aug.cost) return false;
			wallet.money -= aug.cost;
			list[index].augs.push(name);
			return true;
		},
	};

	const world = fakeWorld({
		node, sourceFiles, money, files, ports,
		homeRam: 128,
		scriptRam,
		homeFiles: [],
		onExec: (script, args, game) => {
			const worker = WORKERS[script];
			if (!worker) return undefined;
			const ns = new Proxy(game.ns, { get: (target, key) => (key === "args" ? args : target[key]) });
			worker(ns);
			return { exits: true };
		},
		overrides: {
			sleeve: api,
			getResetInfo: () => ({ currentNode: node, ownedSF: new Map(sourceFiles), lastAugReset: 0, lastNodeReset: 1000, ownedAugs: new Map(), bitNodeOptions: {} }),
			getPlayer: () => ({ money: wallet.money, factions: world.player.factions, jobs: world.player.jobs, karma: 0 }),
			getTotalScriptIncome: () => [0, 0],
			getHostname: () => "home",
			enums: { CrimeType: { shoplift: "Shoplift", homicide: "Homicide" } },
			singularity: { getCrimeStats: (name) => CRIME_TABLE[name], getAugmentationStats: (name) => ({ hacking: name.includes("Hack") ? 1.1 : 1 }) },
			...overrides,
		},
	});
	world.player = { factions: [], jobs: {} };
	return Object.assign(world, {
		sleeves: list,
		wallet,
		/** Arguments of every call to a Sleeve API function recorded under this name. */
		calls: (name) => log.filter((entry) => entry.name === name).map((entry) => entry.args),
		apiLog: log,
	});
}
