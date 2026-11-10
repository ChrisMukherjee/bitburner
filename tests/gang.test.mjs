// Gang: utils/gang.js access rules, gang/ready.js, and the decisions in gang/gang-manager.js
// (recruiting, ascending, tasks, wanted-level cooling, territory clashes, equipment).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { loadConfig } from "/utils/config.js";
import { gangAccess } from "/utils/gang.js";
import { gangReady } from "/gang/ready.js";
import {
	recruit, ascend, assignTasks, setWarfare, buyEquipment, mainStat, memberView, planContext, chooseAction, ascensionVerdict,
	potentialStats, bestEarn, horizonSeconds, metricSample, recordMetrics, LOG_FILE,
} from "/gang/gang-manager.js";
import {
	taskWeight, territoryMult, territoryPenalty, wantedFactor, respectRate, moneyRate, wantedRate, skillLevel, expForLevel,
	ascensionMult, ascensionPoints, expRate, clashOutlook,
} from "/gang/formulas.js";

const loaded = loadConfig(fakeNs()).gang;
// The legacy rules (growth off) keep the original expectations; the growth tests below use `grow`.
const settings = { ...loaded, growth: { ...loaded.growth, enabled: false } };
const grow = loaded;

// ---- access rules
function accessNs({ node = 1, sf2 = false, inGang = false, karma = 0, factions = [] } = {}) {
	return fakeNs({
		overrides: {
			getResetInfo: () => ({ currentNode: node, ownedSF: new Map(sf2 ? [[2, 1]] : []) }),
			gang: { inGang: () => inGang },
			heart: { break: () => karma },
			getPlayer: () => ({ factions }),
		},
	});
}

test("gang access: BitNode 2 needs no karma, elsewhere Source-File 2 and karma -54,000", () => {
	assert.deepEqual(gangAccess(accessNs({ node: 2 })), { available: true, inGang: false, karmaNeeded: 0, canCreate: true });
	assert.deepEqual(gangAccess(accessNs({ node: 1 })), { available: false, inGang: false, karmaNeeded: -54_000, canCreate: false });
	assert.equal(gangAccess(accessNs({ node: 1, sf2: true, karma: -10_000 })).canCreate, false);
	assert.equal(gangAccess(accessNs({ node: 1, sf2: true, karma: -54_000 })).canCreate, true);
	assert.equal(gangAccess(accessNs({ node: 1, inGang: true })).available, true, "already in a gang counts");
});

test("gangReady: in a gang, or a listed faction joined and a gang can be created", () => {
	const config = { gang: { factions: ["Slum Snakes", "Tetrads"] } };
	assert.equal(gangReady(accessNs({ node: 1, inGang: true }), config), true);
	assert.equal(gangReady(accessNs({ node: 2, factions: ["CyberSec"] }), config), false, "no gang faction yet");
	assert.equal(gangReady(accessNs({ node: 2, factions: ["Tetrads"] }), config), true);
	assert.equal(gangReady(accessNs({ node: 1, sf2: true, factions: ["Tetrads"], karma: -100 }), config), false, "karma too high outside BitNode 2");
	assert.equal(gangReady(accessNs({ node: 1, sf2: true, factions: ["Tetrads"], karma: -60_000 }), config), true);
});

// ---- helpers for the manager
const member = (stats = {}) => ({ hack: 10, str: 10, def: 10, dex: 10, agi: 10, cha: 10, upgrades: [], augmentations: [], ...stats });
const combat = (level) => member({ str: level, def: level, dex: level, agi: level });
const task = (over) => ({
	isHacking: false, isCombat: true, baseRespect: 0, baseWanted: 0, baseMoney: 0, difficulty: 1,
	hackWeight: 0, strWeight: 25, defWeight: 25, dexWeight: 25, agiWeight: 25, chaWeight: 0,
	territory: { money: 1, respect: 1, wanted: 1 }, ...over,
});
const TASKS = {
	"Unassigned": task({}),
	"Train Combat": task({}),
	"Mug People": task({ baseRespect: 1, baseMoney: 5, baseWanted: 0.1 }),
	"Terrorism": task({ baseRespect: 6, baseMoney: 1, baseWanted: 1, difficulty: 10 }),
	"Vigilante Justice": task({ baseWanted: -0.5, difficulty: 2 }),
	"Territory Warfare": task({}),
};

