// Bladeburner: shared port state (bladeburner/state.js), ready checks, the bb-manage.js state machine,
// skill spending and the wait for Stanek's Gift (utils/stanek.js), and the pure route model (bladeburner/route-model.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { bladeburnerAccess } from "/utils/bladeburner.js";
import { GIFT, giftOpen, joiningClosesGift } from "/utils/stanek.js";
import { loadConfig } from "/utils/config.js";
import {
	BB_PORT, readBladeburner, postBladeburner, bladeburnerState, bladeburnerPlan, trainFloor, blackOpsDone, COMBAT_FLOOR,
} from "/bladeburner/state.js";
import { bladeburnerReady, bladeburnerRunning } from "/bladeburner/ready.js";
import { main as manage } from "/bladeburner/bb-manage.js";
import {
	skillAt, expFor, rawChance, makeBladeburner, bladeburnerClone, bladeburnerAdvance, bestChanceNow, predictRankPerHour,
	projectRoute, incomeNeeded, DONATE_REP,
} from "/bladeburner/route-model.js";

const minutesAgo = (n) => Date.now() - n * 60_000;
const withPort = (post, overrides = {}) => fakeNs({ ports: post ? { [BB_PORT]: post } : {}, overrides });

// ---- shared state
test("readBladeburner is {} for an empty or broken port", () => {
	assert.deepEqual(readBladeburner(withPort(null)), {});
	assert.deepEqual(readBladeburner(fakeNs({ ports: { [BB_PORT]: "not json" } })), {});
	assert.deepEqual(readBladeburner(fakeNs({ ports: { [BB_PORT]: "5" } })), {}, "a bare number is not a state object");
});

test("postBladeburner merges a patch, keeps other keys, and ignores undefined values", () => {
	const ns = withPort({ state: "run", rank: 12, lines: ["a"] });
	const post = postBladeburner(ns, { state: "hold", lines: undefined, plan: { route: "combat" } });
	assert.equal(post.state, "hold");
	assert.equal(post.rank, 12);
	assert.deepEqual(post.lines, ["a"], "undefined keeps what is there");
	assert.equal(post.title, "Bladeburner");
	assert.equal(post.oneShot, true);
	assert.deepEqual(ns.portJson(BB_PORT).plan, { route: "combat" });
});

test("bladeburnerState goes to off when the manager stops posting", () => {
	assert.equal(bladeburnerState(withPort({ state: "run", stateTime: minutesAgo(5) })), "run");
	assert.equal(bladeburnerState(withPort({ state: "run", stateTime: minutesAgo(20) })), "off", "older than 15 minutes");
	assert.equal(bladeburnerState(withPort({ state: "run" })), "off", "no time at all");
	assert.equal(bladeburnerState(withPort(null)), "off");
});

test("bladeburnerPlan is null once older than 30 minutes", () => {
	assert.deepEqual(bladeburnerPlan(withPort({ plan: { route: "hacking", time: minutesAgo(10) } })).route, "hacking");
	assert.equal(bladeburnerPlan(withPort({ plan: { route: "hacking", time: minutesAgo(45) } })), null);
	assert.equal(bladeburnerPlan(withPort({})), null);
});

test("trainFloor is the join floor, or the estimate's target when higher", () => {
	assert.equal(trainFloor(withPort(null)), COMBAT_FLOOR);
	assert.equal(trainFloor(withPort({ plan: { trainTarget: 250, time: minutesAgo(1) } })), 250);
	assert.equal(trainFloor(withPort({ plan: { trainTarget: 40, time: minutesAgo(1) } })), COMBAT_FLOOR);
	assert.equal(trainFloor(withPort({ plan: { trainTarget: 250, time: minutesAgo(90) } })), COMBAT_FLOOR, "stale plan ignored");
	assert.equal(trainFloor(withPort({ plan: { trainTarget: "junk", time: minutesAgo(1) } })), COMBAT_FLOOR);
});

