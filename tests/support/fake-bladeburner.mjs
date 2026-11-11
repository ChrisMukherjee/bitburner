// A small Bladeburner simulator for running bladeburner/bb-pass.js pass after pass (as startup.js does, about every 30 s) and
// node-eta.js on the state it leaves on port 36, on a mocked clock.
//
//   const sim = bladeburnerSim({ rank: 10, actions: { Tracking: { count: 3 } } });
//   await sim.passes(main, 40);            // 40 passes of bb-pass.js, 30 simulated seconds apart (the game plays in between)
//   sim.rank, sim.started, sim.ns          // what happened
//
// The game side: one action at a time, repeated by the game until its count runs out (the player is then idle until the next
// pass) or stamina can't pay for it; stamina falls per attempt and regenerates by itself, Hyperbolic Regeneration Chamber adds
// 1 % of the maximum per minute; rank and counts follow the expected value (chance x gain), so a run is repeatable; Field
// Analysis narrows every estimate range, Training raises every chance a little; the Black Ops run in order, each needing its
// rank; Recruitment adds a team member. Simplifications: no skills, no stamina penalty on the chance, no cities' effect on chances
// (the city only changes what the population readings say), flat rates.
import { fakeNs } from "./fake-ns.mjs";

export const START = 1_800_000_000_000;
const BLACK_OPS = [["Operation Typhoon", 2500], ["Operation Zero", 5000], ["Operation X", 7500], ["Operation Titan", 10000]];

/** The Contracts and Operations a fresh player has: estimated chance, rank per success, seconds, stamina per attempt, counts. */
export const ACTION_TABLE = {
	"Tracking": { type: "Contracts", chance: 0.85, gain: 0.4, secs: 5, stamina: 1, count: 30 },
	"Bounty Hunter": { type: "Contracts", chance: 0.75, gain: 0.6, secs: 10, stamina: 1.5, count: 20 },
	"Retirement": { type: "Contracts", chance: 0.7, gain: 0.7, secs: 10, stamina: 1.5, count: 20 },
	"Investigation": { type: "Operations", chance: 0.5, gain: 2.2, secs: 10, stamina: 2, count: 5 },
	"Undercover Operation": { type: "Operations", chance: 0.45, gain: 4.4, secs: 15, stamina: 2.5, count: 5 },
	"Sting Operation": { type: "Operations", chance: 0.4, gain: 5.5, secs: 20, stamina: 3, count: 5 },
	"Raid": { type: "Operations", chance: 0.3, gain: 55, secs: 66, stamina: 4, count: 5 },
	"Stealth Retirement Operation": { type: "Operations", chance: 0.25, gain: 80, secs: 80, stamina: 5, count: 5 },
	"Assassination": { type: "Operations", chance: 0.2, gain: 110, secs: 100, stamina: 6, count: 5 },
};

/**
 * @param {object} [options]
 * @param {number} [options.rank]
 * @param {number} [options.stamina]          current stamina (maximum 100 unless `maxStamina`)
 * @param {number} [options.maxStamina]
 * @param {number} [options.regen]            stamina per second without resting
 * @param {Record<string, object>} [options.actions]   per action: overrides of ACTION_TABLE (chance, gain, secs, stamina, count, spread)
 * @param {number} [options.spread]           half-width of every estimate range at the start (Field Analysis narrows it)
 * @param {Array<[string, number]>} [options.blackOps]  [name, rank needed] in order
 * @param {number} [options.blackOpChance]    true chance of every Black Op
 * @param {number} [options.blackOpSecs]      seconds one Black Op attempt takes
 * @param {number} [options.recruitSecs]      seconds one Recruitment takes
 * @param {number} [options.recruitChance]    Recruitment's success chance
 * @param {Record<string, {pop: number, chaos: number}>} [options.cities]
 * @param {string} [options.city]
 * @param {object} [options.config]           data/config.json
 * @param {object} [options.post]             port 36 at the start (state "run" is added)
 * @param {object} [options.player]           overrides of getPlayer()
 * @param {number} [options.income]           $/s
 * @param {object} [options.overrides]        extra ns members
 */