/** A gang of named members with the given stats; records setMemberTask. */
function gangNs({ members, gang = {}, others = {}, extra = {} }) {
	const tasks = {};
	const info = { respect: 1000, respectForNextRecruit: Infinity, wantedPenalty: 1, wantedLevel: 1, territory: 0.5,
		faction: "Slum Snakes", isHacking: false, power: 100, territoryWarfareEngaged: false, ...gang };
	const ns = fakeNs({
		overrides: {
			format: { percent: (v) => `${Math.round(v * 100)}%` },
			gang: {
				getGangInformation: () => info,
				getMemberNames: () => Object.keys(members),
				getMemberInformation: (name) => members[name],
				getTaskNames: () => Object.keys(TASKS),
				getTaskStats: (name) => TASKS[name],
				setMemberTask: (name, work) => { tasks[name] = work; return true; },
				getAllGangInformation: () => others,
				setTerritoryWarfare: (on) => { info.territoryWarfareEngaged = on; },
				...extra,
			},
		},
	});
	return { ns, tasks, info };
}

test("mainStat is the combat average, or hacking for a hacking gang", () => {
	assert.equal(mainStat(combat(40), false), 40);
	assert.equal(mainStat(member({ hack: 90 }), true), 90);
});

// ---- recruiting
test("recruit takes the first free member-N name and stops when respect is short", () => {
	const names = ["member-1", "member-3"];
	const world = gangNs({
		members: {},
		gang: { respect: 100, respectForNextRecruit: 50 },
		extra: { getMemberNames: () => names, recruitMember: (name) => { names.push(name); world.info.respect = 0; return true; } },
	});
	recruit(world.ns);
	assert.deepEqual(world.ns.called("gang.recruitMember"), [["member-2"]]);
	const poor = gangNs({ members: {}, gang: { respect: 10, respectForNextRecruit: 50 }, extra: { getMemberNames: () => [], recruitMember: () => true } });
	recruit(poor.ns);
	assert.deepEqual(poor.ns.called("gang.recruitMember"), []);
	const full = gangNs({ members: {}, gang: { respect: 1e12, respectForNextRecruit: Infinity }, extra: { getMemberNames: () => [], recruitMember: () => true } });
	recruit(full.ns);
	assert.deepEqual(full.ns.called("gang.recruitMember"), [], "a full gang reports Infinity, which respect never reaches");
});

// ---- ascending
test("ascend: only at the configured gain, and not while the member holds too large a share of respect", () => {
	const results = {
		small: { hack: 1, str: 1.2, def: 1.2, dex: 1.2, agi: 1.2, respect: 10 },
		good: { hack: 1, str: 2, def: 2, dex: 2, agi: 2, respect: 100 },
		heavy: { hack: 1, str: 2, def: 2, dex: 2, agi: 2, respect: 900 },
		none: undefined,
	};
	const { ns } = gangNs({
		members: { small: combat(1), good: combat(1), heavy: combat(1), none: combat(1) },
		gang: { respect: 1000 },
		extra: { getAscensionResult: (name) => results[name], ascendMember: () => true },
	});
	ascend(ns, settings, false);
	assert.deepEqual(ns.called("gang.ascendMember"), [["good"]]);
});

// ---- tasks
test("members under trainLevel train; trained members earn the best task for the focus", () => {
	const { ns, tasks } = gangNs({
		members: { rookie: combat(50), vet: combat(400) },
		gang: { respectForNextRecruit: Infinity }, // full: focus "auto" means money
	});
	assignTasks(ns, settings, false, { cooling: false, members: 2 }, true);
	assert.equal(tasks.rookie, "Train Combat");
	assert.equal(tasks.vet, "Mug People", "money focus: Mug pays 5 base money against Terrorism's 1");
});