test("blackOpsDone needs a done flag from the last hour", () => {
	assert.equal(blackOpsDone(withPort({ blackOps: { done: true, time: minutesAgo(30) } })), true);
	assert.equal(blackOpsDone(withPort({ blackOps: { done: true, time: minutesAgo(90) } })), false);
	assert.equal(blackOpsDone(withPort({ blackOps: { done: false, time: minutesAgo(1) } })), false);
	assert.equal(blackOpsDone(withPort({})), false);
});

// ---- access and ready checks
const resetInfo = (node, sf = [], lastAugReset = Date.now() - 5 * 3600_000) =>
	() => ({ currentNode: node, ownedSF: new Map(sf.map((n) => [n, 1])), lastAugReset });

test("Bladeburner API: BitNode 6 or 7, or Source-File 6 or 7", () => {
	const access = (node, sf) => bladeburnerAccess(fakeNs({ overrides: { getResetInfo: resetInfo(node, sf) } })).available;
	assert.equal(access(6, []), true);
	assert.equal(access(7, []), true);
	assert.equal(access(1, [6]), true);
	assert.equal(access(1, [7]), true);
	assert.equal(access(1, [4, 5]), false);
});

test("ready checks: the manager starts with the API, bb-pass.js plays only in state run", () => {
	assert.equal(bladeburnerReady(fakeNs({ overrides: { getResetInfo: resetInfo(1, [6]) } })), true);
	assert.equal(bladeburnerReady(fakeNs({ overrides: { getResetInfo: resetInfo(1, []) } })), false);
	assert.equal(bladeburnerRunning(withPort({ state: "run", stateTime: minutesAgo(1) })), true);
	for (const state of ["boot", "train", "hold"]) assert.equal(bladeburnerRunning(withPort({ state, stateTime: minutesAgo(1) })), false);
	assert.equal(bladeburnerRunning(withPort({ state: "run", stateTime: minutesAgo(60) })), false);
});

// ---- bb-manage.js
const STRONG = { hacking: 100, strength: 150, defense: 150, dexterity: 150, agility: 150 };

/**
 * A Bladeburner player. `sf`: Source-Files at level 1 (6) or [number, level] ([7, 3]); `augs`: installed augmentations;
 * `files`: data/config.json, data/bitnode.txt...; `costs`: skill name -> cost; `points` skill points; `overclock`: its level.
 */
function world({ node = 6, sf = [], augs = [], files = {}, skills = STRONG, money = 0, income = 0, ageMs = 5 * 3600_000, post = null,
	inDivision = true, joins = true, costs = {}, points = 0, overclock = 1, nodeStart = 1000 } = {}) {
	const bought = [];
	let current = "Training";
	const ns = fakeNs({
		files,
		ports: post ? { [BB_PORT]: post } : {},
		overrides: {
			getScriptName: () => "bladeburner/bb-manage.js",
			getResetInfo: () => ({
				currentNode: node, ownedSF: new Map(sf.map((entry) => (Array.isArray(entry) ? entry : [entry, 1]))),
				ownedAugs: new Map(augs.map((aug) => [aug, 1])), lastAugReset: Date.now() - ageMs, lastNodeReset: nodeStart,
			}),
			getPlayer: () => ({ skills, money }),
			getTotalScriptIncome: () => [income, 0],
			bladeburner: {
				inBladeburner: () => inDivision,
				joinBladeburnerDivision: () => joins,
				getCurrentAction: () => current,
				stopBladeburnerAction: () => { current = null; },
				getSkillPoints: () => points,
				getSkillUpgradeCost: (name) => costs[name] ?? Infinity,
				getSkillLevel: () => overclock,
				upgradeSkill: (name) => { bought.push(name); points -= costs[name]; return true; },
			},
		},
	});
	return { ns, bought, state: () => ns.portJson(BB_PORT)?.state };
}

test("bb-manage exits without a message or a post when there is no Bladeburner API", async () => {
	const w = world({ node: 1 });
	await manage(w.ns);
	assert.equal(w.ns.portJson(BB_PORT), null);
	assert.deepEqual(w.ns.terminal, []);
});

test("bb-manage: a ready player joins the division and the state is run", async () => {
	const w = world({ inDivision: false });
	await manage(w.ns);
	assert.equal(w.state(), "run");
	assert.equal(w.ns.called("bladeburner.joinBladeburnerDivision").length, 1);
});

