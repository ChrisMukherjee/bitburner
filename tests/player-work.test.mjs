// singularity/player-work.js gymStep (combat stats for Bladeburner or a gang invite) and the
// course choice in utils/study.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { gymStep } from "/singularity/player-work.js";
import { pickCourse, isCourse } from "/utils/study.js";

const FLOOR = 100;
const POWERHOUSE_CASH = 2400 * 600; // GYM_CASH_SECONDS of Powerhouse Gym's fee

/** A player in `city` with these combat stats and cash. */
function player({ city = "Sector-12", money = 0, str = 10, def = 20, dex = 30, agi = 40 } = {}) {
	return { city, money, skills: { strength: str, defense: def, dexterity: dex, agility: agi } };
}
const gymClass = (location, classType = "GYMSTRENGTH") => ({ type: "CLASS", classType, location });
const gymNs = () => fakeNs({ overrides: { singularity: { gymWorkout: () => true, travelToCity: () => true } } });
const state = (changes = {}) => ({ focus: false, holdCity: false, ...changes });

test("every combat stat at the floor: nothing to do", () => {
	const ns = gymNs();
	assert.equal(gymStep(ns, state(), player({ str: 100, def: 100, dex: 100, agi: 100 }), null, FLOOR, "[bb]"), null);
	assert.equal(ns.calls.length, 0);
});

test("trains the lowest stat at the best gym the cash allows", () => {
	const ns = gymNs();
	gymStep(ns, state(), player({ money: 1e5, str: 50, def: 5 }), null, FLOOR, "[bb]");
	assert.deepEqual(ns.called("singularity.gymWorkout"), [["Iron Gym", "def", false]]);
	const rich = gymNs();
	gymStep(rich, state(), player({ money: POWERHOUSE_CASH, str: 50, def: 5 }), null, FLOOR, "[bb]");
	assert.deepEqual(rich.called("singularity.gymWorkout"), [["Powerhouse Gym", "def", false]]);
});

test("a running class for a stat still below the floor is left alone", () => {
	const ns = gymNs();
	// Defense is lowest now, but strength's class keeps running so the class doesn't swap every pass.
	const line = gymStep(ns, state(), player({ money: 1e5, str: 15, def: 10 }), gymClass("Iron Gym"), FLOOR, "[bb]");
	assert.match(line, /training strength/);
	assert.equal(ns.called("singularity.gymWorkout").length, 0);
});

test("regression: training at Iron Gym moves to Powerhouse once the cash allows", () => {
	const ns = gymNs();
	gymStep(ns, state(), player({ money: POWERHOUSE_CASH, str: 10 }), gymClass("Iron Gym"), FLOOR, "[bb]");
	assert.deepEqual(ns.called("singularity.gymWorkout"), [["Powerhouse Gym", "str", false]]);
});

test("already at Powerhouse with the cash: no restart", () => {
	const ns = gymNs();
	gymStep(ns, state(), player({ money: 10 * POWERHOUSE_CASH, str: 10 }), gymClass("Powerhouse Gym"), FLOOR, "[bb]");
	assert.equal(ns.called("singularity.gymWorkout").length, 0);
});

test("no gym in this city: flies to Sector-12 first, unless waiting here for an invite", () => {
	const ns = gymNs();
	gymStep(ns, state(), player({ city: "Chongqing", money: 1e6 }), null, FLOOR, "[bb]");
	assert.deepEqual(ns.called("singularity.travelToCity"), [["Sector-12"]]);
	assert.equal(ns.called("singularity.gymWorkout").length, 1);

	const held = gymNs();
	const line = gymStep(held, state({ holdCity: true }), player({ city: "Chongqing", money: 1e6 }), null, FLOOR, "[bb]");
	assert.match(line, /staying here/);
	assert.equal(held.calls.filter((call) => call.name.startsWith("singularity.")).length, 0);
});

test("no gym here and no money for the flight: waits", () => {
	const ns = gymNs();
	const line = gymStep(ns, state(), player({ city: "Chongqing", money: 1000 }), null, FLOOR, "[bb]");
	assert.match(line, /waiting to fly/);
	assert.equal(ns.called("singularity.travelToCity").length, 0);
});

// --- Study course (utils/study.js) ---

