// utils/route-focus.js: what the hacking route waits for, and the scripts that follow it (docs/route-focus.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { DEFAULTS } from "/config.js";
import { loadConfig } from "/utils/config.js";
import {
	routeFocus, inviteGaps, pickGoalFaction, spareRamGoesToShare, readRouteFocus, hackingBinding, skipSideQuests, postRouteFocus, FOCUS_PORT,
} from "/utils/route-focus.js";
import { workStep, currentFocus } from "/singularity/player-work.js";
import { combatTarget, planSleeves, gangInviteOpen } from "/sleeves/plan.js";

// Daedalus' invite as getFactionInviteRequirements gives it: installed augs, cash, and hacking 2500 or all four combat stats 1500
const INVITE = [
	{ type: "numAugmentations", numAugmentations: 30 },
	{ type: "money", money: 100e9 },
	{ type: "someCondition", conditions: [
		{ type: "skills", skills: { hacking: 2500 } },
		{ type: "skills", skills: { strength: 1500, defense: 1500, dexterity: 1500, agility: 1500 } },
	] },
];
const have = (changes = {}) => ({ money: 5e15, installed: 36, skills: { hacking: 1680, strength: 211, defense: 165, dexterity: 69, agility: 55 }, ...changes });
const input = (changes = {}) => ({
	route: "hacking", hacking: 1680, daemonLevel: 6000, daedalusJoined: false, redPillInstalled: false, invite: INVITE, have: have(), ...changes,
});

test("regression: Daedalus' invite short only of hacking level is the hacking-level phase, not the combat alternative", () => {
	const focus = routeFocus(input());
	assert.equal(focus.phase, "level");
	assert.equal(focus.binding, true, "hacking exp is what the route waits for");
	assert.equal(focus.skipSide, true);
	assert.equal(focus.gap, 2500 - 1680, "the gap is the hacking alternative's, though the combat stats are the 'closest' by count");
});

test("level phase: cash still on its way does not change it; missing installed augments or an unknown invite do", () => {
	assert.equal(routeFocus(input({ have: have({ money: 1e9 }) })).phase, "level", "money arrives while the level is earned");
	const noAugs = routeFocus(input({ have: have({ installed: 12 }) }));
	assert.equal(noAugs.phase, "none", "installed augments are the reset rule's business");
	assert.match(noAugs.reason, /augs/);
	assert.equal(routeFocus(input({ invite: null })).phase, "none", "no requirements posted: nothing changes");
	assert.equal(routeFocus(input({ hacking: 2600, have: have({ skills: { hacking: 2600 } }) })).phase, "none", "the invite is met");
});

test("the route decides: combat route, a missing route or the kill switch leave everything as it was", () => {
	for (const changes of [{ route: "combat" }, { route: undefined }, { enabled: false }]) {
		const focus = routeFocus(input(changes));
		assert.deepEqual([focus.phase, focus.binding, focus.skipSide], ["none", false, false], JSON.stringify(changes));
	}
});

test("Daedalus joined: rep is what is left, so spare RAM stays with share but the side quests wait", () => {
	const focus = routeFocus(input({ daedalusJoined: true, invite: null }));
	assert.deepEqual([focus.phase, focus.binding, focus.skipSide], ["rep", false, true]);
});

test("The Red Pill installed: the daemon's hacking level binds until it is reached", () => {
	const short = routeFocus(input({ daedalusJoined: true, redPillInstalled: true, hacking: 5000 }));
	assert.deepEqual([short.phase, short.binding, short.gap], ["daemon", true, 1000]);
	assert.equal(routeFocus(input({ redPillInstalled: true, hacking: 6000 })).phase, "none");
	assert.equal(routeFocus(input({ redPillInstalled: true, daemonLevel: null })).phase, "none", "a BitNode without a tabled level: nothing to wait for");
});

test("inviteGaps: the hacking alternative wins over a closer-looking combat one; every unmet kind is listed", () => {
	const gaps = inviteGaps(INVITE, have({ money: 1, installed: 1 }));
	assert.deepEqual([...gaps.kinds].sort(), ["augs", "hacking", "money"]);
	assert.equal(inviteGaps([{ type: "karma", karma: -9 }], have()).kinds[0], "other");
});