test("bb-manage: a refused join leaves the state off", async () => {
	const w = world({ inDivision: false, joins: false });
	await manage(w.ns);
	assert.equal(w.state(), "off");
});

test("bb-manage: the first hour waits for hacking 10 and income, then Bladeburner starts", async () => {
	const early = world({ skills: { ...STRONG, hacking: 3 }, ageMs: 10 * 60_000 });
	await manage(early.ns);
	assert.equal(early.state(), "boot");
	assert.equal(early.ns.called("bladeburner.stopBladeburnerAction").length, 1, "a leftover action would fight the gym");
	const income = world({ skills: { ...STRONG, hacking: 12 }, ageMs: 10 * 60_000, income: 50 });
	await manage(income.ns);
	assert.equal(income.state(), "run");
	const cash = world({ skills: { ...STRONG, hacking: 12 }, ageMs: 10 * 60_000, money: 6e6 });
	await manage(cash.ns);
	assert.equal(cash.state(), "run");
});

test("an hour into the run the boot hold is dropped even if hacking is still low", async () => {
	const w = world({ skills: { ...STRONG, hacking: 3 }, ageMs: 2 * 3600_000 });
	await manage(w.ns);
	assert.equal(w.state(), "run");
});

test("bb-manage: a combat stat under 100 means train, and the message names the lowest", async () => {
	const w = world({ skills: { ...STRONG, agility: 61.7 } });
	await manage(w.ns);
	assert.equal(w.state(), "train");
	assert.match(w.ns.portJson(BB_PORT).lines[0], /61 \/ 100/);
	assert.equal(w.ns.called("bladeburner.joinBladeburnerDivision").length, 0, "no join before the stats are ready");
});

test("bb-manage: the estimate's trainTarget raises the floor", async () => {
	const w = world({ post: { plan: { route: "combat", trainTarget: 200, time: Date.now() } } });
	await manage(w.ns);
	assert.equal(w.state(), "train");
	assert.match(w.ns.portJson(BB_PORT).lines[0], /150 \/ 200/);
});

test("bb-manage: the hacking route holds and takes none of the player's time", async () => {
	const w = world({ post: { plan: { route: "hacking", time: Date.now() } } });
	await manage(w.ns);
	assert.equal(w.state(), "hold");
	assert.equal(w.ns.called("bladeburner.joinBladeburnerDivision").length, 0);
	assert.equal(w.ns.called("bladeburner.stopBladeburnerAction").length, 1);
});

test("bb-manage: an estimate saying hold keeps a joined player on hold", async () => {
	const w = world({ post: { plan: { route: "combat", hold: true, time: Date.now() } } });
	await manage(w.ns);
	assert.equal(w.state(), "hold");
});

test("bb-manage: with no estimate the config route decides (combat by default)", async () => {
	const w = world({});
	await manage(w.ns);
	assert.equal(w.state(), "run");
});

test("bb-manage: skill points go to the cheapest skill of the first tier and stop when it can't be afforded", async () => {
	const w = world({ points: 100, costs: { Overclock: 10, "Blade's Intuition": 30, Tracer: 50, Hyperdrive: 5 } });
	await manage(w.ns);
	// Overclock (tier 1) is bought until 100 points are gone or it stops being the cheapest affordable;
	// every purchase happens in tier order, so Hyperdrive (tier 4) is never bought ahead of earlier tiers.
	assert.ok(w.bought.length > 0);
	assert.equal(w.bought[0], "Overclock");
	assert.ok(!w.bought.includes("Hyperdrive"), "waits for points rather than skipping to a lesser tier");
});

test("bb-manage: Overclock stops at level 90", async () => {
	const w = world({ points: 100, overclock: 90, costs: { Overclock: 10, "Blade's Intuition": 30 } });
	await manage(w.ns);
	assert.ok(!w.bought.includes("Overclock"));
	assert.equal(w.bought[0], "Blade's Intuition");
});

// ---- Stanek's Gift (utils/stanek.js) and the join
const info = ({ node = 13, sf = [], augs = [] } = {}) => ({ currentNode: node, ownedSF: new Map(sf), ownedAugs: new Map(augs.map((aug) => [aug, 1])) });

