// Gang: utils/gang.js access rules, gang/ready.js, and the decisions in gang/gang-manager.js
// (recruiting, ascending, tasks, wanted-level cooling, territory clashes, equipment).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { loadConfig } from "/utils/config.js";
import { gangAccess } from "/utils/gang.js";
import { gangReady } from "/gang/ready.js";
import { recruit, ascend, assignTasks, setWarfare, buyEquipment, skillWeight, landMult, mainStat } from "/gang/gang-manager.js";

const settings = loadConfig(fakeNs()).gang;

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
	territory: { money: 0, respect: 0, wanted: 0 }, ...over,
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

test("skillWeight, landMult and mainStat follow the game's formulas", () => {
	const mug = task({ difficulty: 2 });
	assert.equal(skillWeight(mug, combat(100)), 100 - 8); // 4 stats x 25 x 100 / 100 - 4 x difficulty
	assert.ok(skillWeight(mug, combat(5)) <= 0, "too hard for a weak member");
	assert.equal(landMult({ territory: { money: 0 } }, "money", 0.5), 1, "no territory scaling");
	assert.ok(landMult({ territory: { money: 1 } }, "money", 0.5) > landMult({ territory: { money: 1 } }, "money", 0.1));
	assert.equal(landMult({ territory: { money: 1 } }, "money", 0), 0.005, "never below 0.5%");
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
	assert.equal(state.worstChance != null, true);

	const alone = gangNs({ members: {}, others: {}, gang: { power: 1000, territoryWarfareEngaged: true } });
	const aloneState = { engaged: true };
	setWarfare(alone.ns, settings, aloneState, false);
	assert.equal(aloneState.engaged, false);
	assert.equal(aloneState.worstChance, null);
});

test("the worst opponent decides the clash, and --no-war never engages", () => {
	const others = { Weak: { territory: 0.1, power: 10 }, Strong: { territory: 0.4, power: 400 } };
	const world = gangNs({ members: {}, others, gang: { power: 100 } });
	const state = { engaged: false };
	setWarfare(world.ns, settings, state, false);
	assert.equal(state.engaged, false, "100 against 400 is a 20% chance");
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