test("pickCourse: the paid course once cash covers paidSeconds of its fee", () => {
	const studying = { course: "Computer Science", paidCourse: "Algorithms", paidPerSecond: 960, paidSeconds: 600 };
	assert.equal(pickCourse(studying, 960 * 600 - 1), "Computer Science");
	assert.equal(pickCourse(studying, 960 * 600), "Algorithms");
	assert.equal(pickCourse({ ...studying, paidCourse: "" }, 1e12), "Computer Science");
});

test("isCourse matches the class name the game reports", () => {
	assert.equal(isCourse({ type: "CLASS", classType: "Algorithms" }, "Algorithms"), true);
	assert.equal(isCourse({ type: "CLASS", classType: "STUDYCOMPUTERSCIENCE" }, "Computer Science"), true);
	assert.equal(isCourse({ type: "CLASS", classType: "GYMSTRENGTH" }, "Algorithms"), false);
	assert.equal(isCourse(null, "Algorithms"), false);
});

// --- idleStep: nothing left to do past the study target -> crime instead of the free class ---
import { idleStep } from "/singularity/player-work.js";

const idleState = (studying = {}) => ({ focus: true, studyLevel: 50, config: { studying: { paidCourse: "Algorithms", ...studying } } });
const idlePlayer = (hacking = 225) => ({ skills: { hacking } });
function idleNs() {
	return fakeNs({
		files: { "singularity/workers/start-crime.js": "", "utils/notify.js": "" },
		overrides: {
			getHostname: () => "home", getScriptRam: () => 12.1, hasRootAccess: () => false,
			getServer: () => ({}), scan: () => [], scp: () => true,
			exec: () => 4242, getServerMaxRam: () => 64, getServerUsedRam: () => 0,
		},
	});
}
const startedCrime = (ns) => ns.called("exec").some(([script]) => script === "singularity/workers/start-crime.js");

test("regression: the free class running past the study target with nothing else to do is replaced by the cash crime", () => {
	const ns = idleNs();
	const line = idleStep(ns, idleState(), idlePlayer(), { type: "CLASS", classType: "STUDYCOMPUTERSCIENCE" });
	assert.match(line, /crime for cash/);
	assert.ok(startedCrime(ns));
});

test("idle with no work at all also takes the crime", () => {
	const ns = idleNs();
	assert.ok(idleStep(ns, idleState(), idlePlayer(), null));
	assert.ok(startedCrime(ns));
});

test("not idle: still studying, other work, a crime already running, or the paid course", () => {
	for (const [hacking, current] of [
		[40, { type: "CLASS", classType: "STUDYCOMPUTERSCIENCE" }],
		[225, { type: "FACTION", factionName: "CyberSec" }],
		[225, { type: "CRIME", crimeType: "Mug" }],
		[225, { type: "CLASS", classType: "ALGORITHMS" }],
	]) {
		const ns = idleNs();
		assert.equal(idleStep(ns, idleState(), idlePlayer(hacking), current), null);
		assert.ok(!startedCrime(ns));
	}
});

test("studying.idleCrime: false keeps the class", () => {
	const ns = idleNs();
	assert.equal(idleStep(ns, idleState({ idleCrime: false }), idlePlayer(), { type: "CLASS", classType: "STUDYCOMPUTERSCIENCE" }), null);
	assert.ok(!startedCrime(ns));
});

test("no room for the helper yet: says so and the class keeps running", () => {
	const ns = fakeNs({ files: { "singularity/workers/start-crime.js": "" },
		overrides: { getHostname: () => "home", getScriptRam: () => 12.1, hasRootAccess: () => false, getServer: () => ({}), scan: () => [], scp: () => true, exec: () => 0, getServerMaxRam: () => 8, getServerUsedRam: () => 8 } });
	assert.match(idleStep(ns, idleState(), idlePlayer(), { type: "CLASS", classType: "STUDYCOMPUTERSCIENCE" }), /no room/);
});

// --- The Blade's Simulacrum and crime-faction invites (workStep, inviteFlight, crime-invites.js) ---
import { workStep, inviteFlight } from "/singularity/player-work.js";
import { pickInvite, inviteNeeds } from "/singularity/workers/crime-invites.js";
import { DEFAULTS } from "/config.js";