test("the post: read back while fresh, ignored when old or missing", () => {
	const ns = fakeNs();
	assert.equal(readRouteFocus(ns), null);
	assert.equal(hackingBinding(ns), false);
	postRouteFocus(ns, routeFocus(input()));
	assert.equal(hackingBinding(ns), true);
	assert.equal(skipSideQuests(ns), true);
	const old = fakeNs({ ports: { [FOCUS_PORT]: { phase: "level", binding: true, skipSide: true, time: Date.now() - 11 * 60_000 } } });
	assert.equal(hackingBinding(old), false, "a stopped player-work.js can't pin the others to an old answer");
});

test("spare RAM: share keeps it during faction work, the farm takes it while the route waits for hacking exp", () => {
	const during = { factionWork: true, shareRunning: true, farmRunning: true, binding: false };
	assert.equal(spareRamGoesToShare(during), true, "the old rule");
	assert.equal(spareRamGoesToShare({ ...during, binding: true }), false, "regression: share used to starve the farm while hacking level was the wait");
	assert.equal(spareRamGoesToShare({ ...during, binding: true, farmRunning: false }), true, "no farm running: share keeps using the RAM");
	assert.equal(spareRamGoesToShare({ ...during, factionWork: false }), false, "not faction work: the farm as before");
});

test("pickGoalFaction: config order, or the most augment value per missing rep while hacking exp binds", () => {
	const goals = { A: { rep: 100000, value: 0.2 }, B: { rep: 20000, value: 0.15 }, C: { rep: 50000, value: 0.1 } };
	const repOf = () => 0;
	assert.equal(pickGoalFaction(["A", "B", "C"], goals, repOf, false), "A", "config order without the focus");
	assert.equal(pickGoalFaction(["A", "B", "C"], goals, repOf, true), "B", "0.15 over 20k beats 0.2 over 100k");
	assert.equal(pickGoalFaction(["A", "B", "C"], goals, (faction) => (faction === "A" ? 99000 : 0), true), "A", "rep already earned counts");
	assert.equal(pickGoalFaction(["A", "B"], { A: { rep: 1 }, B: { rep: 1, value: 1 } }, repOf, true), "A", "no value reading: config order");
	assert.equal(pickGoalFaction([], goals, repOf, true), "");
});

// --- The scripts that follow it ---

const STRONG = (changes = {}) => ({
	city: "Sector-12", money: 1e12, factions: ["CyberSec", "Clarke Incorporated"], jobs: {}, karma: 0, numPeopleKilled: 0,
	skills: { hacking: 1680, strength: 10, defense: 10, dexterity: 10, agility: 10 }, ...changes,
});
function world(current = null) {
	return fakeNs({
		overrides: {
			getResetInfo: () => ({ currentNode: 1, ownedSF: new Map(), ownedAugs: new Map(), lastAugReset: 0 }),
			singularity: {
				getCurrentWork: () => current, getFactionRep: () => 0, getCompanyRep: () => 1e9, workForFaction: () => true,
				gymWorkout: () => true, travelToCity: () => true, commitCrime: () => 3000, stopAction: () => true, applyToCompany: () => "", workForCompany: () => true,
			},
			getScriptRam: () => 1,
		},
	});
}
const passState = (changes = {}) => ({
	config: JSON.parse(JSON.stringify(DEFAULTS)), focus: false, holdCity: false, studyLevel: 50, noCompany: true, travelDone: true, gangDone: false,
	goals: {
		CyberSec: { rep: 10000, aug: "X", count: 1, skipped: 0, value: 0.01 },
		"Clarke Incorporated": { rep: 10000, aug: "Y", count: 1, skipped: 0, value: 0.5 },
	},
	gang: { applies: true, faction: "Slum Snakes", missing: ["karma -3 / -54000"], crime: "Homicide", rate: 60, chance: 0.9, gain: "karma", gym: 0, slow: false },
	...changes,
});
const LEVEL = routeFocus(input());

