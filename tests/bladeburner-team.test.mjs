// Bladeburner team and Black Op gate: the pure maths in bladeburner/team.js (team bonus, casualties, hospital bill, best team,
// member value, chance trend, the attempt decision) and how bb-pass.js and bb-manage.js use it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { loadConfig } from "/utils/config.js";
import { BB_PORT } from "/bladeburner/state.js";
import { main as manage } from "/bladeburner/bb-manage.js";
import { main as play } from "/bladeburner/bb-pass.js";
import {
	teamBonus, expectedLosses, failureBill, completionCost, bestTeam, memberValue, recruitSeconds, nextTrend, chanceGrowth,
	blackOpDecision, blackOpStakes, followingRank,
} from "/bladeburner/team.js";

const close = (actual, expected, relative = 1e-6) => assert.ok(Math.abs(actual - expected) <= Math.abs(expected) * relative, `${actual} vs ${expected}`);

// ---- the game's numbers
test("game: teamBonus is (members + 1) ^ 0.05", () => {
	assert.equal(teamBonus(0), 1);
	close(teamBonus(20), Math.pow(21, 0.05));
	close(teamBonus(100), 1.2594, 1e-3);
	assert.equal(teamBonus(-3), 1);
});

test("game: expectedLosses: 1..ceil(team/2) on a win, 1..team on a loss, none without a team", () => {
	assert.equal(expectedLosses(0, true), 0);
	assert.equal(expectedLosses(0, false), 0);
	assert.equal(expectedLosses(1, true), 1, "ceil(1/2) = 1: the one member is the minimum");
	assert.equal(expectedLosses(1, false), 1);
	assert.equal(expectedLosses(10, true), 3, "1..5");
	assert.equal(expectedLosses(10, false), 5.5, "1..10");
});

test("game: failureBill: nothing when the player survives; (HP missing) x $100k, at most 10 % of the cash", () => {
	const damage = 100 * (Math.pow(2000, 0.28) + 2000 / 650); // Operation Typhoon
	assert.equal(failureBill("Operation Typhoon", { current: damage + 1, max: 5000 }, 1e12), 0);
	close(failureBill("Operation Typhoon", { current: 100, max: 500 }, 1e15), (500 - (100 - damage)) * 100e3);
	assert.equal(failureBill("Operation Typhoon", { current: 100, max: 500 }, 1e9), 1e8, "10 % of the cash caps it");
	assert.equal(failureBill("Operation Typhoon", undefined, 1e9), 0, "unknown HP");
	assert.equal(failureBill("Nope", { current: 1, max: 10 }, 1e9), 0);
});

test("stakes and the chain: required rank, rank loss, the rank the next one needs", () => {
	assert.deepEqual(blackOpStakes("Operation Typhoon"), { name: "Operation Typhoon", rank: 2500, rankLoss: 10, hpLoss: 100, index: 0 });
	assert.equal(followingRank("Operation Typhoon"), 5000);
	assert.equal(followingRank("Operation Vindictus"), 400e3);
	assert.equal(followingRank("Operation Daedalus"), null, "the last one");
	assert.equal(followingRank("Nope"), null);
});

test("recruitSeconds: time over chance; Infinity when it can't succeed", () => {
	assert.equal(recruitSeconds(100, 0.5), 200);
	assert.equal(recruitSeconds(100, 2), 100);
	assert.equal(recruitSeconds(100, 0), Infinity);
});

// ---- the team
const pricing = (overrides = {}) => ({ chance0: 0.3, secs: 300, timeValue: 1, memberSecs: 200, failSecs: 50, ...overrides });

test("completionCost: the win plus (1 - p) / p failures; Infinity at chance 0", () => {
	close(completionCost(pricing(), 0), 300 + (350 * 0.7) / 0.3);
	assert.equal(completionCost(pricing({ chance0: 0 }), 0), Infinity);
	assert.equal(completionCost(pricing({ chance0: 1 }), 0), 300, "a sure thing costs its time");
});

test("bestTeam: the whole team goes when members are free to replace; none when they cost minutes each", () => {
	assert.deepEqual(bestTeam(pricing({ memberSecs: 0 }), 30).members, 30);
	assert.equal(bestTeam(pricing({ memberSecs: 200 }), 30).members, 0, "x1.16 chance doesn't pay for ~8 dead members a failure");
	assert.equal(bestTeam(pricing({ memberSecs: 0 }), 0).members, 0, "no team, nothing to send");
	assert.equal(bestTeam(pricing({ memberSecs: Infinity }), 10).members, 0, "irreplaceable members stay home");
});

