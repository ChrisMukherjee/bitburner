// Bladeburner measurement and Black Op awareness: the ceiling model (bladeburner/ideal.js), the Black Op term in the skill
// choice (bladeburner/picks.js), and the efficiency figures bb-pass.js posts on port 36.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { loadConfig } from "/utils/config.js";
import { BB_PORT } from "/bladeburner/state.js";
import { main as manage } from "/bladeburner/bb-manage.js";
import { main as play } from "/bladeburner/bb-pass.js";
import { skillValues, pickSkill, blackOpWeight, SKILL_NAMES, BLACKOP_CHANCE } from "/bladeburner/picks.js";
import {
	staminaLoss, staminaRegen, difficultyAt, countRate, solve, idealRankRate, measuredRate, hoursToRank, nextShare,
} from "/bladeburner/ideal.js";

const close = (actual, expected, relative = 1e-3) => assert.ok(Math.abs(actual - expected) <= Math.abs(expected) * relative, `${actual} vs ${expected}`);

// ---- the game's formulas
test("staminaLoss and staminaRegen follow the game's constants", () => {
	close(staminaLoss(125), 0.285 * (Math.pow(125, 0.28) + 125 / 650));
	close(staminaLoss(125), 1.156, 2e-3);
	assert.ok(staminaLoss(1500) > staminaLoss(125), "harder actions cost more");
	assert.ok(staminaLoss(1500) / 1500 < staminaLoss(125) / 125, "but far less per second of difficulty: long actions are easy on stamina");
	close(staminaRegen(500, 1000), (0.0085 + 500 / 70000) * Math.pow(1000, 0.17));
	close(staminaRegen(500, 1000, 2), 2 * staminaRegen(500, 1000));
	assert.equal(staminaRegen(500, -5), 0);
});

test("difficultyAt and countRate read the action table; unknown actions are NaN", () => {
	assert.equal(difficultyAt("Assassination", 1), 1500);
	close(difficultyAt("Assassination", 11), 1500 * Math.pow(1.06, 10));
	close(difficultyAt("Raid"), 800);
	close(countRate("Raid"), 2.1 / 480);
	assert.ok(Number.isNaN(difficultyAt("Operation Typhoon")));
	assert.ok(Number.isNaN(countRate("Nope")));
});

// ---- the program
const REST = (max) => ({ name: "rest", value: 0, seconds: 60, loss: -0.01 * max, rate: 1 / 60 });

test("solve: with room on every side the supply of counts is the limit", () => {
	const result = solve([{ name: "a", value: 2, seconds: 10, loss: 0.1, rate: 0.01 }, REST(100)], 1);
	close(result.perSecond, 0.02);
	assert.equal(result.limiter, "count");
});

test("solve: a long action is limited by the clock, not stamina or counts", () => {
	const result = solve([{ name: "a", value: 5, seconds: 100, loss: 0.1, rate: 1 }, REST(100)], 1);
	close(result.perSecond, 0.05);
	assert.equal(result.limiter, "time");
});

test("solve: a stamina-bound action matches the closed form (r + h) / (loss + h x seconds)", () => {
	const max = 100;
	const regen = 0.01;
	const rest = 0.01 * max / 60;
	const result = solve([{ name: "a", value: 0.5, seconds: 10, loss: 1, rate: 1 }, REST(max)], regen);
	close(result.perSecond, 0.5 * (regen + rest) / (1 + rest * 10), 1e-3);
	assert.equal(result.limiter, "stamina");
});

test("solve: fills the clock with the better action first, then the next", () => {
	const items = [{ name: "a", value: 10, seconds: 10, loss: 0, rate: 0.05 }, { name: "b", value: 4, seconds: 10, loss: 0, rate: 1 }];
	close(solve(items, 1e9).perSecond, 0.05 * 10 + (1 - 0.5) / 10 * 4, 1e-3);
});

test("solve: junk items and no items give nothing", () => {
	assert.equal(solve([], 1).perSecond, 0);
	assert.equal(solve([{ name: "a", value: NaN, seconds: 1, loss: 0, rate: 1 }], 1).limiter, null);
	assert.equal(solve([{ name: "a", value: 1, seconds: 1, loss: 0, rate: 1 }], -1).perSecond, 0);
});

