// A twelve-member combat gang played for simulated hours with the game's own formulas (the real task table), comparing the
// growth rules (gang.growth.enabled) with the legacy ones. A sanity check on the planner's dynamics: it must not thrash
// (ascending every few minutes), must keep a third of the gang earning and must out-earn the legacy rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { loadConfig } from "/utils/config.js";
import { assignTasks, ascend } from "/gang/gang-manager.js";
import { skillLevel, ascensionMult, ascensionPoints, expRate, moneyRate, respectRate } from "/gang/formulas.js";

const mk = (name, base, weights, extra = {}) => ({ name, isHacking: false, isCombat: true, baseRespect: 0, baseWanted: 0, baseMoney: 0, difficulty: 1,
	hackWeight: 0, strWeight: 0, defWeight: 0, dexWeight: 0, agiWeight: 0, chaWeight: 0, territory: { money: 1, respect: 1, wanted: 1 }, ...base, ...weights, ...extra });
const T = [
	mk("Unassigned", {}, { hackWeight: 100 }),
	mk("Mug People", { baseRespect: 0.00005, baseWanted: 0.00005, baseMoney: 3.6, difficulty: 1 }, { strWeight: 25, defWeight: 25, dexWeight: 25, agiWeight: 10, chaWeight: 15 }),
	mk("Deal Drugs", { baseRespect: 0.00006, baseWanted: 0.002, baseMoney: 15, difficulty: 3.5 }, { agiWeight: 20, dexWeight: 20, chaWeight: 60 }, { territory: { money: 1.2, respect: 1, wanted: 1.15 } }),
	mk("Strongarm Civilians", { baseRespect: 0.00004, baseWanted: 0.02, baseMoney: 7.5, difficulty: 5 }, { hackWeight: 10, strWeight: 25, defWeight: 25, dexWeight: 20, agiWeight: 10, chaWeight: 10 }, { territory: { money: 1.6, respect: 1.1, wanted: 1.5 } }),
	mk("Run a Con", { baseRespect: 0.00012, baseWanted: 0.05, baseMoney: 45, difficulty: 14 }, { strWeight: 5, defWeight: 5, agiWeight: 25, dexWeight: 25, chaWeight: 40 }),
	mk("Armed Robbery", { baseRespect: 0.00014, baseWanted: 0.1, baseMoney: 114, difficulty: 20 }, { hackWeight: 20, strWeight: 15, defWeight: 15, agiWeight: 10, dexWeight: 20, chaWeight: 20 }),
	mk("Traffick Illegal Arms", { baseRespect: 0.0002, baseWanted: 0.24, baseMoney: 174, difficulty: 32 }, { hackWeight: 15, strWeight: 20, defWeight: 20, dexWeight: 20, chaWeight: 25 }, { territory: { money: 1.4, respect: 1.3, wanted: 1.25 } }),
	mk("Threaten & Blackmail", { baseRespect: 0.0002, baseWanted: 0.125, baseMoney: 72, difficulty: 28 }, { hackWeight: 25, strWeight: 25, dexWeight: 25, chaWeight: 25 }),
	mk("Human Trafficking", { baseRespect: 0.004, baseWanted: 1.25, baseMoney: 360, difficulty: 36 }, { hackWeight: 30, strWeight: 5, defWeight: 5, dexWeight: 30, chaWeight: 30 }, { territory: { money: 1.5, respect: 1.5, wanted: 1.6 } }),
	mk("Terrorism", { baseRespect: 0.01, baseWanted: 6, baseMoney: 0, difficulty: 36 }, { hackWeight: 20, strWeight: 20, defWeight: 20, dexWeight: 20, chaWeight: 20 }, { territory: { money: 1, respect: 2, wanted: 2 } }),
	mk("Vigilante Justice", { baseWanted: -0.001, difficulty: 1 }, { hackWeight: 20, strWeight: 20, defWeight: 20, dexWeight: 20, agiWeight: 20 }, { isHacking: true, territory: { money: 1, respect: 1, wanted: 0.9 } }),
	mk("Train Combat", { difficulty: 100 }, { strWeight: 25, defWeight: 25, dexWeight: 25, agiWeight: 25 }, { isHacking: true }),
	mk("Train Hacking", { difficulty: 45 }, { hackWeight: 100 }, { isHacking: true }),
	mk("Train Charisma", { difficulty: 8 }, { chaWeight: 100 }, { isHacking: true }),
	mk("Territory Warfare", { difficulty: 5 }, { hackWeight: 15, strWeight: 20, defWeight: 20, dexWeight: 20, agiWeight: 20, chaWeight: 5 }, { isHacking: true }),
];
const TASKS = Object.fromEntries(T.map((t) => [t.name, t]));
const STATS = ["hack", "str", "def", "dex", "agi", "cha"];