test("player-work: the gang invite's crime waits while the route has a next step, and comes back with the kill switch", () => {
	const off = world();
	workStep(off, passState(), STRONG());
	assert.deepEqual(off.called("singularity.commitCrime"), [["Homicide", false]], "before: the gang crime came first");
	const on = world();
	const result = workStep(on, passState({ routeState: LEVEL }), STRONG());
	assert.equal(on.called("singularity.commitCrime").length, 0);
	assert.equal(on.called("singularity.workForFaction").length, 1, "faction work instead");
	assert.match(result.message, /\[faction-work\]/);
	const none = world();
	workStep(none, passState({ routeState: routeFocus(input({ enabled: false })) }), STRONG());
	assert.equal(none.called("singularity.commitCrime").length, 1, "kill switch: as before");
});

test("player-work: while hacking exp binds, the faction with the most augment value per missing rep is worked", () => {
	const ns = world();
	workStep(ns, passState({ routeState: LEVEL, gang: null }), STRONG());
	assert.equal(ns.called("singularity.workForFaction")[0][0], "Clarke Incorporated");
	const plain = world();
	workStep(plain, passState({ gang: null }), STRONG());
	assert.equal(plain.called("singularity.workForFaction")[0][0], "CyberSec", "no focus: the config order");
});

test("currentFocus: reads Daedalus' invite from the fresh aug plan and the route from the estimate", () => {
	const plan = { checkedAt: 5, bitnode: { daedalusInvite: INVITE } };
	const ns = fakeNs({
		files: { "data/aug-plan.json": JSON.stringify(plan) },
		ports: { 36: { plan: { route: "hacking", time: Date.now() } } },
		overrides: { getResetInfo: () => ({ currentNode: 1, ownedSF: new Map(), ownedAugs: new Map(Array.from({ length: 36 }, (_, i) => [`aug${i}`, 1])), lastAugReset: 1 }) },
	});
	const config = loadConfig(fakeNs());
	assert.equal(currentFocus(ns, config, STRONG({ money: 5e15 })).phase, "level");
	const stale = fakeNs({
		files: { "data/aug-plan.json": JSON.stringify({ ...plan, checkedAt: 0 }) },
		ports: { 36: { plan: { route: "hacking", time: Date.now() } } },
		overrides: { getResetInfo: () => ({ currentNode: 1, ownedSF: new Map(), ownedAugs: new Map(), lastAugReset: 1 }) },
	});
	assert.equal(currentFocus(stale, config, STRONG()).phase, "none", "a plan from before the last install says nothing about this run");
});

test("sleeves: no gang-invite gym or Homicide while the route has a next step", () => {
	const invite = { applies: true, crime: "Homicide", gain: "karma", gym: 0 };
	const rule = DEFAULTS.sleeves.train;
	assert.equal(combatTarget({ invite }, rule), 30, "before: the invite sends sleeves to the gym");
	assert.equal(combatTarget({ invite, focus: { skipSide: true } }, rule), 0);
	assert.equal(gangInviteOpen({ invite, focus: { skipSide: false } }), true);
	const config = loadConfig(fakeNs());
	const sleeve = { index: 0, shock: 0, sync: 100, memory: 50, city: "Sector-12", skills: { hacking: 500, strength: 5, defense: 5, dexterity: 5, agility: 5 }, mults: {}, task: null };
	const base = { sleeves: [sleeve], cash: 1e9, goals: null, playerFaction: "", joined: [], jobs: {}, invite, bb: { state: "hold" }, crimes: null };
	assert.equal(planSleeves(base, config)[0].role, "train");
	assert.notEqual(planSleeves({ ...base, focus: { skipSide: true } }, config)[0].role, "train");
	assert.notEqual(planSleeves({ ...base, focus: { skipSide: true } }, config)[0].role, "karma");
});

test("inviteGaps: a skills need short in hacking and another stat is not a hacking-only wait; of two hacking alternatives the nearer counts", () => {
	const mixed = inviteGaps({ type: "skills", skills: { hacking: 2500, strength: 1500 } }, have());
	assert.deepEqual(mixed.kinds, ["skills"]);
	const near = inviteGaps({ type: "someCondition", conditions: [{ type: "skills", skills: { hacking: 3000 } }, { type: "skills", skills: { hacking: 2500 } }] }, have());
	assert.equal(near.gap, 2500 - 1680);
});