test("memberValue: what one more member saves; 0 when the team isn't wanted", () => {
	assert.ok(memberValue(pricing({ memberSecs: 0 }), 10) > 0);
	assert.equal(memberValue(pricing({ memberSecs: 200 }), 10), 0);
	assert.equal(memberValue(pricing({ chance0: 1, memberSecs: 0 }), 10), 0, "a capped chance gains nothing");
});

// ---- the trend
test("nextTrend keeps one sample per 5 minutes for 2 hours and starts over on a new Black Op", () => {
	let trend = nextTrend(undefined, "Operation Zero", 0.1, 0);
	trend = nextTrend(trend, "Operation Zero", 0.11, 60_000);
	assert.equal(trend.samples.length, 1, "too soon");
	trend = nextTrend(trend, "Operation Zero", 0.12, 300_000);
	assert.equal(trend.samples.length, 2);
	trend = nextTrend(trend, "Operation Zero", 0.2, 3 * 3600_000);
	assert.equal(trend.samples.length, 1, "older than 2 hours dropped");
	assert.deepEqual(nextTrend(trend, "Operation X", 0.05, 3 * 3600_000 + 1).samples, [{ t: 3 * 3600_000 + 1, p: 0.05 }]);
});

test("chanceGrowth: NaN until half an hour of samples, then the least-squares slope per second", () => {
	const samples = (count, every, slope) => Array.from({ length: count }, (_, index) => ({ t: index * every, p: 0.2 + slope * index * every / 1000 }));
	assert.ok(Number.isNaN(chanceGrowth({ samples: samples(3, 900_000, 1e-5) })), "3 samples");
	assert.ok(Number.isNaN(chanceGrowth({ samples: samples(5, 300_000, 1e-5) })), "20 minutes");
	close(chanceGrowth({ samples: samples(7, 300_000, 1e-5) }), 1e-5);
	assert.ok(Number.isNaN(chanceGrowth(undefined)));
});

// ---- the decision
const decide = (overrides = {}) => blackOpDecision({
	name: "Operation Zero", chance: 0.4, assigned: 0, size: 0, gain: 60, secs: 300, rank: 5000, rankRate: 0.5,
	recruitSecs: 100, timeValue: 1, bill: 0, income: 1e6, growth: 1e-6, safeChance: 0.8, ...overrides,
});

test("blackOpDecision: safe at the old line, as before", () => {
	const decision = decide({ chance: 0.85 });
	assert.equal(decision.attempt, true);
	assert.equal(decision.reason, "safe");
});

test("blackOpDecision: while the counts are used up the time is nearly free, so a 40 % Black Op pays for itself", () => {
	const decision = decide({ timeValue: 0.05 });
	assert.equal(decision.attempt, true);
	assert.equal(decision.reason, "pays");
	assert.ok(decision.cost <= decision.reward);
});

test("blackOpDecision: with rank for the next one still far off, the time goes to rank and the chance grows", () => {
	const decision = decide({ rank: 5000, rankRate: 0.5 }); // the next needs 7,500: about 1.4 hours away
	assert.equal(decision.attempt, false);
	assert.equal(decision.reason, "rank");
	assert.match(decision.why, /rank for the next Black Op is still the limit/);
});

test("blackOpDecision: once it holds the BitNode back, it goes unless the chance grows fast enough to wait for", () => {
	const chain = { rank: 7400 }; // the next one's 7,500 is reached within one attempt
	assert.equal(decide({ ...chain, growth: 1e-6 }).attempt, true, "slow growth: waiting costs more than a failure");
	assert.equal(decide({ ...chain, growth: 1e-6 }).reason, "chain");
	const growing = decide({ ...chain, chance: 0.05, growth: 1e-3 });
	assert.equal(growing.attempt, false, "5 % and climbing 360 points an hour: wait");
	assert.equal(growing.reason, "growing");
	assert.equal(decide({ ...chain, growth: NaN }).reason, "measuring", "growth not known yet: wait for the samples");
	assert.equal(decide({ ...chain, growth: -1e-5 }).attempt, true, "falling chance: go now");
	assert.equal(decide({ name: "Operation Daedalus", rank: 400e3, gain: 1000, chance: 0.3, growth: 1e-7, rankRate: 10 }).reason, "chain", "the last one is always on the chain");
});

test("blackOpDecision: the hospital bill and dead members make a failure dearer", () => {
	const cheap = decide({ rank: 7400 });
	const billed = decide({ rank: 7400, bill: 1e9 });
	assert.ok(billed.cost > cheap.cost);
	const manned = decide({ rank: 7400, assigned: 20, size: 20, chance: 0.4 * teamBonus(20) });
	close(manned.chance0, 0.4, 1e-9);
	assert.ok(manned.chance > cheap.chance);
	assert.equal(manned.team, 0, "at 100 s a recruit, 20 members cost more than their chance gain");
	assert.equal(decide({ rank: 7400, assigned: 0, size: 20, timeValue: 0 }).team, 20, "free time: the whole team goes");
	assert.equal(decide({ rank: 7400, assigned: 0, size: 20, timeValue: 0 }).all, true);
});