test("idealRankRate: late-game Contracts and Operations are count-bound, ranked by what each count is worth", () => {
	const rows = [
		{ name: "Raid", chance: 1, gain: 55, secs: 20, level: 1 },
		{ name: "Assassination", chance: 1, gain: 44, secs: 30, level: 1 },
		{ name: "Tracking", chance: 1, gain: 0.3, secs: 3, level: 1 },
		{ name: "Operation Typhoon", chance: 1, gain: 50, secs: 30 },
	];
	const ideal = idealRankRate(rows, 400, staminaRegen(400, 2000));
	assert.equal(ideal.limiter, "count");
	assert.equal(ideal.byAction.length, 3, "an action the table doesn't know is skipped");
	assert.equal(ideal.byAction[0].name, "Raid");
	const countBound = ideal.byAction.reduce((sum, entry) => sum + entry.perHour, 0);
	close(ideal.perHour, countBound, 1e-2);
	close(ideal.byAction[0].perHour, 55 * (2.1 / 480) * 3600, 1e-6);
});

test("idealRankRate: a lower chance lowers the ceiling, and nothing known gives 0", () => {
	const rows = (chance) => [{ name: "Raid", chance, gain: 55, secs: 20, level: 1 }];
	close(idealRankRate(rows(0.5), 400, 0.05).perHour, idealRankRate(rows(1), 400, 0.05).perHour / 2, 1e-2);
	assert.equal(idealRankRate([], 400, 0.05).perHour, 0);
	assert.equal(idealRankRate(rows(1), 0, 0.05).perHour, 0);
});

test("measuredRate, hoursToRank and nextShare", () => {
	const t = Date.now();
	close(measuredRate([{ t, rank: 100 }, { t: t + 1800_000, rank: 400 }]), 600);
	assert.ok(Number.isNaN(measuredRate([{ t, rank: 1 }, { t: t + 60_000, rank: 5 }])), "under two minutes");
	assert.ok(Number.isNaN(measuredRate([])));
	close(hoursToRank(100, 400_100, 1000), 400);
	assert.equal(hoursToRank(500_000, 400_000, 10), 0);
	assert.ok(Number.isNaN(hoursToRank(1, 2, 0)));
	assert.ok(nextShare(0, true) > 0 && nextShare(0, true) < 0.03);
	assert.equal(nextShare(undefined, false), 0);
});

// ---- Black Ops in the skill choice
const SK = { hacking: 100, strength: 300, defense: 300, dexterity: 300, agility: 300, charisma: 50, intelligence: 1 };
const capped = (blackOp, rank) => ({
	lv: SK, city: "Sector-12", rank,
	rows: [{ type: "Contracts", name: "Tracking", chance: 1, lo: 1, hi: 1, gain: 1, secs: 10, level: 1, maxLevel: 1, count: 5 }],
	cities: [{ name: "Sector-12", pop: 1e9, chaos: 0 }], ...(blackOp ? { blackOp } : {}),
});

test("blackOpWeight: 0 when safe or unknown, grows with the rank held, 1 once the rank is there", () => {
	assert.equal(blackOpWeight(undefined, 100), 0);
	assert.equal(blackOpWeight({ chance: BLACKOP_CHANCE }, 100), 0);
	assert.equal(blackOpWeight({ chance: 0.1, rank: 2500 }, 1250), 0.5);
	assert.equal(blackOpWeight({ chance: 0.1, rank: 2500 }, 9000), 1);
	assert.equal(blackOpWeight({ chance: 0.1, rank: 2500 }, 0), 0);
	assert.equal(blackOpWeight({ chance: 0.1 }, 10), 1, "no rank requirement known: treat it as reachable");
});