export function bladeburnerSim({
	rank = 0, stamina = 100, maxStamina = 100, regen = 0.2, actions = {}, spread = 0.02, blackOps = BLACK_OPS, blackOpChance = 0.9,
	blackOpSecs = 30, recruitSecs = 60, recruitChance = 0.5, cities = { "Sector-12": { pop: 1e9, chaos: 0 } }, city = "Sector-12", config = {}, post = {}, player = {}, income = 0, route = null, overrides = {},
} = {}) {
	let now = START;
	const table = {};
	for (const [name, base] of Object.entries(ACTION_TABLE)) {
		const own = actions[name] ?? {};
		table[name] = { ...base, ...own, spread: own.spread ?? spread, total: own.count ?? base.count };
	}
	const sim = {
		rank, stamina, maxStamina, city, cities, trained: 0, recruited: 0, blackOpsDone: 0, blackOpTries: 0,
		joined: true,
		refuse: new Set(), // action names startAction answers false for
		current: null,           // { type, name } the game is repeating
		started: [],             // { time, type, name } every startAction that took
		refused: [],             // { type, name } startAction calls answered false
		moves: [],               // cities moved to
		diplomacy: 0,
		lines: [],               // each pass's log lines
		passCount: 0,
		now: () => now,
		minutes: () => (now - START) / 60_000,
		table,
		/** What the game does with a long wait: the running action repeats, stamina regenerates, counts come back. */
		advance(ms) {
			let left = ms;
			while (left > 0) {
				const action = sim.current;
				if (!action) { regenerate(left / 1000); now += left; left = 0; break; }
				const step = Math.min(left, sim.remainingMs);
				regenerate(step / 1000);
				now += step;
				left -= step;
				sim.remainingMs -= step;
				if (sim.remainingMs > 0) break;
				finish(action);
				if (sim.current) sim.remainingMs = secondsOf(sim.current) * 1000;
			}
		},
		remainingMs: 0,
	};
	const secondsOf = (action) => {
		if (action.type === "General") return GENERAL_SECS[action.name] ?? 30;
		if (action.type === "Black Operations") return blackOpSecs;
		return table[action.name].secs;
	};
	const GENERAL_SECS = { "Hyperbolic Regeneration Chamber": 60, "Field Analysis": 30, "Training": 30, "Recruitment": recruitSecs, "Diplomacy": 60 };
	const regenerate = (seconds) => {
		sim.hackExp += seconds * sim.expRate;
		const resting = sim.current?.name === "Hyperbolic Regeneration Chamber";
		sim.stamina = Math.min(sim.maxStamina, sim.stamina + seconds * regen + (resting ? (seconds / 60) * sim.maxStamina * 0.01 : 0));
		for (const entry of Object.values(table)) entry.count = Math.min(entry.total + 50, entry.count + seconds * (entry.growth ?? 0));
	};
	const trainBonus = () => 1 + 0.002 * sim.trained;
	const chanceOf = (name) => Math.min(1, table[name].chance * trainBonus());
	const finish = (action) => {
		if (action.type === "General") {
			if (action.name === "Field Analysis") { for (const entry of Object.values(table)) entry.spread *= 0.8; sim.blackOpSpread *= 0.8; }
			if (action.name === "Training") sim.trained++;
			if (action.name === "Recruitment") sim.recruited++;
			if (action.name === "Diplomacy") sim.diplomacy++;
			return;
		}
		if (action.type === "Black Operations") {
			sim.blackOpTries++;
			const [, needed] = blackOps[sim.blackOpsDone] ?? [];
			if (sim.rank >= needed && sim.blackOpWins(sim.blackOpsDone)) { sim.rank += BLACK_OP_GAIN; sim.blackOpsDone++; }
			sim.current = null; // a Black Op is one attempt
			return;
		}
		const entry = table[action.name];
		sim.stamina -= entry.stamina;
		entry.count -= 1;
		sim.rank += chanceOf(action.name) * entry.gain;
		if (entry.count < 1 || sim.stamina < entry.stamina) sim.current = null; // the game stops it: the player idles until the next pass
	};
	const BLACK_OP_GAIN = 200;
	/** Whether the nth Black Op attempt succeeds (always, by default); a test replaces it to make one fail. */
	sim.blackOpWins = () => true;

	const range = (name) => {
		const entry = table[name];
		const chance = chanceOf(name);
		return [Math.max(0, chance - entry.spread), Math.min(1, chance + entry.spread)];
	};
	const bladeburner = {
		inBladeburner: () => sim.joined,
		getStamina: () => [sim.stamina, sim.maxStamina],
		getCurrentAction: () => (sim.current ? { ...sim.current } : null),
		getRank: () => sim.rank,
		getNextBlackOp: () => (sim.blackOpsDone < blackOps.length ? { name: blackOps[sim.blackOpsDone][0], rank: blackOps[sim.blackOpsDone][1] } : null),
		getBlackOpNames: () => blackOps.map(([name]) => name),
		getActionEstimatedSuccessChance: (type, name) => {
			if (type === "Black Operations") return [Math.max(0, blackOpChance - sim.blackOpSpread), Math.min(1, blackOpChance + sim.blackOpSpread)];
			if (type === "General") {
				if (name === "Recruitment") return [recruitChance, recruitChance];
				return [1, 1];
			}
			if (!table[name]) throw new Error(`no action ${name}`);
			return range(name);
		},
		getActionRankGain: (type, name) => (type === "Black Operations" ? BLACK_OP_GAIN : table[name].gain),
		getActionTime: (type, name) => secondsOf({ type, name }) * 1000,
		getActionCurrentLevel: (type, name) => table[name]?.level ?? 1,
		getActionMaxLevel: (type, name) => table[name]?.maxLevel ?? 1,
		getActionCountRemaining: (type, name) => Math.floor(table[name].count),
		getCityChaos: (name) => sim.cities[name ?? sim.city].chaos,
		getCityEstimatedPopulation: (name) => sim.cities[name].pop,
		getCity: () => sim.city,
		startAction: (type, name) => {
			let taken = false;
			if (sim.refuse.has(name)) taken = false;
			else if (type === "General") taken = name in GENERAL_SECS;
			else if (type === "Black Operations") taken = sim.getNextBlackOpName() === name && sim.rank >= blackOps[sim.blackOpsDone][1];
			else taken = !!table[name] && table[name].type === type && table[name].count >= 1;
			if (!taken) { sim.refused.push({ type, name }); return false; }
			sim.current = { type, name };
			sim.remainingMs = secondsOf(sim.current) * 1000;
			sim.started.push({ time: sim.minutes(), type, name, stamina: sim.stamina });
			return true;
		},
		switchCity: (name) => { sim.moves.push(name); sim.city = name; return true; },
	};
	sim.blackOpSpread = 0.02;
	sim.income = income; // $/s the running scripts earn
	sim.scriptName = "bladeburner/bb-pass.js";
	sim.hackExp = route?.exp ?? 0;       // hacking exp (advances by expRate per second)
	sim.expRate = route?.expRate ?? 0;
	sim.resetAt = START - 4 * 3600_000; // getResetInfo().lastAugReset
	sim.getNextBlackOpName = () => blackOps[sim.blackOpsDone]?.[0];

	const ns = fakeNs({
		files: Object.keys(config).length ? { "data/config.json": JSON.stringify(config) } : {},
		ports: { 36: { state: "run", stateTime: START, ...post } },
		overrides: {
			getScriptName: () => sim.scriptName,
			getPlayer: () => ({ hp: { current: 100, max: 100 }, money: 1e9, skills: { hacking: 100, strength: 200, defense: 200, dexterity: 200, agility: 200, charisma: 50, intelligence: 1 }, mults: {}, ...player }),
			getTotalScriptIncome: () => [sim.income, 0],
			bladeburner,
			...(route ? routeMembers(sim, route) : {}),
			...overrides,
		},
	});
	sim.ns = ns;
	/** Keeps the manager's "run" state fresh, as bb-manage.js does every few seconds. */
	sim.keepRunning = () => {
		const port = ns.portJson(36) ?? {};
		port.stateTime = now;
		ns.ports[36] = JSON.stringify(port);
	};
	/** `count` passes of `main`, `between` ms apart; the game plays on in between. Date.now follows the simulated clock. */
	sim.passes = async (main, count, between = 30_000) => {
		const realNow = Date.now;
		Date.now = () => now;
		try {
			for (let pass = 0; pass < count; pass++) {
				if (sim.running !== false) sim.keepRunning();
				const before = ns.logs.length;
				await main(ns);
				sim.lines.push(ns.logs.slice(before));
				sim.passCount++;
				sim.advance(between);
			}
		} finally {
			Date.now = realNow;
		}
	};
	/** `count` runs of node-eta.js's main (as startup.js runs it every few minutes), `between` ms apart; returns the report text. */
	sim.etaRuns = async (main, count = 1, between = 120_000) => {
		const realNow = Date.now;
		Date.now = () => now;
		sim.scriptName = "bladeburner/node-eta.js";
		try {
			for (let run = 0; run < count; run++) {
				await main(ns);
				if (run < count - 1 || between < 0) sim.advance(Math.abs(between));
			}
		} finally {
			sim.scriptName = "bladeburner/bb-pass.js";
			Date.now = realNow;
		}
		return ns.read("data/node-eta.txt");
	};
	/** Runs `fn` with Date.now on the simulated clock (for node-eta.js and other one-offs). */
	sim.at = async (fn) => {
		const realNow = Date.now;
		Date.now = () => now;
		try { return await fn(); } finally { Date.now = realNow; }
	};
	return sim;
}

