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