test("the Gift is open with the church (BitNode 13 or Source-File 13) while only NeuroFlux Governor is installed", () => {
	assert.equal(giftOpen(info()), true);
	assert.equal(giftOpen(info({ augs: ["NeuroFlux Governor"] })), true);
	assert.equal(giftOpen(info({ node: 6, sf: [[13, 1]] })), true);
	assert.equal(giftOpen(info({ node: 6 })), false, "no church");
	assert.equal(giftOpen(info({ augs: [GIFT] })), false, "already accepted");
	assert.equal(giftOpen(info({ augs: ["NeuroFlux Governor", "Synaptic Enhancement Implant"] })), false, "another augmentation closed it");
	assert.equal(giftOpen({ currentNode: 13, ownedSF: new Map() }), true, "no ownedAugs: nothing installed");
});

test("joining closes the Gift only with Source-File 7 at level 3 (The Blade's Simulacrum)", () => {
	assert.equal(joiningClosesGift(info({ sf: [[7, 3]] })), true);
	assert.equal(joiningClosesGift(info({ sf: [[7, 2], [6, 3]] })), false);
	assert.equal(joiningClosesGift(info({ sf: [[7, 3]], augs: [GIFT] })), false);
	assert.equal(joiningClosesGift(info({ node: 6, sf: [[7, 3]] })), false);
});

test("bladeburner.stanekFirst is on by default in BitNode 13 only", () => {
	assert.equal(loadConfig(fakeNs({ files: { "data/bitnode.txt": "13" } })).bladeburner.stanekFirst, true);
	assert.equal(loadConfig(fakeNs({ files: { "data/bitnode.txt": "6" } })).bladeburner.stanekFirst, false);
	assert.equal(loadConfig(fakeNs()).bladeburner.stanekFirst, false);
});

const IN_13 = { "data/bitnode.txt": "13" };
const config = (bladeburner) => JSON.stringify({ bladeburner });