const SIMULACRUM = "The Blade's Simulacrum";
const STRONG_PLAYER = (changes = {}) => ({
	city: "Sector-12", money: 1e12, factions: ["CyberSec"], jobs: {}, karma: 0, numPeopleKilled: 0,
	skills: { hacking: 500, strength: 300, defense: 310, dexterity: 320, agility: 330 }, ...changes,
});
/** A pass of workStep with Bladeburner in `bbState`, the augmentations installed, and `current` work. */
function bbWorld({ bbState = "run", augs = [], current = null } = {}) {
	return fakeNs({
		ports: { 36: { state: bbState, stateTime: Date.now() } },
		overrides: {
			getResetInfo: () => ({ currentNode: 6, ownedSF: new Map(), ownedAugs: new Map(augs.map((aug) => [aug, 1])), lastAugReset: 0 }),
			singularity: {
				getCurrentWork: () => current, getFactionRep: () => 0, getCompanyRep: () => 1e9, workForFaction: () => true,
				gymWorkout: () => true, travelToCity: () => true, commitCrime: () => 3000, stopAction: () => true,
				applyToCompany: () => "", workForCompany: () => true,
			},
			getScriptRam: () => 1,
		},
	});
}
const passState = (changes = {}) => ({
	config: JSON.parse(JSON.stringify(DEFAULTS)), focus: false, holdCity: false, studyLevel: 50, noCompany: true,
	goals: { CyberSec: { rep: 1e6, aug: "X", count: 1, skipped: 0 } }, gangDone: true, travelDone: true, ...changes,
});

test("Bladeburner playing without the Simulacrum: nothing else is started", () => {
	const ns = bbWorld();
	const result = workStep(ns, passState(), STRONG_PLAYER());
	assert.match(result.message, /\[bladeburner\] playing/);
	assert.equal(ns.called("singularity.workForFaction").length, 0);
});

test("with The Blade's Simulacrum installed, faction work runs alongside Bladeburner", () => {
	const ns = bbWorld({ augs: [SIMULACRUM] });
	const result = workStep(ns, passState(), STRONG_PLAYER());
	assert.equal(ns.called("singularity.workForFaction").length, 1);
	assert.match(result.message, /Bladeburner keeps playing/);
});