// ---- bb-pass.js
const SKILLS = { hacking: 100, strength: 200, defense: 200, dexterity: 200, agility: 200, charisma: 50, intelligence: 1 };

function passWorld({ current = null, counts = {}, chances = {}, gains = {}, seconds = {}, post = {}, rank = 3000, files = {}, nextOp = { name: "Operation Typhoon", rank: 2500 } } = {}) {
	return fakeNs({
		files,
		ports: { [BB_PORT]: { state: "run", stateTime: Date.now(), ...post } },
		overrides: {
			getScriptName: () => "bladeburner/bb-pass.js",
			getPlayer: () => ({ skills: SKILLS, money: 1e9, hp: { current: 1e6, max: 1e6 } }),
			getTotalScriptIncome: () => [1e6, 0],
			bladeburner: {
				inBladeburner: () => true, getStamina: () => [100, 100], getCurrentAction: () => current, getRank: () => rank,
				getNextBlackOp: () => nextOp,
				getActionEstimatedSuccessChance: (type, name) => chances[name] ?? [0.9, 0.95],
				getActionRankGain: (type, name) => gains[name] ?? 1, getActionTime: (type, name) => (seconds[name] ?? 10) * 1000,
				getActionCurrentLevel: () => 1, getActionMaxLevel: () => 1, getActionCountRemaining: (type, name) => counts[name] ?? 5,
				getCityChaos: () => 0, getCityEstimatedPopulation: () => 1e9, getCity: () => "Sector-12",
				startAction: () => true, switchCity: () => true,
			},
		},
	});
}
const lastStart = (ns) => ns.called("bladeburner.startAction").at(-1);
const ALL_OUT = { Tracking: 0, "Bounty Hunter": 0, Retirement: 0, Investigation: 0, "Undercover Operation": 0, "Sting Operation": 0, Raid: 0, "Stealth Retirement Operation": 0, Assassination: 0 };
// Samples every 5 minutes over the last half hour (bb-pass.js drops samples from before a gap of over 10 minutes)
const hourAgo = (rank) => [30, 25, 20, 15, 10, 5].map((m) => ({ t: Date.now() - m * 60_000, rank }));

test("bb-pass: with the counts used up, a 50 % Black Op pays for itself and is attempted; the old gate waits for 80 %", async () => {
	const setup = {
		counts: ALL_OUT, chances: { "Operation Typhoon": [0.5, 0.5], Recruitment: [1, 1] }, gains: { "Operation Typhoon": 50 }, seconds: { "Operation Typhoon": 300 },
		post: { freeShare: 0.95, rank: hourAgo(2500) },
	};
	const ns = passWorld(setup);
	await play(ns);
	assert.deepEqual(lastStart(ns), ["Black Operations", "Operation Typhoon"]);
	assert.match(ns.portJson(BB_PORT).lines.join("\n"), /started Operation Typhoon: pays/);
	const off = passWorld({ ...setup, files: { "data/config.json": JSON.stringify({ bladeburner: { blackOpGate: false, team: false } }) } });
	await play(off);
	assert.notDeepEqual(lastStart(off), ["Black Operations", "Operation Typhoon"]);
	assert.match(off.portJson(BB_PORT).lines.join("\n"), /waits: only 50% chance \(need 80%\)/);
	assert.equal(loadConfig(fakeNs({})).bladeburner.blackOpGate, true, "on by default");
	assert.equal(loadConfig(fakeNs({})).bladeburner.team, true, "on by default");
});

test("bb-pass: while the safe counts are used up it recruits; with counts left it plays them instead", async () => {
	const setup = {
		rank: 1000, chances: { "Operation Typhoon": [0.2, 0.2], Recruitment: [1, 1] }, seconds: { Recruitment: 10, "Operation Typhoon": 300 }, gains: { "Operation Typhoon": 50 },
		post: { freeShare: 0.9, rank: hourAgo(500), team: { size: 5, name: "Operation Typhoon", assigned: 5 } },
	};
	const free = passWorld({ ...setup, counts: ALL_OUT });
	await play(free);
	assert.deepEqual(lastStart(free), ["General", "Recruitment"]);
	const post = free.portJson(BB_PORT);
	assert.equal(post.teamPlan.name, "Operation Typhoon");
	assert.equal(post.teamPlan.all, true, "members are nearly free: all of them go");
	assert.ok(post.freeShare > 0.9, "the free share moves up");
	assert.equal(post.blackOpTrend.samples.length, 1);
	const busy = passWorld(setup);
	await play(busy);
	assert.notDeepEqual(lastStart(busy), ["General", "Recruitment"], "counts are there: rank comes first");
	const off = passWorld({ ...setup, counts: ALL_OUT, files: { "data/config.json": JSON.stringify({ bladeburner: { team: false } }) } });
	await play(off);
	assert.ok(!off.called("bladeburner.startAction").some(([, name]) => name === "Recruitment"), "bladeburner.team: false never recruits");
	assert.equal(off.portJson(BB_PORT).teamPlan, undefined);
});