test("regression: in BitNode 13 with Source-File 7.3 the division waits for Stanek's Gift (joining used to close it)", async () => {
	const w = world({ node: 13, sf: [[7, 3]], inDivision: false, files: IN_13, skills: { ...STRONG, agility: 50 } });
	await manage(w.ns);
	assert.equal(w.state(), "hold", "not train either: an install would reset the gym's work");
	assert.equal(w.ns.called("bladeburner.joinBladeburnerDivision").length, 0);
	assert.match(w.ns.portJson(BB_PORT).lines[0], /Stanek's Gift/);
	assert.equal(w.ns.terminal.length, 1);
	assert.match(w.ns.terminal[0], /Church of the Machine God.*stanekFirst false/);
	await manage(w.ns);
	assert.equal(w.ns.terminal.length, 1, "the notice comes once per BitNode");
	assert.equal(w.state(), "hold");
});

test("the notice comes again in the next BitNode", async () => {
	const w = world({ node: 13, sf: [[7, 3]], inDivision: false, files: IN_13, post: { giftNotice: 999 }, nodeStart: 1000 });
	await manage(w.ns);
	assert.equal(w.ns.terminal.length, 1);
	assert.equal(w.ns.portJson(BB_PORT).giftNotice, 1000);
});

test("bb-manage joins once the Gift is accepted or closed, and when nothing is at stake", async () => {
	const joined = async (options, why) => {
		const w = world({ node: 13, sf: [[7, 3]], inDivision: false, files: IN_13, ...options });
		await manage(w.ns);
		assert.equal(w.state(), "run", why);
		assert.equal(w.ns.called("bladeburner.joinBladeburnerDivision").length, 1, why);
		assert.deepEqual(w.ns.terminal, [], `${why}: no notice`);
	};
	await joined({ augs: [GIFT] }, "the Gift is accepted");
	await joined({ augs: ["Synaptic Enhancement Implant"] }, "an installed augmentation closed the Gift");
	await joined({ sf: [[7, 2]] }, "Source-File 7 below level 3 gives no Simulacrum");
	await joined({ files: { ...IN_13, "data/config.json": config({ stanekFirst: false }) } }, "stanekFirst turned off");
	await joined({ node: 6, files: { "data/bitnode.txt": "6", "data/config.json": config({ stanekFirst: true }) } }, "no church outside BitNode 13 without Source-File 13");
});

test("stanekFirst set everywhere: with Source-File 13 the wait applies in any BitNode", async () => {
	const w = world({ node: 6, sf: [[7, 3], [13, 1]], inDivision: false, files: { "data/bitnode.txt": "6", "data/config.json": config({ stanekFirst: true }) } });
	await manage(w.ns);
	assert.equal(w.state(), "hold");
	assert.equal(w.ns.called("bladeburner.joinBladeburnerDivision").length, 0);
});

test("already in the division: nothing left to wait for", async () => {
	const w = world({ node: 13, sf: [[7, 3]], inDivision: true, files: IN_13 });
	await manage(w.ns);
	assert.equal(w.state(), "run");
	assert.deepEqual(w.ns.terminal, []);
});

// ---- route model
test("skillAt and expFor are inverses, and a multiplier scales the level", () => {
	for (const level of [10, 100, 500, 2000]) {
		assert.ok(Math.abs(skillAt(expFor(level, 1), 1) - level) < 1e-6, `level ${level}`);
		assert.ok(Math.abs(skillAt(expFor(level, 2.5), 2.5) - level) < 1e-6);
	}
	assert.equal(expFor(1, 1), 0, "no negative exp");
	assert.ok(skillAt(1e6, 2) > skillAt(1e6, 1));
	assert.ok(skillAt(0, 1) >= 1);
});

const LV = { hacking: 100, strength: 200, defense: 200, dexterity: 200, agility: 200, charisma: 100, intelligence: 1 };
const ROW = (name, over = {}) => ({ name, chance: 0.8, level: 1, maxLevel: 1, count: 20, secs: 30, gain: 2, lv: LV, ...over });

test("rawChance rises with stats, falls with action level, and is NaN for an unknown action", () => {
	assert.ok(rawChance("Tracking", { ...LV, strength: 400, dexterity: 400, agility: 400 }) >= rawChance("Tracking", LV));
	assert.ok(rawChance("Tracking", LV, 5) < rawChance("Tracking", LV, 1));
	assert.ok(Number.isNaN(rawChance("Nonsense", LV)));
	assert.ok(rawChance("Assassination", { ...LV, strength: 1, defense: 1, dexterity: 1, agility: 1, hacking: 1 }) < 0.1);
});

test("makeBladeburner skips actions the model does not know", () => {
	const acts = makeBladeburner([ROW("Tracking"), ROW("Made Up"), ROW("Raid")]);
	assert.deepEqual(acts.map((x) => x.a.name), ["Tracking", "Raid"]);
});

test("bestChanceNow rescales the live chance to stronger skills, capped at 1", () => {
	const acts = makeBladeburner([ROW("Tracking", { chance: 0.5 })]);
	const same = bestChanceNow(acts, LV);
	assert.ok(Math.abs(same.chance - 0.5) < 1e-9);
	assert.equal(same.name, "Tracking");
	const strong = bestChanceNow(acts, { ...LV, strength: 5000, dexterity: 5000, agility: 5000, defense: 5000 });
	assert.equal(strong.chance, 1);
	assert.equal(bestChanceNow([], LV).name, null);
});

test("bladeburnerAdvance earns rank only from actions at or above the minimum chance, and uses up counts", () => {
	const good = makeBladeburner([ROW("Tracking", { chance: 0.9, count: 5 })]);
	const state = { rank: 0 };
	bladeburnerAdvance(good, state, LV, 1, 1);
	assert.ok(state.rank > 0);
	const risky = makeBladeburner([ROW("Tracking", { chance: 0.2, count: 50 })]);
	const none = { rank: 0 };
	bladeburnerAdvance(risky, none, LV, 1, 1);
	assert.equal(none.rank, 0, "below the 0.4 minimum chance nothing is attempted");
	const idle = { rank: 0 };
	bladeburnerAdvance(makeBladeburner([ROW("Tracking", { chance: 0.9, count: 5 })]), idle, LV, 1, 0);
	assert.equal(idle.rank, 0, "no duty, no rank");
});

test("bladeburnerClone does not share counts with the original, and predictRankPerHour leaves the model alone", () => {
	const acts = makeBladeburner([ROW("Tracking", { chance: 0.9, count: 5 })]);
	const rate = predictRankPerHour(acts, LV);
	assert.ok(rate > 0);
	assert.equal(acts[0].count, 5);
	const copy = bladeburnerClone(acts);
	copy[0].count = 0;
	assert.equal(acts[0].count, 5);
});

// A small projection config. Only the pieces the combat goal reads.
function combatConfig(over = {}) {
	// Readings taken at the stats the gym gives in one hour (about 73), so the rescaling in the model stays near 1.
	const gymLv = { ...LV, strength: 73, defense: 73, dexterity: 73, agility: 73 };
	const acts = makeBladeburner([ROW("Raid", { chance: 0.9, count: 30, gain: 55, secs: 30, lv: gymLv }), ROW("Tracking", { chance: 0.95, count: 30, gain: 0.3, lv: gymLv })]);
	return {
		augs: [], nf: null, installed: 0, runHours: 10, overheadHours: 0.25, income: 1e6, expRate: 100,
		mult: { hacking: 1, hackExp: 1, combat: [1, 1, 1, 1], combatExp: 1 },
		scenario: { income: 0, exp: 0 }, maxRuns: 5,
		bb: { acts, rank: 399_000, lv: LV, duty: 1, gymHours: 1 },
		...over,
	};
}

test("projectRoute (combat) reaches rank 400000 when the actions pay well, and reports hours", () => {
	const result = projectRoute("combat", combatConfig());
	assert.equal(result.reached, true);
	assert.ok(result.hours > 0 && result.hours <= 5 * 10.25);
	assert.equal(result.log.at(-1).run, result.runs);
});

test("projectRoute (combat) does not reach it when there is nothing to do", () => {
	const dead = combatConfig({ bb: { acts: makeBladeburner([ROW("Tracking", { chance: 0.1, count: 30 })]), rank: 0, lv: LV, duty: 1, gymHours: 1 } });
	const result = projectRoute("combat", dead);
	assert.equal(result.reached, false);
	assert.equal(result.runs, 5);
});

test("projectRoute does not modify the live action model", () => {
	const cfg = combatConfig();
	const before = cfg.bb.acts.map((x) => x.count);
	projectRoute("combat", cfg);
	assert.deepEqual(cfg.bb.acts.map((x) => x.count), before);
});

test("projectRoute buys each run's augments at cfg.augStep, 1.9 when left out (less with Source-File 11)", () => {
	// Budget per run: 1e6/s x 10h x 3600 x 0.5 = 1.8e10. B goes first (same value, cheaper); then A costs 8e9 x the step.
	const augs = [{ name: "A", price: 8e9 }, { name: "B", price: 3.5e9 }]
		.map((aug) => ({ ...aug, rep: 0, f: ["F"], h: 1, e: 1, cs: [1.1, 1.1, 1.1, 1.1] }));
	assert.deepEqual(projectRoute("combat", combatConfig({ augs, maxRuns: 1 })).log[0].names, ["B"], "3.5e9 + 8e9 x 1.9 = 1.87e10 is over");
	assert.deepEqual(projectRoute("combat", combatConfig({ augs, maxRuns: 1, augStep: 1.767 })).log[0].names, ["B", "A"], "3.5e9 + 8e9 x 1.767 = 1.76e10 fits");
});

test("incomeNeeded is a power of two and 1 when the plan already works", () => {
	assert.equal(incomeNeeded("combat", combatConfig()), 1);
	assert.equal(incomeNeeded("combat", combatConfig({ bb: { acts: makeBladeburner([ROW("Tracking", { chance: 0.1 })]), rank: 0, lv: LV, duty: 1, gymHours: 1 } })), Infinity);
});

test("DONATE_REP is the cumulative rep at 150 favour", () => {
	assert.ok(DONATE_REP > 4e5 && DONATE_REP < 5e5);
});