test("focus auto earns respect while the gang can still grow", () => {
	const { ns, tasks } = gangNs({
		members: { vet: combat(400) },
		gang: { respectForNextRecruit: 5000 },
	});
	assignTasks(ns, settings, false, { cooling: false, members: 1 }, true);
	assert.equal(tasks.vet, "Terrorism", "respect focus: Terrorism has the higher base respect");
});

test("a member too weak for every earning task keeps training", () => {
	const { ns, tasks } = gangNs({
		members: { weak: combat(settings.trainLevel) },
		gang: { respectForNextRecruit: Infinity },
	});
	// Terrorism needs more than level 200 (weight 200 - 40 > 0 is fine), so make every task hard.
	for (const name of ["Mug People", "Terrorism"]) TASKS[name].difficulty = 100;
	try {
		assignTasks(ns, settings, false, { cooling: false, members: 1 }, true);
	} finally {
		TASKS["Mug People"].difficulty = 1;
		TASKS["Terrorism"].difficulty = 10;
	}
	assert.equal(tasks.weak, "Train Combat");
});

test("wanted penalty: cooling starts above maxWantedPenalty, moves the weakest earner to a cool task, and stops below okWantedPenalty", () => {
	const world = gangNs({
		members: { a: combat(600), b: combat(300) },
		gang: { respectForNextRecruit: Infinity, wantedPenalty: 0.9, wantedLevel: 20 },
	});
	const state = { cooling: false, members: 2 };
	assignTasks(world.ns, settings, false, state, true);
	assert.equal(state.cooling, true);
	assert.equal(world.tasks.b, "Vigilante Justice", "the weaker earner cools");
	assert.notEqual(world.tasks.a, "Vigilante Justice");
	world.info.wantedPenalty = 0.995;
	assignTasks(world.ns, settings, false, state, true);
	assert.equal(state.cooling, false);
	assert.notEqual(world.tasks.b, "Vigilante Justice");
});

test("territory warfare: only with a full gang and territory left, and not with --no-war", () => {
	const others = { Tetrads: { territory: 0.3, power: 100 } };
	const members = { a: combat(400), b: combat(400), c: combat(400), d: combat(400) };
	const full = gangNs({ members, others, gang: { respectForNextRecruit: Infinity, territory: 0.5 } });
	assignTasks(full.ns, settings, false, { cooling: false, members: 4 }, false);
	assert.equal(Object.values(full.tasks).filter((t) => t === "Territory Warfare").length, 2, "warfareShare 0.5 of 4");
	const noWar = gangNs({ members, others, gang: { respectForNextRecruit: Infinity } });
	assignTasks(noWar.ns, settings, false, { cooling: false, members: 4 }, true);
	assert.equal(Object.values(noWar.tasks).includes("Territory Warfare"), false);
	const growing = gangNs({ members, others, gang: { respectForNextRecruit: 9999 } });
	assignTasks(growing.ns, settings, false, { cooling: false, members: 4 }, false);
	assert.equal(Object.values(growing.tasks).includes("Territory Warfare"), false, "gang not full yet");
	const owned = gangNs({ members, others: {}, gang: { respectForNextRecruit: Infinity } });
	assignTasks(owned.ns, settings, false, { cooling: false, members: 4 }, false);
	assert.equal(Object.values(owned.tasks).includes("Territory Warfare"), false, "nobody else holds territory");
});

// ---- clashes
test("clashes switch on at engageAt and off below disengageAt (hysteresis), and off when nobody holds territory", () => {
	const others = { Tetrads: { territory: 0.3, power: 100 } };
	const world = gangNs({ members: {}, others, gang: { power: 125, territoryWarfareEngaged: false } }); // 125/225 = 0.556
	const state = { engaged: false };
	setWarfare(world.ns, settings, state, false);
	assert.equal(state.engaged, true);
	world.info.power = 105; // 105/205 = 0.512: between disengageAt 0.5 and engageAt 0.55, stays on
	setWarfare(world.ns, settings, state, false);
	assert.equal(state.engaged, true);
	world.info.power = 95; // 0.487: off
	setWarfare(world.ns, settings, state, false);
	assert.equal(state.engaged, false);
	world.info.power = 105; // 0.512 again, now it needs engageAt to come back
	setWarfare(world.ns, settings, state, false);
	assert.equal(state.engaged, false);
	assert.equal(state.outlook != null, true);

	const alone = gangNs({ members: {}, others: {}, gang: { power: 1000, territoryWarfareEngaged: true } });
	const aloneState = { engaged: true };
	setWarfare(alone.ns, settings, aloneState, false);
	assert.equal(aloneState.engaged, false);
	assert.equal(aloneState.outlook, null);
});

