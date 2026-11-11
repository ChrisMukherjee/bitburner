// hack/batcher.js: batch thread math and landing times (the path without Formulas.exe, measured
// stats from hack/workers/target-stats.js), and the RAM pool in utils/ram-pool.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { CONFIG, makePlan, pickPlan, stepTarget, newTargetState, placeOp, batchRamMs, incomeRates } from "/hack/batcher.js";
import { allocate, threadCapacity } from "/utils/ram-pool.js";

const SCRIPT_RAM = { hack: 1.7, grow: 1.75, weaken: 1.75 };
const TIMES = { hack: 1000, grow: 3200, weaken: 4000 };
const TARGET = "phantasy";

/** A prepped target (min security 5, $1b max) with the given money and security right now. */
function targetNs({ money = 1e9, security = 5 } = {}) {
	return fakeNs({
		overrides: {
			getServerMinSecurityLevel: () => 5,
			getServerSecurityLevel: () => security,
			getServerRequiredHackingLevel: () => 100,
			getServerMaxMoney: () => 1e9,
			getServerMoneyAvailable: (host) => (host === "home" ? 0 : money),
			getHackTime: () => TIMES.hack,
			getGrowTime: () => TIMES.grow,
			getWeakenTime: () => TIMES.weaken,
		},
	});
}
/** What the batcher knows without Formulas.exe: target-stats.js measured at min security. */
const ctx = () => ({
	fx: null, weakenPerThread: 0.05, homeBonus: 1,
	stats: { targets: { [TARGET]: { security: 5, hackPerThread: 0.002, chance: 1, growPerLn: 400 } } },
});

test("makePlan: weakens cover the security each batch adds, grow regrows what was stolen", () => {
	const ns = targetNs();
	for (const fraction of [0.0005, 0.01, 0.1, 0.4, 0.8, 0.95]) {
		const plan = makePlan(ns, TARGET, 0.002, fraction, SCRIPT_RAM, ctx());
		assert.ok(plan.hackThreads >= 1);
		assert.ok(plan.stolen <= 0.9, "never steals more than 90%");
		const hackSecurity = plan.hackThreads * CONFIG.hackSecurityPerThread;
		const growSecurity = plan.growThreads * CONFIG.growSecurityPerThread;
		assert.ok(plan.hackWeakenThreads * 0.05 >= hackSecurity - 1e-9, `hack weaken at ${fraction}`);
		assert.ok(plan.growWeakenThreads * 0.05 >= hackSecurity + growSecurity - 1e-9, `grow weaken at ${fraction}`);
		const needed = 400 * Math.log(1 / (1 - plan.stolen));
		assert.ok(plan.growThreads >= needed, `grow threads at ${fraction}: ${plan.growThreads} < ${needed}`);
		const ram = plan.hackThreads * 1.7 + plan.growThreads * 1.75 + (plan.hackWeakenThreads + plan.growWeakenThreads) * 1.75;
		assert.ok(Math.abs(plan.ramCost - ram) < 1e-9);
	}
});

test("makePlan with catch-up grows more than it steals", () => {
	const ns = targetNs();
	const plain = makePlan(ns, TARGET, 0.002, 0.1, SCRIPT_RAM, ctx());
	const catchUp = makePlan(ns, TARGET, 0.002, 0.1, SCRIPT_RAM, ctx(), 1.25);
	assert.ok(catchUp.growThreads > plain.growThreads);
	assert.equal(catchUp.hackThreads, plain.hackThreads);
});

test("makePlan without measured stats can't size the grow (no batch fits)", () => {
	const plan = makePlan(targetNs(), TARGET, 0.002, 0.1, SCRIPT_RAM, { ...ctx(), stats: { targets: {} } });
	assert.equal(plan.growThreads, Infinity);
});

test("pickPlan keeps one batch under maxBatchShare of the target's RAM, or picks nothing", () => {
	const ns = targetNs();
	for (const budget of [50, 500, 5000, 50000]) {
		const picked = pickPlan(ns, TARGET, 0.002, TIMES, budget, SCRIPT_RAM, ctx());
		assert.ok(picked, `a plan for ${budget}GB`);
		assert.ok(picked.plan.ramCost <= budget * CONFIG.maxBatchShare);
		assert.ok(picked.fraction <= CONFIG.maxHackFraction);
	}
	assert.equal(pickPlan(ns, TARGET, 0.002, TIMES, 1, SCRIPT_RAM, ctx()), null);
});

test("more RAM never picks a smaller batch", () => {
	const ns = targetNs();
	let last = 0;
	for (const budget of [100, 1000, 10000, 100000]) {
		const { fraction } = pickPlan(ns, TARGET, 0.002, TIMES, budget, SCRIPT_RAM, ctx());
		assert.ok(fraction >= last, `${budget}GB picked ${fraction} after ${last}`);
		last = fraction;
	}
});