test("regression: with every Contract capped at 100 % the chance skills still count while a Black Op is short of the safe chance", () => {
	const old = skillValues(capped(null, 5000), {}, 0.5);
	assert.equal(old["Blade's Intuition"], 0, "before: nothing capped, nothing to buy for the Black Op");
	const blocked = skillValues(capped({ name: "Operation Typhoon", rank: 2500, chance: 0.2 }, 5000), {}, 0.5);
	assert.ok(blocked["Blade's Intuition"] > 0 && blocked["Digital Observer"] > 0 && blocked["Short-Circuit"] > 0);
	assert.equal(blocked["Overclock"], 0, "a shorter action doesn't open the Black Op");
	assert.equal(blocked["Cyber's Edge"], 0);
	assert.equal(blocked["Tracer"], 0, "Contract skills don't apply to a Black Op");
	assert.equal(blocked["Cloak"], 0, "Typhoon is a kill op, not stealth");
	const stealth = skillValues(capped({ name: "Operation Zero", rank: 5000, chance: 0.2 }, 9000), {}, 0.5);
	assert.ok(stealth["Cloak"] > 0 && stealth["Short-Circuit"] === 0, "Operation Zero is stealth");
	assert.ok(blocked["Reaper"] > 0 && blocked["Evasive System"] > 0, "combat stats feed the Black Op too");
	assert.equal(pickSkill(Object.fromEntries(SKILL_NAMES.map((name) => [name, 3])), blocked).name !== "Overclock", true);
});

test("skillValues: a safe Black Op, or one far above the rank held, leaves the Contract valuation alone", () => {
	const base = skillValues(capped(null, 5000), {}, 0.5);
	assert.deepEqual(skillValues(capped({ name: "Operation Typhoon", rank: 2500, chance: 0.9 }, 5000), {}, 0.5), base);
	const far = skillValues(capped({ name: "Operation Typhoon", rank: 2e6, chance: 0.2 }, 10), {}, 0.5);
	close(far["Overclock"], base["Overclock"], 1e-3);
});

test("bb-manage: bladeburner.blackOpSkills turns the Black Op term off", async () => {
	const costs = { Overclock: Infinity, "Blade's Intuition": 3, "Digital Observer": 3, Tracer: 3, Cloak: 3, "Short-Circuit": 3, Reaper: 3, "Evasive System": 3, "Cyber's Edge": 3, Hyperdrive: 3 };
	const post = { actions: capped({ name: "Operation Typhoon", rank: 2500, chance: 0.2 }, 5000), restShare: 0 };
	const make = (files) => {
		const bought = [];
		const ns = fakeNs({
			files, ports: { [BB_PORT]: post },
			overrides: {
				getScriptName: () => "bladeburner/bb-manage.js",
				getResetInfo: () => ({ currentNode: 6, ownedSF: new Map([[6, 1]]), ownedAugs: new Map(), lastAugReset: Date.now() - 1e7, lastNodeReset: 1 }),
				getPlayer: () => ({ skills: SK, money: 1e9 }),
				getTotalScriptIncome: () => [1, 0],
				bladeburner: {
					inBladeburner: () => true, getCurrentAction: () => null, stopBladeburnerAction: () => {}, getSkillPoints: () => 3,
					getSkillUpgradeCost: (name) => costs[name] ?? Infinity, getSkillLevel: () => 0,
					upgradeSkill: (name) => { bought.push(name); return true; },
					getTeamSize: () => 0, setTeamSize: () => 0,
				},
			},
		});
		return { ns, bought };
	};
	const on = make({});
	await manage(on.ns);
	assert.equal(on.bought.length, 1, "points go to a chance skill");
	assert.notEqual(on.bought[0], "Hyperdrive");
	const off = make({ "data/config.json": JSON.stringify({ bladeburner: { blackOpSkills: false } }) });
	await manage(off.ns);
	assert.ok(!["Blade's Intuition", "Digital Observer", "Short-Circuit"].includes(off.bought[0]), `without the Black Op term the capped Contracts give them nothing (bought ${off.bought})`);
	assert.equal(loadConfig(fakeNs({})).bladeburner.blackOpSkills, true, "on by default");
	assert.deepEqual(on.ns.portJson(BB_PORT).skillLevels, { Reaper: 0, "Evasive System": 0, "Cyber's Edge": 0 }, "posts the levels bb-pass.js needs for its stamina model");
});