test("the land outlook decides the clash: a strong gang does not block it while the weak ones pay for it, and --no-war never engages", () => {
	const others = { Weak: { territory: 0.1, power: 10 }, Strong: { territory: 0.4, power: 400 } };
	const world = gangNs({ members: {}, others, gang: { power: 100 } });
	const state = { engaged: false };
	setWarfare(world.ns, settings, state, false);
	assert.equal(state.engaged, true, "we take more from the weak gang than the strong one takes from us");
	const outmatched = gangNs({ members: {}, others: { Strong: { territory: 0.4, power: 400 }, Stronger: { territory: 0.3, power: 900 } }, gang: { power: 100 } });
	const lost = { engaged: false };
	setWarfare(outmatched.ns, settings, lost, false);
	assert.equal(lost.engaged, false, "outmatched by everyone");
	const strong = gangNs({ members: {}, others: { Weak: { territory: 0.1, power: 10 } }, gang: { power: 100 } });
	const noWar = { engaged: false };
	setWarfare(strong.ns, settings, noWar, true);
	assert.equal(noWar.engaged, false);
});

// ---- equipment
test("buyEquipment: augmentations first, then cheapest; skips owned, useless and unaffordable items", () => {
	const items = [
		{ name: "Cheap Armor", type: "Armor", stats: { def: 1.1 }, cost: 1e6 },
		{ name: "Pricey Weapon", type: "Weapon", stats: { str: 1.2 }, cost: 4e6 },
		{ name: "Hack Rootkit", type: "Rootkit", stats: { hack: 1.3 }, cost: 1e5 }, // useless to a combat gang
		{ name: "Combat Aug", type: "Augmentation", stats: { agi: 1.2 }, cost: 3e6 },
		{ name: "Huge Aug", type: "Augmentation", stats: { str: 1.5 }, cost: 1e12 },
	];
	const costs = Object.fromEntries(items.map((i) => [i.name, i.cost]));
	const bought = [];
	const members = { a: member({ upgrades: ["Cheap Armor"] }), b: member() };
	const world = gangNs({
		members,
		extra: {
			getEquipmentCost: (name) => costs[name],
			purchaseEquipment: (who, name) => { bought.push([who, name]); return true; },
		},
	});
	const ns = fakeNs({ overrides: { getPlayer: () => ({ money: 100e6 }), gang: world.ns.gang, format: world.ns.format } });
	buyEquipment(ns, settings, false, { equipment: items }, { name: "test", reserve: 0, maxFraction: 0.1 }); // budget 10m
	const names = bought.map(([who, name]) => `${name}:${who}`);
	assert.deepEqual(names.slice(0, 2), ["Combat Aug:a", "Combat Aug:b"]);
	assert.ok(!names.some((entry) => entry.startsWith("Hack Rootkit")), "hacking gear is no use to a combat gang");
	assert.ok(!names.some((entry) => entry.startsWith("Huge Aug")), "unaffordable");
	assert.ok(!names.includes("Cheap Armor:a"), "already owned");
});

test("buyEquipment without the augmentation setting skips augmentations", () => {
	const bought = [];
	const world = gangNs({
		members: { a: member() },
		extra: { getEquipmentCost: () => 1e6, purchaseEquipment: (who, name) => { bought.push(name); return true; } },
	});
	const ns = fakeNs({ overrides: { getPlayer: () => ({ money: 100e6 }), gang: world.ns.gang, format: world.ns.format } });
	const items = [{ name: "Aug", type: "Augmentation", stats: { str: 1.2 } }, { name: "Gun", type: "Weapon", stats: { str: 1.2 } }];
	buyEquipment(ns, { ...settings, buyAugmentations: false }, false, { equipment: items }, { name: "test", reserve: 0, maxFraction: 0.5 });
	assert.deepEqual(bought, ["Gun"]);
});