test("stepTarget: batches land hack, weaken, grow, weaken, one gap apart, and every op can still start", () => {
	const ns = targetNs();
	const state = newTargetState();
	state.mode = "batch";
	const before = Date.now();
	stepTarget(ns, TARGET, state, 1, [], SCRIPT_RAM, 2000, 0, ctx());
	assert.ok(state.pending.length >= 4 && state.pending.length % 4 === 0, `queued ${state.pending.length} ops`);
	const batches = new Map();
	for (const op of state.pending) batches.set(op.batch.id, [...(batches.get(op.batch.id) ?? []), op]);
	let lastHack = -Infinity;
	for (const ops of batches.values()) {
		assert.deepEqual(ops.map((op) => op.type), ["hack", "weaken", "grow", "weaken"]);
		for (let index = 1; index < 4; index++) {
			assert.equal(ops[index].landTime - ops[index - 1].landTime, CONFIG.gapMs, "one gap between landings");
		}
		for (const op of ops) {
			const start = op.landTime - TIMES[op.type] * op.durationSafety;
			assert.ok(start >= before, `${op.type} would have to start ${before - start}ms ago`);
		}
		assert.ok(ops[0].landTime - lastHack >= CONFIG.gapMs * 4 - 1, "batches don't overlap");
		lastHack = ops[0].landTime;
	}
});

test("stepTarget: a desynced target (security far above min) drops its queue and re-preps", () => {
	const ns = targetNs({ security: 20 });
	const state = newTargetState();
	state.mode = "batch";
	state.pending = [{ type: "hack" }];
	stepTarget(ns, TARGET, state, 1, [], SCRIPT_RAM, 2000, 0, ctx());
	assert.equal(state.mode, "prep");
	assert.deepEqual(state.pending, []);
});

test("batchRamMs counts each op's RAM for as long as it runs", () => {
	const plan = { hackThreads: 10, growThreads: 20, hackWeakenThreads: 1, growWeakenThreads: 2, durationSafety: 1 };
	const held = (ms) => ms + CONFIG.launchLeadMs;
	const expected = 10 * 1.7 * held(1000) + 20 * 1.75 * held(3200) + 3 * 1.75 * held(4000);
	assert.ok(Math.abs(batchRamMs(plan, TIMES, SCRIPT_RAM) - expected) < 1e-6);
});

test("placeOp puts grow on home with fewer threads for its cores", () => {
	const pool = [{ host: "pserv-0", freeRam: 100 }, { host: "home", freeRam: 100 }];
	const placed = placeOp(pool, { type: "grow", threads: 10 }, SCRIPT_RAM, 2);
	assert.deepEqual(placed.map((entry) => [entry.host, entry.threads]), [["home", 5]]);
	assert.equal(pool[1].freeRam, 100 - 5 * 1.75);
	// Hack gains nothing from cores: spread over the pool as usual.
	const hack = placeOp(pool, { type: "hack", threads: 10 }, SCRIPT_RAM, 2);
	assert.equal(hack[0].host, "pserv-0");
});

test("allocate is all or nothing", () => {
	const pool = [{ host: "a", freeRam: 10 }, { host: "b", freeRam: 3.5 }];
	assert.equal(threadCapacity(pool, 1.75), 7);
	assert.equal(allocate(pool, [{ type: "grow", threads: 8 }], SCRIPT_RAM), null);
	assert.deepEqual(pool.map((entry) => entry.freeRam), [10, 3.5], "a failed placement leaves the pool alone");
	const placed = allocate(pool, [{ type: "grow", threads: 7 }], SCRIPT_RAM);
	assert.deepEqual(placed.map((entry) => [entry.host, entry.threads]), [["a", 5], ["b", 2]]);
	assert.ok(pool.every((entry) => entry.freeRam < 1.75));
});

test("incomeRates: the recent rate covers the last incomeWindowMs (not the idle prep before it), sinceStart the whole run", () => {
	const step = 10_000;
	const window = CONFIG.incomeWindowMs;
	// Nothing earned while prepping for 2 windows, then 100/s for 2 windows, sampled every 10 s like the status line
	const samples = [];
	for (let time = 0; time <= 4 * window; time += step) samples.push({ time, total: 100 * Math.max(0, time - 2 * window) / 1000 });
	const kept = [samples[0]];
	let rates;
	for (const sample of samples.slice(1)) {
		kept.push(sample);
		rates = incomeRates(kept);
	}
	assert.equal(rates.recent, 100);
	assert.equal(rates.sinceStart, (100 * 2 * window / 1000) / (4 * window / 1000));
	assert.ok(kept.length <= window / step + 3, `old samples are dropped (${kept.length} kept)`);
	assert.equal(kept[0].time, 0, "the first sample stays for sinceStart");
	// Shorter than one window: recent is the run so far
	assert.deepEqual(incomeRates([{ time: 0, total: 0 }, { time: step, total: 500 }]), { recent: 50, sinceStart: 50 });
});