// ---- what bb-pass.js posts
function passWorld({ current = null, counts = {}, chances = {}, gains = {}, seconds = {}, post = {}, rank = 50, stamina = [100, 100] } = {}) {
	const cities = [{ name: "Sector-12", pop: 1e9, chaos: 0 }];
	const ns = fakeNs({
		ports: { [BB_PORT]: { state: "run", stateTime: Date.now(), ...post } },
		overrides: {
			getScriptName: () => "bladeburner/bb-pass.js",
			getPlayer: () => ({ skills: { hacking: 100, strength: 200, defense: 200, dexterity: 200, agility: 200, charisma: 50, intelligence: 1 } }),
			getTotalScriptIncome: () => [0, 0],
			bladeburner: {
				inBladeburner: () => true, getStamina: () => stamina, getCurrentAction: () => current, getRank: () => rank,
				getNextBlackOp: () => ({ name: "Operation Typhoon", rank: 2500 }),
				getActionEstimatedSuccessChance: (type, name) => chances[name] ?? [0.9, 0.95],
				getActionRankGain: (type, name) => gains[name] ?? 1, getActionTime: (type, name) => (seconds[name] ?? 10) * 1000,
				getActionCurrentLevel: () => 1, getActionMaxLevel: () => 1, getActionCountRemaining: (type, name) => counts[name] ?? 5,
				getCityChaos: () => cities[0].chaos, getCityEstimatedPopulation: () => cities[0].pop, getCity: () => "Sector-12",
				startAction: () => true, switchCity: () => true,
			},
		},
	});
	return ns;
}

test("bb-pass: posts the efficiency report, the Black Op reading and the hourly log", async () => {
	const t = Date.now();
	const ns = passWorld({ post: { rank: [30, 25, 20, 15, 10, 5].map((m) => ({ t: t - m * 60_000, rank: 0 })), skillLevels: { "Cyber's Edge": 10 } }, rank: 300, gains: { Raid: 55 }, chances: { Raid: [0.9, 0.95], "Operation Typhoon": [0.2, 0.3] } });
	await play(ns);
	const post = ns.portJson(BB_PORT);
	assert.equal(post.perf.limiter, "count");
	assert.ok(post.perf.ceiling > 0 && post.perf.perHour > 500 && post.perf.perHour < 700, `measured ${post.perf.perHour}`);
	assert.ok(post.perf.efficiency > 0 && post.perf.efficiency < 1);
	assert.ok(post.perf.etaHours > 0);
	assert.match(post.lines.join("\n"), /efficiency: \d+ rank\/h of at most \d+ \(\d+%\), limited by count; idle \d+%, stamina under 50% \d+%; \d+ safe counts banked; rank 400k in/);
	assert.equal(post.actions.blackOp.name, "Operation Typhoon");
	assert.equal(post.actions.blackOp.chance, 0.2, "the pessimistic end");
	assert.equal(post.actions.blackOp.rank, 2500);
	assert.equal(post.actions.rank, 300);
	assert.equal(post.perfLog.length, 1);
	const again = ns.portJson(BB_PORT);
	again.perf.t = 0; // an old pass: the log gets a second entry only after an hour
	await play(ns);
	assert.equal(ns.portJson(BB_PORT).perfLog.length, 1, "one entry per hour");
});

test("bb-pass: an idle player (the game stopped the action) raises the idle share; a busy one does not", async () => {
	const idle = passWorld({ current: null });
	await play(idle);
	assert.ok((idle.portJson(BB_PORT).idleShare) > 0);
	const busy = passWorld({ current: { type: "Contracts", name: "Tracking" } });
	await play(busy);
	assert.equal(busy.portJson(BB_PORT).idleShare, 0);
});

test("bb-pass: stamina under half is counted, and a rest keeps the earlier efficiency line", async () => {
	const tired = passWorld({ stamina: [30, 100], post: { perf: { t: Date.now(), line: "efficiency: earlier" } } });
	await play(tired);
	assert.ok(tired.portJson(BB_PORT).penaltyShare > 0);
	assert.match(tired.portJson(BB_PORT).lines.join("\n"), /efficiency: earlier/, "resting skips the readings; the last figures stay for ten minutes");
});

test("regression: an action with no count left is not planned on; the next best is played", async () => {
	const ns = passWorld({ counts: { Raid: 0 }, gains: { Raid: 55, Tracking: 0.3 }, seconds: { Raid: 10, Tracking: 10 } });
	await play(ns);
	assert.notEqual(ns.called("bladeburner.startAction").at(-1)[1], "Raid", "Raid has none left");
	const stocked = passWorld({ counts: { Raid: 3 }, gains: { Raid: 55, Tracking: 0.3 }, seconds: { Raid: 10, Tracking: 10 } });
	await play(stocked);
	assert.deepEqual(stocked.called("bladeburner.startAction").at(-1), ["Operations", "Raid"]);
});