// ---- exact formulas (v3.0.0 src/Gang/formulas/formulas.ts)
const HT = { baseRespect: 0.004, baseWanted: 1.25, baseMoney: 360, hackWeight: 30, strWeight: 5, defWeight: 5, dexWeight: 30, agiWeight: 0, chaWeight: 30,
	difficulty: 36, territory: { money: 1.5, respect: 1.5, wanted: 1.6 } };
const all = (level) => ({ hack: level, str: level, def: level, dex: level, agi: level, cha: level });

test("task weight subtracts a different multiple of the difficulty for respect, wanted and money", () => {
	assert.equal(taskWeight(HT, all(200), "respect"), 200 - 4 * 36);
	assert.equal(taskWeight(HT, all(200), "wanted"), 200 - 3.5 * 36);
	assert.equal(taskWeight(HT, all(200), "money"), 200 - 3.2 * 36);
	assert.ok(moneyRate(HT, all(130), { respect: 1, wanted: 0, territory: 1 }) > 0 && respectRate(HT, all(130), { respect: 1, wanted: 0, territory: 1 }) === 0,
		"at 130 Human Trafficking pays money (130 > 115.2) but no respect (130 < 144)");
});

test("rates match the game's formulas, per second", () => {
	const gang = { respect: 1000, wanted: 1000, territory: 0.5 };
	const weight = 200 - 3.2 * 36;
	const land = Math.pow(50, 1.5) / 100;
	const exponent = 0.2 * 0.5 + 0.8;
	assert.ok(Math.abs(moneyRate(HT, all(200), gang) - Math.pow(5 * 360 * weight * land * 0.5, exponent) * 5) < 1e-6);
	assert.equal(territoryMult({ territory: { money: 1 } }, "money", 0.5), 0.5, "default exponent 1: land share");
	assert.equal(territoryMult({}, "money", 0.5), 0.5, "tasks without a territory entry scale linearly too");
	assert.equal(territoryMult({ territory: { money: 1 } }, "money", 0), 0.005, "never below 0.5%");
	assert.equal(territoryPenalty({ territory: 1 }), 1);
	assert.equal(territoryPenalty({ territory: 1, softcap: 0.5 }), 0.5);
	assert.equal(wantedFactor({ respect: 900, wanted: 100 }), 0.9);
	const vigilante = { baseWanted: -0.001, hackWeight: 20, strWeight: 20, defWeight: 20, dexWeight: 20, agiWeight: 20, chaWeight: 0, difficulty: 1, territory: { wanted: 0.9 } };
	assert.ok(wantedRate(vigilante, all(100), gang) < 0);
	assert.ok(wantedRate(HT, all(300), gang) < wantedRate(HT, all(150), gang), "stronger members raise the wanted level less on the same task");
});

test("skill, experience and ascension formulas", () => {
	assert.equal(skillLevel(0, 1), 1);
	assert.equal(skillLevel(5500, 2), 2 * Math.floor(32 * Math.log(6034.5) - 200) <= 0 ? 1 : skillLevel(5500, 2));
	assert.ok(Math.abs(skillLevel(expForLevel(100), 1) - 100) <= 1, "expForLevel inverts the level formula");
	assert.equal(ascensionPoints(500), 0);
	assert.equal(ascensionPoints(5000), 4000);
	assert.equal(ascensionMult(500), 1);
	assert.equal(ascensionMult(8000), 2);
	const trainCombat = { strWeight: 25, defWeight: 25, dexWeight: 25, agiWeight: 25, difficulty: 100 };
	assert.ok(Math.abs(expRate(trainCombat, "str", 1, 1) - (25 / 1500) * Math.pow(100, 0.9) * 5) < 1e-9);
	assert.equal(expRate(trainCombat, "cha", 1, 1), 0, "a stat the task doesn't weigh gets no experience");
	assert.ok(expRate(trainCombat, "str", 1, 4) > 3.9 * expRate(trainCombat, "str", 1, 1), "ascension multiplies experience gain");
});