function run(growthOn, hours, startAge, territory = 1 / 7) {
	const base = 1_700_000_000_000;
	let t = 0;
	const realNow = Date.now;
	Date.now = () => base + t * 1000;
	try {
		const settings = loadConfig(fakeNs()).gang;
		settings.growth = { ...settings.growth, enabled: growthOn };
		const members = {};
		for (let i = 1; i <= 12; i++) {
			const m = { name: `m${i}`, task: "Unassigned", earned: 0, exp: {}, points: {} };
			for (const s of STATS) { m.exp[s] = 0; m.points[s] = 0; }
			members[m.name] = m;
		}
		const gang = { respect: 2e6, wanted: 1, territory };
		const stats = (m) => Object.fromEntries(STATS.map((s) => [s, skillLevel(m.exp[s], ascensionMult(m.points[s]))]));
		const info = (m) => {
			const o = { name: m.name, task: m.task, earnedRespect: m.earned, upgrades: [], augmentations: [], ...stats(m) };
			for (const s of STATS) { o[`${s}_exp`] = m.exp[s]; o[`${s}_mult`] = 1; o[`${s}_asc_mult`] = ascensionMult(m.points[s]); o[`${s}_asc_points`] = m.points[s]; }
			return o;
		};
		let ascensions = 0;
		let money = 0;
		let minEarning = 12;
		const ns = fakeNs({ overrides: {
			getResetInfo: () => ({ lastNodeReset: base - startAge * 1000 }),
			format: { percent: (v) => `${Math.round(v * 100)}%`, number: (v) => String(v) },
			gang: {
				getGangInformation: () => ({ respect: gang.respect, respectForNextRecruit: Infinity, wantedPenalty: gang.respect / (gang.respect + gang.wanted), wantedLevel: gang.wanted,
					territory: gang.territory, faction: "Slum Snakes", isHacking: false, power: 100, territoryWarfareEngaged: false }),
				getMemberNames: () => Object.keys(members),
				getMemberInformation: (n) => info(members[n]),
				getTaskNames: () => Object.keys(TASKS).filter((n) => n !== "Unassigned"),
				getTaskStats: (n) => TASKS[n],
				setMemberTask: (n, w) => { members[n].task = w; return true; },
				getAllGangInformation: () => ({}),
				getAscensionResult: (n) => {
					const m = members[n]; const gain = {}; let any = false;
					for (const s of STATS) { const p = ascensionPoints(m.exp[s]); if (p > 0) any = true; gain[s] = ascensionMult(m.points[s] + p) / ascensionMult(m.points[s]); }
					return any ? { respect: m.earned, ...gain } : undefined;
				},
				ascendMember: (n) => {
					const m = members[n];
					for (const s of STATS) { m.points[s] += ascensionPoints(m.exp[s]); m.exp[s] = 0; }
					gang.respect = Math.max(1, gang.respect - m.earned); m.earned = 0; ascensions++;
					return true;
				},
			},
		} });
		const state = { cooling: false, members: 12 };
		const dt = 60;
		for (t = 0; t < hours * 3600; t += dt) {
			ascend(ns, settings, false, state);
			assignTasks(ns, settings, false, state, true);
			if (growthOn && t > 600) minEarning = Math.min(minEarning, state.kinds.earn ?? 0);
			for (const m of Object.values(members)) {
				const task = TASKS[m.task]; const st = stats(m);
				money += moneyRate(task, st, gang) * dt;
				const r = respectRate(task, st, gang) * dt; m.earned += r; gang.respect += r;
				for (const s of STATS) m.exp[s] += expRate(task, s, 1, ascensionMult(m.points[s])) * dt;
			}
		}
		return { money, ascensions, minEarning };
	} finally {
		Date.now = realNow;
	}
}

test("simulated gang: growth out-earns the legacy rules, never thrashes and keeps a third earning", () => {
	for (const territory of [1 / 7, 1]) {
		const legacy = run(false, 8, 1800, territory);
		const growth = run(true, 8, 1800, territory);
		assert.ok(growth.money > legacy.money * 1.2, `growth ${growth.money.toExponential(2)} vs legacy ${legacy.money.toExponential(2)} at ${territory} of the land`);
		assert.ok(growth.ascensions <= 12 * 8 * 4, `${growth.ascensions} ascensions in 8 hours is a thrash (at most 4 an hour each)`);
		assert.ok(growth.ascensions >= 12, "members do ascend");
		assert.ok(growth.minEarning >= 4, `at least a third of 12 earns (lowest ${growth.minEarning})`);
	}
});