test("Simulacrum and nothing else to do: the lowest combat stat goes to the gym (not the cash crime)", () => {
	const ns = bbWorld({ augs: [SIMULACRUM] });
	const result = workStep(ns, passState({ goals: {} }), STRONG_PLAYER());
	assert.deepEqual(ns.called("singularity.gymWorkout").map((call) => call[1]), ["str"]);
	assert.match(result.message, /Bladeburner's chances/);
	// Strength's class runs on until it is 5 % above the new lowest, then defense takes over
	const running = { type: "CLASS", classType: "GYMSTRENGTH", location: "Powerhouse Gym" };
	const keep = bbWorld({ augs: [SIMULACRUM], current: running });
	workStep(keep, passState({ goals: {} }), STRONG_PLAYER({ skills: { hacking: 500, strength: 312, defense: 310, dexterity: 320, agility: 330 } }));
	assert.equal(keep.called("singularity.gymWorkout").length, 0);
	const swap = bbWorld({ augs: [SIMULACRUM], current: running });
	workStep(swap, passState({ goals: {} }), STRONG_PLAYER({ skills: { hacking: 500, strength: 330, defense: 310, dexterity: 320, agility: 330 } }));
	assert.deepEqual(swap.called("singularity.gymWorkout").map((call) => call[1]), ["def"]);
});

test("a crime-faction invite's karma comes before faction work; with the Simulacrum Bladeburner keeps playing", () => {
	const crimeInvite = { applies: true, faction: "The Syndicate", missing: ["karma -10 / -90"], city: null, crime: "Homicide", rate: 60, chance: 0.9, gain: "karma", gym: 0 };
	const ns = bbWorld({ augs: [SIMULACRUM] });
	const result = workStep(ns, passState({ crimeInvite }), STRONG_PLAYER());
	assert.deepEqual(ns.called("singularity.commitCrime"), [["Homicide", false]]);
	assert.equal(ns.called("singularity.workForFaction").length, 0);
	assert.match(result.message, /\[crime-invite\] Homicide for The Syndicate/);
	// Done: the crime this step started is stopped and faction work takes over
	const after = bbWorld({ augs: [SIMULACRUM], current: { type: "CRIME", crimeType: "Homicide" } });
	workStep(after, passState({ crimeInvite: null, inviteCrime: true }), STRONG_PLAYER());
	assert.equal(after.called("singularity.stopAction").length, 1);
	assert.equal(after.called("singularity.workForFaction").length, 1);
});

test("inviteFlight: flies once only the city is missing, then stays; never while the travel step needs the player", () => {
	const inv = { faction: "Tetrads", missing: ["be in Chongqing"], city: "Chongqing", crime: null, gym: 0 };
	const ns = bbWorld();
	const flown = passState();
	assert.match(inviteFlight(ns, flown, STRONG_PLAYER(), inv, false), /flew to Chongqing/);
	assert.deepEqual(ns.called("singularity.travelToCity"), [["Chongqing"]]);
	assert.equal(flown.holdCity, true);
	const there = passState();
	assert.match(inviteFlight(bbWorld(), there, STRONG_PLAYER({ city: "Chongqing" }), { ...inv, city: null, missing: [] }, false), /waiting for the Tetrads invite/);
	assert.equal(there.holdCity, true);
	assert.equal(inviteFlight(bbWorld(), passState({ travelDone: false }), STRONG_PLAYER(), inv, false), null);
	assert.equal(inviteFlight(bbWorld(), passState(), STRONG_PLAYER(), { ...inv, crime: "Homicide" }, false), null, "crimes first");
});

// Invite rules as v3.0.0's getFactionInviteRequirements gives them
const TETRADS = [{ type: "someCondition", conditions: [{ type: "city", city: "Chongqing" }, { type: "city", city: "New Tokyo" }, { type: "city", city: "Ishima" }] },
	{ type: "skills", skills: { strength: 75, defense: 75, dexterity: 75, agility: 75 } }, { type: "karma", karma: -18 }];
const SPEAKERS = [{ type: "not", condition: { type: "employedBy", company: "CIA" } }, { type: "not", condition: { type: "employedBy", company: "NSA" } },
	{ type: "skills", skills: { hacking: 100 } }, { type: "skills", skills: { strength: 300, defense: 300, dexterity: 300, agility: 300 } },
	{ type: "numPeopleKilled", numPeopleKilled: 30 }, { type: "karma", karma: -45 }];

test("inviteNeeds: karma, kills, combat and the city are worked on; other skills and jobs block", () => {
	const fresh = inviteNeeds(TETRADS, { ...STRONG_PLAYER(), skills: { hacking: 500, strength: 50, defense: 80, dexterity: 80, agility: 80 } });
	assert.deepEqual([fresh.city, fresh.karma, fresh.gym, fresh.blocked.length], ["Chongqing", -18, 75, 0]);
	const inTokyo = inviteNeeds(TETRADS, STRONG_PLAYER({ city: "New Tokyo", karma: -20 }));
	assert.deepEqual(inTokyo.missing, [], "any of the three cities will do");
	const speakers = inviteNeeds(SPEAKERS, STRONG_PLAYER({ karma: -50, numPeopleKilled: 3 }));
	assert.deepEqual([speakers.kills, speakers.karma, speakers.gym], [30, null, 0]);
	assert.match(inviteNeeds(SPEAKERS, STRONG_PLAYER({ jobs: { CIA: "Field Agent" } })).blocked.join(), /not employed by CIA/);
	assert.match(inviteNeeds(SPEAKERS, STRONG_PLAYER({ skills: { hacking: 50, strength: 300, defense: 300, dexterity: 300, agility: 300 } })).blocked.join(), /hacking 50 \/ 100/);
});

test("pickInvite: the first reachable faction in the list order; blocked ones are listed", () => {
	const player = STRONG_PLAYER({ skills: { hacking: 50, strength: 300, defense: 300, dexterity: 300, agility: 300 } });
	const pick = pickInvite([{ faction: "Speakers for the Dead", needs: SPEAKERS }, { faction: "Tetrads", needs: TETRADS }], player);
	assert.equal(pick.faction, "Tetrads");
	assert.deepEqual(pick.blocked.map((entry) => entry.faction), ["Speakers for the Dead"]);
	assert.equal(pickInvite([], player).faction, null);
});