// ---- what node-eta.js reads
const HACK_AUGS = {
	"BitWire": { stats: { hacking: 1.05 }, price: 1e6, rep: 1500 },
	"Cranial Signal Processors - Gen II": { stats: { hacking: 1.07, hacking_exp: 1.15 }, price: 5e6, rep: 4000 },
	"Neurotrainer I": { stats: { hacking_exp: 1.1 }, price: 4e5, rep: 500 },
};
const COMBAT_AUGS = {
	"Bionic Arms": { stats: { strength: 1.3, dexterity: 1.3 }, price: 2.5e8, rep: 62500 },
	"Combat Rib I": { stats: { strength: 1.2, defense: 1.2 }, price: 2e7, rep: 7500 },
};

/** The game's skill from exp and multiplier. */
export const skillAt = (exp, mult) => Math.max(1, Math.floor(mult * (32 * Math.log(exp + 534.5) - 200)));

/**
 * The ns members node-eta.js reads on top of what bb-pass.js reads: BitNode and Source-Files, the hacking exp and levels,
 * the augmentation catalog of a few factions, Daedalus and The Red Pill.
 * @param {any} sim
 * @param {{ node?: number, ownedSF?: Map<number, number>, hostname?: string, hackMult?: number, factions?: string[], owned?: string[], queued?: string[],
 *   catalog?: Record<string, string[]>, daedalus?: object[], favor?: Record<string, number>, rep?: Record<string, number>, server?: object|null }} route
 */