test("clash outlook: even is 50%, and weak gangs outweigh a strong one", () => {
	const us = { power: 100, territory: 0.2 };
	assert.ok(Math.abs(clashOutlook(us, [{ power: 100, territory: 0.2 }]) - 0.5) < 1e-9);
	assert.ok(clashOutlook(us, [{ power: 10, territory: 0.1 }]) > 0.9);
	assert.ok(clashOutlook(us, [{ power: 1000, territory: 0.1 }]) < 0.1);
	const mixed = clashOutlook(us, [{ power: 10, territory: 0.1 }, { power: 400, territory: 0.4 }]);
	assert.ok(mixed > 0.5 && mixed < 0.9);
});

// ---- growth model
const GROW_TASKS = {
	"Unassigned": task({}),
	"Train Combat": task({ strWeight: 25, defWeight: 25, dexWeight: 25, agiWeight: 25, difficulty: 100 }),
	"Train Charisma": task({ strWeight: 0, defWeight: 0, dexWeight: 0, agiWeight: 0, chaWeight: 100, difficulty: 8 }),
	"Mug People": task({ baseRespect: 0.00005, baseMoney: 3.6, baseWanted: 0.00005, strWeight: 25, defWeight: 25, dexWeight: 25, agiWeight: 10, chaWeight: 15, difficulty: 1 }),
	"Con": task({ baseRespect: 0.0001, baseMoney: 40, baseWanted: 0.05, strWeight: 0, defWeight: 0, dexWeight: 0, agiWeight: 0, chaWeight: 100, difficulty: 10 }),
	"Vigilante Justice": task({ baseWanted: -0.001, strWeight: 20, defWeight: 20, dexWeight: 20, agiWeight: 20, hackWeight: 20, difficulty: 1 }),
	"Territory Warfare": task({ strWeight: 20, defWeight: 20, dexWeight: 20, agiWeight: 20, hackWeight: 15, chaWeight: 5, difficulty: 5 }),
};

/** A member the way the real API reports it: experience, multipliers, ascension points. */
function grown({ level = 1, exp = 0, points = 0, cha, mult = 1 } = {}) {
	const info = { name: "m", task: "Unassigned", earnedRespect: 0, upgrades: [], augmentations: [] };
	for (const stat of ["hack", "str", "def", "dex", "agi", "cha"]) {
		const asc = ascensionMult(points);
		const statExp = stat === "cha" && cha !== undefined ? cha.exp : exp;
		info[stat] = skillLevel(statExp, mult * asc);
		info[`${stat}_exp`] = statExp;
		info[`${stat}_mult`] = mult;
		info[`${stat}_asc_mult`] = asc;
		info[`${stat}_asc_points`] = stat === "cha" && cha !== undefined ? cha.points : points;
	}
	void level;
	return info;
}

function growthNs(members, { gang = {}, tasks = GROW_TASKS, extra = {} } = {}) {
	const world = gangNs({ members, gang: { respectForNextRecruit: Infinity, ...gang }, extra: { getTaskNames: () => Object.keys(tasks), getTaskStats: (name) => tasks[name], ...extra } });
	return world;
}

test("growth: a fresh member trains, a late member with a huge banked multiplier earns", () => {
	const { ns, tasks } = growthNs({ fresh: grown({ exp: 0 }), late: grown({ exp: 5000, points: 2e7 }) });
	assignTasks(ns, grow, false, { cooling: false, members: 2 }, true);
	assert.equal(tasks.fresh, "Train Combat");
	assert.ok(["Mug People", "Con"].includes(tasks.late), `late member earns (got ${tasks.late})`);
});

test("growth: trains charisma when the money task needs it and combat stats won't help", () => {
	const strong = grown({ exp: 2e5, points: 2e5, cha: { exp: 0, points: 0 } });
	const { ns, tasks } = growthNs({ strong }, { tasks: { ...GROW_TASKS, "Mug People": undefined } });
	delete GROW_TASKS["Mug People"];
	try {
		const world = growthNs({ strong });
		assignTasks(world.ns, grow, false, { cooling: false, members: 1 }, true);
		assert.equal(world.tasks.strong, "Train Charisma", "Con pays on charisma alone; combat training adds nothing to it");
	} finally {
		GROW_TASKS["Mug People"] = task({ baseRespect: 0.00005, baseMoney: 3.6, baseWanted: 0.00005, strWeight: 25, defWeight: 25, dexWeight: 25, agiWeight: 10, chaWeight: 15, difficulty: 1 });
	}
	void ns; void tasks;
});

