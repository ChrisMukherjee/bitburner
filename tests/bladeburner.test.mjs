// Bladeburner: shared port state (bladeburner/state.js), ready checks, the bb-manage.js state machine,
// skill spending and the wait for Stanek's Gift (utils/stanek.js), and the pure route model (bladeburner/route-model.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { bladeburnerAccess, bladeburnerNodeMults } from "/utils/bladeburner.js";
import { pickRoute, committedRoute } from "/bladeburner/node-eta.js";
import { GIFT, giftOpen, joiningClosesGift } from "/utils/stanek.js";
import { loadConfig } from "/utils/config.js";
import {
	BB_PORT, readBladeburner, postBladeburner, bladeburnerState, bladeburnerPlan, trainFloor, blackOpsDone, COMBAT_FLOOR,
} from "/bladeburner/state.js";
import { bladeburnerReady, bladeburnerRunning } from "/bladeburner/ready.js";
import { main as manage } from "/bladeburner/bb-manage.js";
import {
	skillAt, expFor, rawChance, makeBladeburner, bladeburnerClone, bladeburnerAdvance, bestChanceNow, predictRankPerHour,
	projectRoute, incomeNeeded, DONATE_REP, fitIncomeExponent, levelFactor, modelMults, inviteGate, gateOpen, skillStart, spendSkills, ACTIONS,
	priorRows, JOIN_LEVEL,
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

test("game: Bladeburner API: BitNode 6 or 7, or Source-File 6 or 7", () => {
	const access = (node, sf) => bladeburnerAccess(fakeNs({ overrides: { getResetInfo: resetInfo(node, sf) } })).available;
	assert.equal(access(6, []), true);
	assert.equal(access(7, []), true);
	assert.equal(access(1, [6]), true);
	assert.equal(access(1, [7]), true);
	assert.equal(access(1, [4, 5]), false);
});

// Saved BitNode multipliers (tools/save-bitnode-mults.js, Source-File 5) for BitNode `node`
const savedMults = (node, mults) => ({ "data/bitnode.txt": String(node), "data/bitnode-mults.json": JSON.stringify({ node, mults }) });

test("game: no Bladeburner where the BitNode's multipliers give no rank or its options disable it", () => {
	// joinBladeburnerDivision refuses at BladeburnerRank 0 (bitburner-src v3.0.0); the scripts used to train combat to 100 for it
	const access = (node, files, options = {}) => bladeburnerAccess(fakeNs({ files, overrides: {
		getResetInfo: () => ({ currentNode: node, ownedSF: new Map([[5, 1], [6, 1]]), lastAugReset: Date.now(), bitNodeOptions: options }),
	} }));
	const none = access(8, savedMults(8, { BladeburnerRank: 0 }));
	assert.equal(none.available, false);
	assert.match(none.why, /BladeburnerRank 0/);
	assert.equal(access(15, savedMults(15, { BladeburnerRank: 0.2 })).available, true, "a nerf is not a ban");
	assert.equal(access(8, {}).available, true, "no saved multipliers (no Source-File 5): no BitNode number decides, the join attempt does");
	assert.equal(access(8, { ...savedMults(9, { BladeburnerRank: 0 }), "data/bitnode.txt": "8" }).available, true, "multipliers saved in another BitNode are ignored");
	assert.equal(access(6, {}, { disableBladeburner: true }).available, false, "advanced option");
});

test("bladeburnerNodeMults: the saved multipliers, or no nerf assumed without them", () => {
	const ns = (files) => fakeNs({ files, overrides: { getResetInfo: () => ({ currentNode: 15, ownedSF: new Map(), lastAugReset: 0 }) } });
	const nerfed = bladeburnerNodeMults(ns(savedMults(15, { BladeburnerRank: 0.2, BladeburnerSkillCost: 3, StrengthLevelMultiplier: 0.7,
		DefenseLevelMultiplier: 0.7, DexterityLevelMultiplier: 0.7, AgilityLevelMultiplier: 0.7, HackingLevelMultiplier: 0.8 })));
	assert.deepEqual(nerfed, { rank: 0.2, skillCost: 3, combatLevel: 0.7, hackingLevel: 0.8, known: true });
	assert.deepEqual(bladeburnerNodeMults(ns({})), { rank: 1, skillCost: 1, combatLevel: null, hackingLevel: null, known: false });
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
	inDivision = true, joins = true, costs = {}, points = 0, overclock = 1, nodeStart = 1000, factions = [], rank = 100 } = {}) {
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
			getPlayer: () => ({ skills, money, factions }),
			getTotalScriptIncome: () => [income, 0],
			bladeburner: {
				inBladeburner: () => inDivision,
				joinBladeburnerDivision: () => joins,
				joinBladeburnerFaction: () => { if (rank < 25) return false; factions.push("Bladeburners"); return true; },
				getCurrentAction: () => current,
				stopBladeburnerAction: () => { current = null; },
				getSkillPoints: () => points,
				getSkillUpgradeCost: (name) => costs[name] ?? Infinity,
				getSkillLevel: () => overclock,
				upgradeSkill: (name) => { bought.push(name); points -= costs[name]; return true; },
				getTeamSize: () => 0, setTeamSize: () => 0,
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

test("bb-manage: joins the Bladeburners faction once the rank allows, without waiting for an install", async () => {
	const w = world({ rank: 300 });
	await manage(w.ns);
	assert.equal(w.ns.called("bladeburner.joinBladeburnerFaction").length, 1);
	await manage(w.ns);
	assert.equal(w.ns.called("bladeburner.joinBladeburnerFaction").length, 1, "a member isn't asked again");
	const low = world({ rank: 10 });
	await manage(low.ns);
	assert.equal(low.ns.called("bladeburner.joinBladeburnerFaction").length, 1, "too low: asked, refused");
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

test("game: bb-manage: Overclock stops at level 90", async () => {
	const w = world({ points: 100, overclock: 90, costs: { Overclock: 10, "Blade's Intuition": 30 } });
	await manage(w.ns);
	assert.ok(!w.bought.includes("Overclock"));
	assert.equal(w.bought[0], "Blade's Intuition");
});

// ---- Stanek's Gift (utils/stanek.js) and the join
const info = ({ node = 13, sf = [], augs = [] } = {}) => ({ currentNode: node, ownedSF: new Map(sf), ownedAugs: new Map(augs.map((aug) => [aug, 1])) });

test("game: the Gift is open with the church (BitNode 13 or Source-File 13) while only NeuroFlux Governor is installed", () => {
	assert.equal(giftOpen(info()), true);
	assert.equal(giftOpen(info({ augs: ["NeuroFlux Governor"] })), true);
	assert.equal(giftOpen(info({ node: 6, sf: [[13, 1]] })), true);
	assert.equal(giftOpen(info({ node: 6 })), false, "no church");
	assert.equal(giftOpen(info({ augs: [GIFT] })), false, "already accepted");
	assert.equal(giftOpen(info({ augs: ["NeuroFlux Governor", "Synaptic Enhancement Implant"] })), false, "another augmentation closed it");
	assert.equal(giftOpen({ currentNode: 13, ownedSF: new Map() }), true, "no ownedAugs: nothing installed");
});

test("game: joining closes the Gift only with Source-File 7 at level 3 (The Blade's Simulacrum)", () => {
	assert.equal(joiningClosesGift(info({ sf: [[7, 3]] })), true);
	assert.equal(joiningClosesGift(info({ sf: [[7, 2], [6, 3]] })), false);
	assert.equal(joiningClosesGift(info({ sf: [[7, 3]], augs: [GIFT] })), false);
	assert.equal(joiningClosesGift(info({ node: 6, sf: [[7, 3]] })), false);
});

test("choice: bladeburner.stanekFirst is on by default in BitNode 13 only", () => {
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
test("game: skillAt and expFor are inverses, and a multiplier scales the level", () => {
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

// The game's level: floor(mult x BitNode level mult x (32 ln(exp + 534.6) - 200))
const gameLevel = (exp, mult, bnMult = 1) => Math.max(1, Math.floor(mult * bnMult * (32 * Math.log(exp + 534.6) - 200)));

test("modelMults reads the BitNode level multiplier back from the live levels (BitNode 6: hacking x0.35)", () => {
	// A BitNode 6 player: aug hacking mult 3.53, hacking 587. Without the 0.35 the route models saw levels 2.9x too high,
	// so the hacking route looked far shorter than it is and Bladeburner was held.
	const exp = { hacking: 1.45e9, strength: 2e7, defense: 2e7, dexterity: 2e7, agility: 2e7 };
	const mults = { hacking: 3.53, strength: 1.8, defense: 1.6, dexterity: 1.7, agility: 1.5 };
	const skills = Object.fromEntries(Object.keys(exp).map((key) => [key, gameLevel(exp[key], mults[key], key === "hacking" ? 0.35 : 1)]));
	assert.ok(Math.abs(skills.hacking - 587) <= 1);
	const model = modelMults({ mults, skills, exp });
	assert.ok(Math.abs(model.hacking / (3.53 * 0.35) - 1) < 0.01, `hacking ${model.hacking}`);
	["strength", "defense", "dexterity", "agility"].forEach((key, i) => assert.ok(Math.abs(model.combat[i] / mults[key] - 1) < 0.01, key));
	assert.ok(Math.abs(skillAt(exp.hacking, model.hacking) - skills.hacking) < 2, "the model's level matches the game's");
});

test("levelFactor is 1 where the level can't be read (low level, no exp, nonsense)", () => {
	assert.equal(levelFactor(10, 1e3, 1), 1, "rounding down dominates at low levels");
	assert.equal(levelFactor(100, 0, 1), 1);
	assert.equal(levelFactor(undefined, 1e6, 1), 1);
	assert.equal(levelFactor(500, 1e9, 0), 1);
	assert.ok(Math.abs(levelFactor(gameLevel(1e9, 2), 1e9, 2) - 1) < 0.01, "no BitNode multiplier: 1");
});

test("modelMults uses the BitNode's known level multipliers while the levels are too low to read them back", () => {
	// Start of a BitNode 10 run: combat 1, exp 0. The gym time to 100 used to be modelled at full speed (x1 instead of x0.4).
	const player = { mults: { hacking: 1, strength: 1.2, defense: 1, dexterity: 1, agility: 1 }, skills: { hacking: 5, strength: 1, defense: 1, dexterity: 1, agility: 1 }, exp: {} };
	assert.deepEqual(modelMults(player).combat, [1.2, 1, 1, 1], "unknown: as before");
	const known = modelMults(player, { combat: 0.4, hacking: 0.8 });
	assert.ok(Math.abs(known.combat[0] - 0.48) < 1e-9 && known.combat[1] === 0.4);
	assert.equal(known.hacking, 0.8);
	assert.equal(levelFactor(10, 1e3, 1, 0.4), 0.4, "the fallback where the level can't be read");
});

test("game: priorRows, the first guess, follows the game's formulas and scales with the BitNode's rank multiplier", () => {
	const lv = { hacking: 50, strength: 5, defense: 5, dexterity: 5, agility: 5, charisma: 5, intelligence: 0 };
	const rows = priorRows(lv);
	assert.equal(rows.length, ACTIONS.length);
	const tracking = rows.find((row) => row.name === "Tracking");
	assert.equal(tracking.lv.agility, JOIN_LEVEL, "read at the join level, not the untrained stats");
	assert.equal(tracking.lv.hacking, 50);
	// v3.0.0: chance = competence x (1.25)^0.7 (average new-city population) / difficulty; time = ceil(difficulty / 10 / timeFactor)
	assert.ok(Math.abs(tracking.chance - rawChance("Tracking", tracking.lv) * Math.pow(1.25, 0.7)) < 1e-9);
	assert.equal(tracking.secs, 11);
	assert.equal(tracking.gain, 0.3);
	const nerfed = priorRows(lv, 0.2);
	assert.ok(Math.abs(nerfed.find((row) => row.name === "Tracking").gain - 0.06) < 1e-12);
	const full = { ...lv, strength: 200, defense: 200, dexterity: 200, agility: 200 };
	const rate = (rankMult) => predictRankPerHour(makeBladeburner(priorRows(lv, rankMult)), full, 4);
	assert.ok(rate(1) > 0);
	assert.ok(Math.abs(rate(0.2) / rate(1) - 0.2) < 0.05, "a fifth of the rank: about a fifth of the rate");
});

test("choice: pickRoute: a first guess moves to hacking only when hacking clearly wins", () => {
	// The first guess (no live readings) is no measurement: Bladeburner keeps training to measure itself unless hacking takes
	// under 75 % of its modelled time
	assert.equal(pickRoute(100, 500, { hasHack: true, guess: true }), "hacking", "BitNode 15-style nerf: skip the gym");
	assert.equal(pickRoute(100, 120, { hasHack: true, guess: true }), "combat", "close: train and measure");
	assert.equal(pickRoute(100, Infinity, { hasHack: true, guess: true }), "hacking", "Bladeburner never finishes on the guess");
	assert.equal(pickRoute(Infinity, Infinity, { hasHack: true, guess: true }), "combat", "nothing finishes: measure");
	assert.equal(pickRoute(100, 120, { hasHack: true }), "hacking", "measured: the faster route");
	assert.equal(pickRoute(100, 90, { hasHack: true, previous: "hacking", guess: true }), "hacking", "a guess already on hacking keeps it within 25 %");
	assert.equal(pickRoute(100, 70, { hasHack: true, previous: "hacking", guess: true }), "combat", "Bladeburner clearly better: back to measuring");
});

test("committedRoute: before live readings only a first-guess hacking route is posted", () => {
	assert.deepEqual(committedRoute("hacking", false, true), { route: "hacking", prior: true });
	assert.deepEqual(committedRoute("combat", false, true), { route: undefined, prior: false }, "the config route applies and it measures");
	assert.deepEqual(committedRoute("hacking", false, false), { route: undefined, prior: false }, "bladeburner.priorRoute off: no guess");
	assert.deepEqual(committedRoute("combat", true, false), { route: "combat", prior: false });
	assert.deepEqual(committedRoute("", true, false), { route: undefined, prior: false }, "every Black Op done");
});

test("bb-manage: a first-guess hacking route holds Bladeburner before any gym", async () => {
	const w = world({ skills: { hacking: 100, strength: 5, defense: 5, dexterity: 5, agility: 5 }, inDivision: false, income: 1e6,
		post: { plan: { route: "hacking", prior: true, time: minutesAgo(1) } } });
	await manage(w.ns);
	assert.equal(w.state(), "hold", "not train");
	assert.match(w.ns.portJson(BB_PORT).lines[0], /first guess from the BitNode's multipliers/);
});

test("projectRoute (hacking) takes longer when the BitNode level multiplier is counted", () => {
	const augs = Array.from({ length: 30 }, (_, i) => ({ name: `A${i}`, price: 1e9 * 1.3 ** i, rep: 1e5 * 1.15 ** i, f: [`F${i % 5}`], h: 1.1, e: 1.1, cs: [1, 1, 1, 1] }));
	const cfg = (hacking) => ({
		augs, nf: null, installed: 31, runHours: 4, income: 3e9, expRate: 6e4, mult: { hacking, hackExp: 1, combat: [1, 1, 1, 1], combatExp: 1 },
		scenario: { income: 0, exp: 0 }, maxRuns: 60, rep: { facMult: 1.5, bn: 1, timeShare: 0.7 },
		hackRoute: { required: 6000, daedalusAugs: 35, daedalusMoney: 1e11, daedalusHack: 2500, rpRep: 2.5e6, rpPrice: 1e10, rpHeld: false, startStage: 0 },
	});
	const raw = projectRoute("hacking", cfg(3.53));
	const real = projectRoute("hacking", cfg(3.53 * 0.35));
	assert.equal(raw.reached, true);
	assert.ok(!real.reached || real.hours > 1.5 * raw.hours, `raw ${raw.hours} h, with x0.35 ${real.reached ? real.hours + " h" : "not reached"}`);
});

// Daedalus in BitNode 6, as getFactionInviteRequirements gives it
const DAEDALUS_REQS = [{ type: "numAugmentations", numAugmentations: 35 }, { type: "money", money: 1e11 },
	{ type: "someCondition", conditions: [{ type: "skills", skills: { hacking: 2500 } }, { type: "skills", skills: { strength: 1500, defense: 1500, dexterity: 1500, agility: 1500 } }] }];

test("inviteGate turns invite requirements into level alternatives (Daedalus: hacking 2500 or combat 1500, 35 augs)", () => {
	const gate = inviteGate(DAEDALUS_REQS);
	assert.deepEqual(gate, [{ hacking: 2500, combat: 0, augs: 35 }, { hacking: 0, combat: 1500, augs: 35 }]);
	assert.equal(gateOpen(gate, { hacking: 2600, combat: 10, installed: 35 }), true);
	assert.equal(gateOpen(gate, { hacking: 600, combat: 1600, installed: 35 }), true, "the combat way in");
	assert.equal(gateOpen(gate, { hacking: 2600, combat: 1600, installed: 31 }), false, "too few augs installed");
	assert.equal(gateOpen(gate, { hacking: 600, combat: 300, installed: 40 }), false);
	const illuminati = inviteGate([{ type: "skills", skills: { hacking: 1500, strength: 1200, defense: 1200, dexterity: 1200, agility: 1200 } }, { type: "numAugmentations", numAugmentations: 30 }]);
	assert.deepEqual(illuminati, [{ hacking: 1500, combat: 1200, augs: 30 }]);
	assert.deepEqual(inviteGate([{ type: "money", money: 1e9 }, { type: "karma", karma: -90 }]), [{ hacking: 0, combat: 0, augs: 0 }], "other conditions are assumed met");
	assert.equal(gateOpen(undefined, { hacking: 1, combat: 1, installed: 0 }), true, "no gate = open");
});

test("projectRoute (hacking) doesn't buy from a faction whose invite the runs never reach", () => {
	// One strong aug sold only by a faction asking hacking 1500 and combat 1200: a BitNode 6 hacking run (level ~550, combat 100) never gets in
	const augs = [{ name: "Q", price: 1e9, rep: 0, f: ["Illuminati"], h: 1.75, e: 1, cs: [1, 1, 1, 1] }];
	const cfg = (gates) => ({
		augs, nf: null, installed: 31, runHours: 4, income: 3e9, expRate: 4e4, mult: { hacking: 1.23, hackExp: 1, combat: [1, 1, 1, 1], combatExp: 1 },
		scenario: { income: 0, exp: 0 }, maxRuns: 3, rep: { facMult: 1, bn: 1, timeShare: 0.7 }, combatLevel: 100, gates,
		hackRoute: { required: 6000, daedalusAugs: 35, daedalusMoney: 1e11, daedalusHack: 2500, rpRep: 2.5e6, rpPrice: 1e10, rpHeld: false, startStage: 0 },
	});
	assert.deepEqual(projectRoute("hacking", cfg(undefined)).log[0].names, ["Q"], "no gates: bought at once");
	const gated = projectRoute("hacking", cfg({ Illuminati: inviteGate([{ type: "skills", skills: { hacking: 1500, strength: 1200, defense: 1200, dexterity: 1200, agility: 1200 } }]) }));
	assert.ok(gated.log.every((run) => !run.names.includes("Q")), "never reachable, never bought");
	const easy = projectRoute("hacking", cfg({ Illuminati: inviteGate([{ type: "skills", skills: { hacking: 100 } }]) }));
	assert.deepEqual(easy.log[0].names, ["Q"], "a gate the run meets opens the faction");
});

test("keepRankSamples restarts after a gap, so time held or training doesn't count as slow play", () => {
	const now = 10 * 3600_000;
	const min = (m) => now - m * 60_000;
	// played 50-40 min ago, held, playing again for the last 6 minutes
	const samples = [{ t: min(50), rank: 0 }, { t: min(45), rank: 40 }, { t: min(40), rank: 80 }, { t: min(6), rank: 80 }, { t: min(3), rank: 110 }];
	assert.deepEqual(keepRankSamples(samples, 130, now), samples.slice(3));
	assert.deepEqual(keepRankSamples(samples.slice(0, 3), 130, now), [], "nothing in the last 10 minutes: start over");
	assert.deepEqual(keepRankSamples([{ t: min(70), rank: 1 }, { t: min(2), rank: 5 }], 6, now), [{ t: min(2), rank: 5 }], "older than the window");
	assert.deepEqual(keepRankSamples([{ t: min(2), rank: 900 }], 5, now), [], "a higher rank is from another BitNode");
	assert.deepEqual(keepRankSamples(undefined, 5, now), []);
});

// All nine Contracts and Operations read at the given combat level (level 1, 30 counts, 5 s contracts and 10 s operations)
function allActions(stat) {
	const lv = { ...LV, strength: stat, defense: stat, dexterity: stat, agility: stat };
	return { lv, acts: makeBladeburner(ACTIONS.map((a) => ({ name: a.name, chance: Math.min(0.95, rawChance(a.name, lv)), gain: a.rank, secs: a.contract ? 5 : 10, level: 1, maxLevel: 1, count: 30, lv }))) };
}
const bladeRoute = (stat, bb = {}) => {
	const { lv, acts } = allActions(stat);
	return projectRoute("combat", {
		augs: [], nf: null, installed: 31, runHours: 4, income: 1e9, expRate: 4e4, mult: { hacking: 1.2, hackExp: 1, combat: Array(4).fill(stat / 72), combatExp: 1 },
		scenario: { income: 0, exp: 0 }, maxRuns: 80, rep: { facMult: 1, bn: 1, timeShare: 0.7 }, bb: { acts, rank: 138, lv, duty: 0.5, gymHours: 1, ...bb },
	});
};

test("skillStart reads the levels, the points and the BitNode's skill cost multiplier from the live Overclock cost", () => {
	const none = skillStart();
	assert.deepEqual([none.oc, none.bi, none.sp, none.costMult], [0, 0, 0, 1]);
	const live = skillStart({ Overclock: 10, "Blade's Intuition": 4, points: 25 }, { Overclock: 2 * (3 + 1.4 * 10) });
	assert.deepEqual([live.oc, live.bi, live.sp], [10, 4, 25]);
	assert.ok(Math.abs(live.costMult - 2) < 1e-9, "twice the formula cost = a x2 BitNode");
	assert.equal(skillStart({ Overclock: 90 }, { Overclock: 1e9 }).costMult, 1, "a maxed Overclock says nothing about the multiplier");
});

test("spendSkills buys Overclock while it pays more per point, Blade's Intuition only while the chance is under 100 %", () => {
	const sk = skillStart({ points: 500 });
	spendSkills(sk, 1);
	assert.ok(sk.oc > 10 && sk.bi === 0, `capped chance: everything to Overclock (oc ${sk.oc}, bi ${sk.bi})`);
	const low = skillStart({ points: 500 });
	spendSkills(low, 0.5);
	assert.ok(low.bi > 0, "a 50 % chance makes Blade's Intuition worth points");
	assert.ok(low.sp < 3 + 2.1 * 90, "points are spent down");
});

test("projectRoute (combat) counts skill points: without them the actions outgrow the stats and the route stalls", () => {
	const without = bladeRoute(600);
	const withSkills = bladeRoute(600, { skills: skillStart() });
	assert.equal(withSkills.reached, true, `with skill points: ${withSkills.hours} h`);
	assert.ok(!without.reached || without.hours > 1.5 * withSkills.hours, `without ${without.reached ? without.hours + " h" : "not reached"}`);
});

test("projectRoute (combat): stamina limits what Overclock is worth", () => {
	const free = bladeRoute(600, { skills: skillStart() });
	const tired = bladeRoute(600, { skills: skillStart(), stamina: { max: 400, regen: 0.05 } });
	assert.ok(tired.reached && tired.hours >= free.hours, `free ${free.hours} h, with stamina ${tired.hours} h`);
	const exhausted = bladeRoute(600, { skills: skillStart(), stamina: { max: 10, regen: 0 } });
	assert.ok(!exhausted.reached || exhausted.hours > tired.hours, "almost no stamina: much slower");
});

test("game: DONATE_REP is the cumulative rep at 150 favour", () => {
	assert.ok(DONATE_REP > 4e5 && DONATE_REP < 5e5);
});

// ---- adaptive skills and city choice (bladeburner/picks.js)
import { chanceGain, topRows, skillValues, pickSkill, cityFactor, pickCity, nextRestShare, scoutTarget, SKILL_NAMES } from "/bladeburner/picks.js";
import { main as play } from "/bladeburner/bb-pass.js";
import { keepRankSamples } from "/bladeburner/ideal.js";

const SKILLS_AT = { hacking: 100, strength: 200, defense: 200, dexterity: 200, agility: 200, charisma: 50, intelligence: 1 };
const row = (type, name, chance, extra = {}) => ({ type, name, chance, lo: chance - 0.02, hi: chance + 0.02, gain: 1, secs: 10, level: 1, maxLevel: 1, count: 5, ...extra });
const readings = (chance, extra = {}) => ({
	lv: SKILLS_AT, city: "Sector-12",
	rows: [row("Contracts", "Tracking", chance), row("Operations", "Investigation", chance * (chance >= 1 ? 1 : 0.9)), row("Contracts", "Bounty Hunter", chance * (chance >= 1 ? 1 : 0.8))],
	cities: [{ name: "Sector-12", pop: 1e9, chaos: 0 }], ...extra,
});

test("chanceGain: a boost is worth nothing once the chance is capped at 1", () => {
	assert.ok(Math.abs(chanceGain(0.5, 0.1) - 0.1) < 1e-9);
	assert.ok(Math.abs(chanceGain(0.95, 0.1) - (1 / 0.95 - 1)) < 1e-9, "only up to the cap");
	assert.equal(chanceGain(1, 0.5), 0);
	assert.equal(chanceGain(0.5, 0), 0);
	assert.equal(chanceGain(0, 0.2), 0.2);
});

test("skillValues: chance skills fade as the chance caps, and Reaper and Evasive System count", () => {
	const low = skillValues(readings(0.5), {}, 0.5);
	const capped = skillValues(readings(1), {}, 0.5);
	for (const name of ["Blade's Intuition", "Tracer", "Digital Observer", "Reaper", "Evasive System"]) {
		assert.ok(low[name] > 0, `${name} helps at 50%`);
		assert.equal(capped[name], 0, `${name} is worth nothing at 100%`);
	}
	assert.ok(low["Evasive System"] < low["Tracer"] * 2 && low["Reaper"] > 0);
	assert.ok(skillValues(readings(0.5), { Tracer: 10 }, 0.5)["Tracer"] < low["Tracer"], "each level is worth less than the one before");
});

test("skillValues: Overclock matters when the player isn't resting, Cyber's Edge when they are", () => {
	const fresh = skillValues(readings(0.8), {}, 0.05);
	const tired = skillValues(readings(0.8), {}, 0.9);
	assert.ok(fresh["Overclock"] > tired["Overclock"]);
	assert.ok(tired["Cyber's Edge"] > fresh["Cyber's Edge"]);
	assert.ok(tired["Cyber's Edge"] > tired["Overclock"] * 10);
});

test("pickSkill: best gain per point, not the first tier; unbuyable skills are skipped", () => {
	const values = skillValues(readings(0.5), {}, 0.5);
	const costs = Object.fromEntries(SKILL_NAMES.map((name) => [name, 3]));
	costs["Overclock"] = 3;
	costs["Tracer"] = 2;
	assert.equal(pickSkill(costs, values).name, "Tracer", "a cheap chance skill beats Overclock");
	costs["Tracer"] = Infinity;
	assert.notEqual(pickSkill(costs, values)?.name, "Tracer");
	assert.equal(pickSkill(Object.fromEntries(SKILL_NAMES.map((name) => [name, Infinity])), values), null);
	assert.equal(topRows({ rows: [{ chance: NaN }] }).length, 0, "junk rows are ignored");
});

test("bb-manage: with readings the points go to the best skill, not Overclock first", async () => {
	const costs = { Overclock: 3, Tracer: 2, "Blade's Intuition": 3, "Digital Observer": 2, Reaper: 2, "Evasive System": 2, "Cyber's Edge": 1, Hyperdrive: 1, Cloak: 2, "Short-Circuit": 2 };
	const w = world({ points: 6, costs, post: { actions: readings(0.5), restShare: 0.6 } });
	await manage(w.ns);
	assert.ok(w.bought.length > 0);
	assert.ok(!w.bought.includes("Overclock"), `bought ${w.bought.join(", ")}`);
	const capped = world({ points: 1, costs, post: { actions: readings(1), restShare: 0.9 } });
	await manage(capped.ns);
	assert.deepEqual(capped.bought, ["Cyber's Edge"], "with every chance capped and a lot of resting, stamina is the one that pays");
});

test("bb-manage: waits for points rather than buying a lesser skill ahead of the best one", async () => {
	const costs = { Overclock: 3, Tracer: 5, "Blade's Intuition": 50, "Digital Observer": 50, Reaper: 50, "Evasive System": 50, "Cyber's Edge": 50, Hyperdrive: 50, Cloak: 50, "Short-Circuit": 50 };
	const w = world({ points: 3, costs, overclock: 0, post: { actions: readings(0.5, { rows: [row("Contracts", "Tracking", 0.5)] }), restShare: 0.1 } });
	await manage(w.ns);
	assert.deepEqual(w.bought, [], "Tracer is the best buy and costs 5");
});

test("bladeburner.adaptiveSkills false keeps the fixed tiers even with readings", async () => {
	const costs = { Overclock: 3, Tracer: 2 };
	const w = world({ points: 4, costs, files: { "data/config.json": JSON.stringify({ bladeburner: { adaptiveSkills: false } }) }, post: { actions: readings(0.5) } });
	await manage(w.ns);
	assert.equal(w.bought[0], "Overclock");
	assert.equal(loadConfig(fakeNs({})).bladeburner.adaptiveSkills, true, "on by default");
	assert.equal(loadConfig(fakeNs({})).bladeburner.switchCity, true);
});

test("game: cityFactor: population to the 0.7, less chaos above 50", () => {
	assert.equal(cityFactor({ pop: 1e9, chaos: 0 }), 1);
	assert.ok(Math.abs(cityFactor({ pop: 2e9, chaos: 0 }) - 2 ** 0.7) < 1e-9);
	assert.equal(cityFactor({ pop: 1e9, chaos: 40 }), 1, "no penalty up to chaos 50");
	assert.ok(Math.abs(cityFactor({ pop: 1e9, chaos: 74 }) - 1 / 5) < 1e-9, "sqrt(1 + 24) = 5");
	assert.equal(cityFactor({ pop: 0 }), 0);
	assert.equal(cityFactor(undefined), 0);
});

test("pickCity: moves for a clear gain, stays for a small one, a capped chance, or noisy estimates", () => {
	const cities = [{ name: "Sector-12", pop: 0.8e9, chaos: 0 }, { name: "Aevum", pop: 1.6e9, chaos: 0 }, { name: "Volhaven", pop: 0.9e9, chaos: 0 }];
	const move = pickCity(readings(0.4, { cities }));
	assert.equal(move.city, "Aevum");
	assert.ok(move.gain > move.needed);
	assert.equal(pickCity(readings(0.4, { cities: [cities[0], { name: "Ishima", pop: 0.85e9, chaos: 0 }] })), null, "a few percent is inside the noise");
	assert.equal(pickCity(readings(1, { cities })), null, "already succeeds every time");
	const noisy = readings(0.4, { cities });
	noisy.rows = noisy.rows.map((r) => ({ ...r, lo: r.chance - 0.5, hi: r.chance + 0.5 }));
	assert.equal(pickCity(noisy), null, "estimates too wide to trust the populations");
	const chaotic = readings(0.4, { cities: [{ name: "Sector-12", pop: 1e9, chaos: 80 }, { name: "Aevum", pop: 1e9, chaos: 0 }] });
	assert.equal(pickCity(chaotic).city, "Aevum", "chaos in the current city makes another one better");
	assert.equal(pickCity({ rows: [], cities, city: "Sector-12" }), null);
	assert.equal(pickCity({}), null);
});

test("nextRestShare moves slowly toward the latest pass", () => {
	assert.equal(nextRestShare(undefined, false), 0.5 - 0.01);
	assert.ok(nextRestShare(0.5, true) > 0.5 && nextRestShare(0.5, true) < 0.52);
	assert.equal(nextRestShare(0, false), 0);
});

/** bb-pass.js on a player in `city` with the given population and chaos per city. */
function pass({ city = "Sector-12", cities, files = {}, current = null, stamina = [100, 100], chances = {}, gains = {}, seconds = {}, counts = {}, post = {}, rank = 50 } = {}) {
	const moved = [];
	let here = city;
	const ns = fakeNs({
		files,
		ports: { [BB_PORT]: { state: "run", stateTime: Date.now(), ...post } },
		overrides: {
			getScriptName: () => "bladeburner/bb-pass.js",
			getPlayer: () => ({ skills: SKILLS_AT }),
			getTotalScriptIncome: () => [0, 0],
			bladeburner: {
				inBladeburner: () => true,
				getStamina: () => stamina,
				getCurrentAction: () => current,
				getRank: () => rank,
				getNextBlackOp: () => ({ name: "Operation Typhoon", rank: 2500 }),
				getActionEstimatedSuccessChance: (type, name) => chances[name] ?? [0.38, 0.42],
				getActionRankGain: (type, name) => gains[name] ?? 1,
				getActionTime: (type, name) => (seconds[name] ?? 10) * 1000,
				getActionCurrentLevel: () => 1,
				getActionMaxLevel: () => 1,
				getActionCountRemaining: (type, name) => counts[name] ?? 5,
				getCityChaos: (name) => cities.find((c) => c.name === (name ?? here)).chaos,
				getCityEstimatedPopulation: (name) => cities.find((c) => c.name === name).pop,
				getCity: () => here,
				startAction: () => true,
				switchCity: (name) => { moved.push(name); here = name; return true; },
			},
		},
	});
	return { ns, moved };
}

test("bb-pass: plays in the better city and says so; the config switch turns it off", async () => {
	const cities = [{ name: "Sector-12", pop: 0.8e9, chaos: 0 }, { name: "Aevum", pop: 1.8e9, chaos: 0 }];
	const on = pass({ cities });
	await play(on.ns);
	assert.deepEqual(on.moved, ["Aevum"]);
	assert.match(on.ns.portJson(BB_PORT).lines.join("\n"), /moved to Aevum/);
	const off = pass({ cities, files: { "data/config.json": JSON.stringify({ bladeburner: { switchCity: false } }) } });
	await play(off.ns);
	assert.deepEqual(off.moved, []);
});

test("bb-pass: stays when the current city is already the best", async () => {
	const cities = [{ name: "Sector-12", pop: 1.8e9, chaos: 0 }, { name: "Aevum", pop: 0.8e9, chaos: 0 }];
	const here = pass({ cities });
	await play(here.ns);
	assert.deepEqual(here.moved, []);
});

test("bb-pass: posts how much of the time it spends resting", async () => {
	const cities = [{ name: "Sector-12", pop: 1e9, chaos: 0 }];
	const tired = pass({ cities, stamina: [20, 100], current: { type: "General", name: "Hyperbolic Regeneration Chamber" } });
	tired.ns.ports[BB_PORT] = JSON.stringify({ state: "run", stateTime: Date.now(), restShare: 0.5 });
	await play(tired.ns);
	assert.ok(tired.ns.portJson(BB_PORT).restShare > 0.5, "resting pushes the share up");
	const fresh = pass({ cities });
	await play(fresh.ns);
	assert.ok(fresh.ns.portJson(BB_PORT).restShare < 0.5);
});

// ---- income fit (route-model.js fitIncomeExponent)
const HISTORY = [[1.2666, 903121], [1.2666, 434143], [1.3716, 287114], [1.4416, 195396], [1.4853, 2229749], [1.6375, 2361507], [1.7211, 779919], [1.7733, 7893511], [1.8974, 712538533], [2.4123, 835280806], [2.6648, 284077330]]
	.map(([mult, income]) => ({ mult, income }));

test("fitIncomeExponent: a clean power law is reliable and recovers the exponent", () => {
	const points = [1, 1.2, 1.5, 2, 2.5].map((mult) => ({ mult, income: 1e5 * mult ** 1.5 }));
	const fit = fitIncomeExponent(points);
	assert.equal(fit.reliable, true);
	assert.ok(Math.abs(fit.exponent - 1.5) < 1e-6 && fit.r2 > 0.999);
});

test("fitIncomeExponent: income that jumped for other reasons is not trusted (a real history: x90 income for 7% more multiplier)", () => {
	const fit = fitIncomeExponent(HISTORY);
	assert.equal(fit.reliable, false, `slope ${fit.raw}, R2 ${fit.r2}`);
	assert.equal(fit.runs, 11);
});

test("fitIncomeExponent: too few runs, or multipliers that barely differ, give no fit", () => {
	assert.equal(fitIncomeExponent([{ mult: 1, income: 5 }, { mult: 2, income: 9 }]).reliable, false);
	assert.equal(fitIncomeExponent([1, 1.1, 1.2, 1.25].map((mult) => ({ mult, income: 100 * mult }))).reliable, false);
	assert.equal(fitIncomeExponent(undefined).reliable, false);
	assert.ok(Number.isNaN(fitIncomeExponent([]).exponent));
});

test("fitIncomeExponent: a falling income is not reliable (negative slope)", () => {
	const fit = fitIncomeExponent([1, 1.5, 2, 3].map((mult, i) => ({ mult, income: 1e6 / (1 + i * 3) })));
	assert.equal(fit.reliable, false);
	assert.equal(fit.exponent, 0, "clamped at zero");
});

// ---- scouting with Field Analysis
const srow = (name, low, high, gain, secs) => ({ name, low, high, middle: (low + high) / 2, gain, secs, count: 3 });

test("scoutTarget: scouts when an unsure action's range straddles the best safe one, and not otherwise", () => {
	const safe = srow("Tracking", 0.8, 0.9, 0.3, 10);                       // 0.0255 rank/s
	assert.equal(scoutTarget([safe, srow("Raid", 0.07, 0.95, 55, 66)], 0.6).name, "Raid", "a 7-95% range around a far better action");
	assert.equal(scoutTarget([safe, srow("Raid", 0.5, 0.52, 55, 66)], 0.6), null, "range narrow and under the safe bar: it is simply not safe");
	assert.equal(scoutTarget([safe, srow("Sting", 0.05, 0.4, 0.1, 100)], 0.6), null, "even its best case is under the safe bar");
	assert.equal(scoutTarget([safe, srow("Sting", 0.3, 0.9, 0.1, 100)], 0.6), null, "uncertain, but its expected rate is below the safe action's");
	assert.equal(scoutTarget([srow("Raid", 0.07, 0.95, 55, 66)], 0.6), null, "nothing safe: the caller already analyses");
	assert.equal(scoutTarget([safe, { ...srow("Raid", 0.07, 0.95, 55, 66), count: 0 }], 0.6), null, "none left to run");
	assert.equal(scoutTarget([safe, srow("Raid", 0.65, 0.95, 55, 66)], 0.6), null, "already safe by its low estimate");
});

test("bb-pass: scouts with Field Analysis while a better action is too uncertain; the config switch turns it off", async () => {
	const cities = [{ name: "Sector-12", pop: 1e9, chaos: 0 }];
	const setup = { cities, chances: { Tracking: [0.8, 0.9], Raid: [0.07, 0.95] }, gains: { Tracking: 0.3, Raid: 55 }, seconds: { Tracking: 10, Raid: 66 } };
	const on = pass(setup);
	await play(on.ns);
	assert.deepEqual(on.ns.called("bladeburner.startAction").at(-1), ["General", "Field Analysis"]);
	const off = pass({ ...setup, files: { "data/config.json": JSON.stringify({ bladeburner: { fieldAnalysis: false } }) } });
	await play(off.ns);
	assert.deepEqual(off.ns.called("bladeburner.startAction").at(-1), ["Contracts", "Tracking"]);
	assert.equal(loadConfig(fakeNs({})).bladeburner.fieldAnalysis, true, "on by default");
});

test("bb-pass: scouting takes at most a fifth of the time; past that the safe action plays (Field Analysis took all of a BitNode 6 start)", async () => {
	const cities = [{ name: "Sector-12", pop: 1e9, chaos: 0 }];
	const setup = { cities, chances: { Tracking: [0.8, 0.9], Raid: [0.07, 0.95] }, gains: { Tracking: 0.3, Raid: 55 }, seconds: { Tracking: 10, Raid: 66 } };
	const fresh = pass(setup);
	await play(fresh.ns);
	assert.deepEqual(fresh.ns.called("bladeburner.startAction").at(-1), ["General", "Field Analysis"]);
	assert.ok(fresh.ns.portJson(BB_PORT).scoutShare > 0, "the share goes up while scouting");
	const busy = pass({ ...setup, post: { scoutShare: 0.25 } });
	await play(busy.ns);
	assert.deepEqual(busy.ns.called("bladeburner.startAction").at(-1), ["Contracts", "Tracking"], "over the cap: play the safe action");
	assert.ok(busy.ns.portJson(BB_PORT).scoutShare < 0.25, "and the share comes back down");
});