function routeMembers(sim, route) {
	const { node = 6, ownedSF = new Map([[4, 3]]), hostname = "home", hackMult = 1, factions = ["CyberSec"], owned = ["NeuroFlux Governor"], queued = [], favor = {}, rep = {}, server = null } = route;
	const catalog = route.catalog ?? { "CyberSec": ["BitWire", "Neurotrainer I"], "Aevum": ["Cranial Signal Processors - Gen II"], "Tetrads": ["Combat Rib I"], "Volhaven": ["Bionic Arms"] };
	const daedalus = route.daedalus ?? [{ type: "numAugmentations", numAugmentations: 30 }, { type: "money", money: 1e11 }];
	const all = { ...HACK_AUGS, ...COMBAT_AUGS, "The Red Pill": { stats: {}, price: 0, rep: 2.5e6 }, "NeuroFlux Governor": { stats: { hacking: 1.01, strength: 1.01 }, price: 1e7, rep: 5000 } };
	const mults = { hacking: hackMult, hacking_exp: 1, strength_exp: 1, faction_rep: 1, bladeburner_stamina_gain: 1, bladeburner_success_chance: 1 };
	const skills = () => ({ hacking: skillAt(sim.hackExp, hackMult), strength: 200, defense: 200, dexterity: 200, agility: 200, charisma: 50, intelligence: 1 });
	sim.etaFiles = [];
	return {
		getHostname: () => hostname,
		getResetInfo: () => ({ currentNode: node, ownedSF, lastAugReset: sim.resetAt, bitNodeOptions: {} }),
		getPlayer: () => ({ hp: { current: 100, max: 100 }, money: 1e9, skills: skills(), exp: { hacking: sim.hackExp }, mults, factions: [...factions] }),
		getServer: (name) => { if (server && name === "w0r1d_d43m0n") return server; throw new Error(`no server ${name}`); },
		getFavorToDonate: () => 150,
		getServerMoneyAvailable: () => 1e9,
		fileExists: (file) => file in sim.ns.files,
		scp: (files, to, from) => { sim.etaFiles.push({ files, to, from }); return true; },
		singularity: {
			getOwnedAugmentations: (purchased) => (purchased ? [...owned, ...queued] : [...owned]),
			getAugmentationRepReq: (name) => (all[name] ?? { rep: 1000 }).rep,
			getAugmentationPrice: (name) => (all[name] ?? { price: 1e6 }).price,
			getAugmentationStats: (name) => ({ ...(all[name]?.stats ?? {}) }),
			getAugmentationsFromFaction: (faction) => {
				if (faction === "Daedalus") return ["The Red Pill"];
				if (!catalog[faction]) throw new Error(`no faction ${faction}`);
				return [...catalog[faction], "NeuroFlux Governor"];
			},
			getFactionFavor: (faction) => favor[faction] ?? 0,
			getFactionRep: (faction) => rep[faction] ?? 0,
			getFactionInviteRequirements: (faction) => { if (faction === "Daedalus") return daedalus; throw new Error("no requirements"); },
		},
	};
}