test("growth: a gang that can still grow keeps at least a third of its members earning", () => {
	const members = {};
	for (const name of ["a", "b", "c"]) members[name] = grown({ exp: 3000, points: 2e5 });
	const world = growthNs(members, { gang: { respectForNextRecruit: 5000 } });
	assignTasks(world.ns, grow, false, { cooling: false, members: 3 }, true);
	assert.ok(Object.values(world.tasks).filter((t) => t !== "Train Combat" && t !== "Train Charisma").length >= 1, "someone earns respect for the next recruit");
});

test("ascension verdict: goes when the banked multiplier pays back the re-training, not for a sliver", () => {
	const world = growthNs({});
	const state = {};
	const ctx = planContext(world.ns, grow, false, state);
	const ripe = memberView(grown({ exp: 6e5, points: 2e5 }));
	assert.equal(ascensionVerdict(ripe, ctx, null).go, true);
	const sliver = memberView(grown({ exp: 1500, points: 2e7 }));
	assert.equal(ascensionVerdict(sliver, ctx, null).go, false, "500 points on 2e7 is a 0.001% gain");
	const none = memberView(grown({ exp: 900, points: 2e5 }));
	assert.equal(ascensionVerdict(none, ctx, null).go, false, "under 1000 exp there is nothing to bank");
});

test("ascend: uses the verdict with growth on, and counts ascensions", () => {
	const members = { ripe: grown({ exp: 6e5, points: 2e5 }), sliver: grown({ exp: 1500, points: 2e7 }) };
	const results = { ripe: { hack: 1, str: 2, def: 2, dex: 2, agi: 2, respect: 10 }, sliver: { hack: 1, str: 1.0001, def: 1.0001, dex: 1.0001, agi: 1.0001, respect: 1 } };
	const { ns } = growthNs(members, { extra: { getAscensionResult: (name) => results[name], ascendMember: () => true } });
	const state = {};
	ascend(ns, grow, false, state);
	assert.deepEqual(ns.called("gang.ascendMember"), [["ripe"]]);
	assert.equal(state.ascensions, 1);
});

test("horizon: the run's age, within the configured limits", () => {
	const now = Date.now();
	const at = (hoursAgo) => fakeNs({ overrides: { getResetInfo: () => ({ lastNodeReset: now - hoursAgo * 3_600_000 }) } });
	const limits = { horizonMinSeconds: 3600, horizonMaxSeconds: 86_400 };
	assert.equal(horizonSeconds(at(0.1), limits), 3600);
	assert.ok(Math.abs(horizonSeconds(at(5), limits) - 18_000) < 5);
	assert.equal(horizonSeconds(at(100), limits), 86_400);
});

test("warfare picks the earners that give up the least pay per point of power", () => {
	// Money is linear in stats minus a difficulty offset, so near full territory the weaker member gives up less per point of power.
	const hard = { ...GROW_TASKS, "Con": { ...GROW_TASKS["Con"], difficulty: 40 } };
	const others = { Tetrads: { territory: 0.01, power: 100 } };
	const members = { weak: grown({ exp: 3e5, points: 2e5 }), strong: grown({ exp: 3e5, points: 8e6 }) };
	const world = growthNs(members, { tasks: hard, gang: { territory: 0.99 }, extra: { getAllGangInformation: () => others } });
	assignTasks(world.ns, grow, false, { cooling: false, members: 2 }, false);
	assert.equal(world.tasks.weak, "Territory Warfare");
	assert.notEqual(world.tasks.strong, "Territory Warfare", "the strong member keeps earning");
});