test("bb-pass: a Black Op under way is kept even when the gate would wait now", async () => {
	const ns = passWorld({
		current: { type: "Black Operations", name: "Operation Typhoon" }, rank: 3000,
		chances: { "Operation Typhoon": [0.3, 0.3] }, gains: { "Operation Typhoon": 50 }, seconds: { "Operation Typhoon": 300 },
	});
	await play(ns);
	assert.equal(ns.called("bladeburner.startAction").length, 0, "nothing else started");
	assert.match(ns.portJson(BB_PORT).lines.join("\n"), /keeping Operation Typhoon: a Black Op under way is never abandoned/);
});

// ---- bb-manage.js
function manageWorld({ post = {}, size = 12, assigned = 0, files = {} } = {}) {
	const ns = fakeNs({
		files,
		ports: { [BB_PORT]: post },
		overrides: {
			getScriptName: () => "bladeburner/bb-manage.js",
			getResetInfo: () => ({ currentNode: 6, ownedSF: new Map([[6, 1]]), ownedAugs: new Map(), lastAugReset: Date.now() - 1e7, lastNodeReset: 1 }),
			getPlayer: () => ({ skills: { hacking: 100, strength: 200, defense: 200, dexterity: 200, agility: 200, charisma: 50, intelligence: 1 }, money: 1e9, factions: ["Bladeburners"] }),
			getTotalScriptIncome: () => [1, 0],
			bladeburner: {
				inBladeburner: () => true, getCurrentAction: () => null, stopBladeburnerAction: () => {}, getSkillPoints: () => 0,
				getSkillUpgradeCost: () => Infinity, getSkillLevel: () => 0, upgradeSkill: () => false,
				getTeamSize: (type) => (type ? assigned : size),
				setTeamSize: (type, name, want) => { assigned = Math.min(want, size); return assigned; },
			},
		},
	});
	return ns;
}
const blackOpPost = (teamPlan) => ({ actions: { rows: [], blackOp: { name: "Operation Zero", rank: 5000, chance: 0.3 } }, ...(teamPlan ? { teamPlan } : {}) });

test("bb-manage: puts the planned team on the next Black Op and posts the team", async () => {
	const ns = manageWorld({ post: blackOpPost({ name: "Operation Zero", members: 3, all: true, time: Date.now() }) });
	await manage(ns);
	assert.deepEqual(ns.called("bladeburner.setTeamSize"), [["Black Operations", "Operation Zero", 12]], "all = every member, whatever the plan counted");
	assert.deepEqual({ ...ns.portJson(BB_PORT).team, time: 0 }, { size: 12, name: "Operation Zero", assigned: 12, time: 0 });
	const some = manageWorld({ post: blackOpPost({ name: "Operation Zero", members: 3, all: false, time: Date.now() }) });
	await manage(some);
	assert.deepEqual(some.called("bladeburner.setTeamSize"), [["Black Operations", "Operation Zero", 3]]);
	const same = manageWorld({ assigned: 3, post: blackOpPost({ name: "Operation Zero", members: 3, all: false, time: Date.now() }) });
	await manage(same);
	assert.equal(same.called("bladeburner.setTeamSize").length, 0, "already right: nothing set");
});

test("bb-manage: an old plan, a plan for another Black Op, or bladeburner.team: false changes nothing", async () => {
	const old = manageWorld({ post: blackOpPost({ name: "Operation Zero", members: 3, all: false, time: Date.now() - 3600_000 }) });
	await manage(old);
	assert.equal(old.called("bladeburner.setTeamSize").length, 0);
	assert.equal(old.portJson(BB_PORT).team.size, 12, "the team size is still posted for bb-pass.js");
	const other = manageWorld({ post: blackOpPost({ name: "Operation X", members: 3, all: false, time: Date.now() }) });
	await manage(other);
	assert.equal(other.called("bladeburner.setTeamSize").length, 0);
	const off = manageWorld({ files: { "data/config.json": JSON.stringify({ bladeburner: { team: false } }) }, post: blackOpPost({ name: "Operation Zero", members: 3, all: true, time: Date.now() }) });
	await manage(off);
	assert.equal(off.called("bladeburner.setTeamSize").length, 0);
	assert.equal(off.called("bladeburner.getTeamSize").length, 0);
});