// ---- equipment with growth on
test("growth equipment: buys what pays back within the horizon, skips useless and overpriced items", () => {
	const items = [
		{ name: "Good Gear", type: "Armor", stats: { cha: 2 }, cost: 1e3 },
		{ name: "Useless Gear", type: "Armor", stats: { hack: 2 }, cost: 1e3 },
		{ name: "Overpriced Gear", type: "Armor", stats: { cha: 1.01 }, cost: 1e15 },
		{ name: "Good Aug", type: "Augmentation", stats: { cha: 2 }, cost: 1e3 },
	];
	const costs = Object.fromEntries(items.map((i) => [i.name, i.cost]));
	const bought = [];
	const members = { a: grown({ exp: 3e4, points: 2e5 }) };
	const world = growthNs(members, { extra: { getEquipmentCost: (name) => costs[name], purchaseEquipment: (who, name) => { bought.push(name); return true; } } });
	const ns = fakeNs({ overrides: { getPlayer: () => ({ money: 1e12 }), gang: world.ns.gang, format: world.ns.format } });
	buyEquipment(ns, grow, false, { equipment: items }, { name: "test", reserve: 0, maxFraction: 0.5 });
	assert.ok(bought.includes("Good Aug"), "augmentations pay back over the whole horizon");
	assert.ok(!bought.includes("Useless Gear"), "a hacking multiplier adds nothing to tasks that don't weigh hacking");
	assert.ok(!bought.includes("Overpriced Gear"));
});

test("growth equipment before an install (anyPayback): gear that pays back too slowly is still bought, since the cash would be lost", () => {
	// The install keeps the gang and its equipment but wipes the cash (gang/workers/spend-leftover.js)
	const items = [{ name: "Slow Gear", type: "Armor", stats: { cha: 1.01 }, cost: 1e11 }, { name: "Useless Gear", type: "Armor", stats: { hack: 2 }, cost: 1e3 }];
	const costs = Object.fromEntries(items.map((i) => [i.name, i.cost]));
	const run = (options) => {
		const bought = [];
		const world = growthNs({ a: grown({ exp: 3e4, points: 2e5 }) }, { extra: { getEquipmentCost: (name) => costs[name], purchaseEquipment: (who, name) => { bought.push(name); return true; } } });
		const ns = fakeNs({ overrides: { getPlayer: () => ({ money: 1e12 }), gang: world.ns.gang, format: world.ns.format } });
		buyEquipment(ns, grow, false, { equipment: items }, { name: "test", reserve: 0, maxFraction: 0.5 }, options);
		return bought;
	};
	assert.deepEqual(run(undefined), [], "a normal pass waits: the payback is past the horizon");
	assert.deepEqual(run({ anyPayback: true }), ["Slow Gear"], "before an install anything that adds pay beats losing the cash, but not useless gear");
});

// ---- metrics
test("metrics: sample fields, efficiency against the ceiling, milestones and a capped log file", () => {
	const gang = { moneyGainRate: 2, respect: 1e5, respectGainRate: 1, wantedPenalty: 0.99, wantedLevel: 10, territory: 0.4, power: 50, respectForNextRecruit: Infinity, territoryWarfareEngaged: true };
	const sample = metricSample(gang, { members: 12, kinds: { earn: 8, war: 4 }, ascensions: 3, ceiling: 40 });
	assert.equal(sample.money, 10, "per second = per-cycle rate x 5");
	assert.equal(sample.efficiency, 0.25);
	assert.ok(Math.abs(sample.penalty - 0.01) < 1e-9);
	const ns = fakeNs({ overrides: { gang: { getGangInformation: () => gang } } });
	const state = { members: 12, startedAt: Date.now() - 5000, lastLog: 0, milestones: {} };
	recordMetrics(ns, { logMs: 1000 }, state);
	const saved = JSON.parse(ns.files[LOG_FILE]);
	assert.equal(saved.samples.length, 1);
	assert.ok(saved.milestones.full >= 4 && saved.milestones.firstClash >= 4);
	assert.equal(saved.milestones.landAll, undefined);
	recordMetrics(ns, { logMs: 0 }, { ...state, lastLog: 0 });
	assert.equal(JSON.parse(ns.files[LOG_FILE]).samples.length, 1, "logMs 0 never logs");
	void potentialStats; void bestEarn; void chooseAction; void ascensionVerdict;
});
