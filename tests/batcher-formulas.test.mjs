// hack/batcher.js with Formulas.exe: batch sizes, timings and prep waves come from ns.formulas.
// The fake formulas below follow the game's shape (times and hack percent depend on security, grow
// threads on security, growth and the money gap) and record the server objects they were asked
// about, so the tests can check the batcher asks about the server as it will be when the op lands.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { CONFIG, makePlan, stepTarget, newTargetState, prepWaveFormulas } from "/hack/batcher.js";

const SCRIPT_RAM = { hack: 1.7, grow: 1.75, weaken: 1.75 };
const TARGET = "phantasy";
const MIN_SECURITY = 5;
const MAX_MONEY = 1e9;
const WEAKEN_PER_THREAD = 0.05;
// Times at a given security: the game's times all scale with security the same way.
const weakenAt = (security) => 4000 * security / MIN_SECURITY;
const times = (security) => ({ hack: weakenAt(security) / 4, grow: weakenAt(security) * 0.8, weaken: weakenAt(security) });

/** A target at this security and money now; the formulas record what they were asked. */
function formulasNs({ security = MIN_SECURITY, money = MAX_MONEY } = {}) {
	const asked = { growThreads: [], times: [] };
	const growRate = (server) => Math.log(Math.min(1.0035, 1 + 0.03 / server.hackDifficulty)) * server.serverGrowth / 100;
	const launched = [];
	const ns = fakeNs({
		overrides: {
			hasRootAccess: () => true,
			getServerGrowth: () => 50,
			getServerMinSecurityLevel: () => MIN_SECURITY,
			getServerSecurityLevel: () => security,
			getServerRequiredHackingLevel: () => 100,
			getServerMaxMoney: () => MAX_MONEY,
			getServerMoneyAvailable: () => money,
			getHackTime: () => times(security).hack,
			getGrowTime: () => times(security).grow,
			getWeakenTime: () => times(security).weaken,
			exec: (script, host, options, ...args) => { launched.push({ script, host, threads: options.threads, args }); return launched.length; },
			formulas: {
				mockServer: () => ({}),
				hacking: {
					hackPercent: (server) => 0.002 * (100 - server.hackDifficulty) / 100,
					hackChance: () => 1,
					hackTime: (server) => { asked.times.push({ ...server }); return times(server.hackDifficulty).hack; },
					growTime: (server) => times(server.hackDifficulty).grow,
					weakenTime: (server) => times(server.hackDifficulty).weaken,
					growThreads: (server, player, targetMoney) => {
						asked.growThreads.push({ ...server, targetMoney });
						return Math.log(targetMoney / Math.max(1, server.moneyAvailable)) / growRate(server);
					},
				},
			},
		},
	});
	return { ns, asked, launched };
}
const ctx = () => ({
	fx: { player: {} }, stats: null, weakenPerThread: WEAKEN_PER_THREAD, homeBonus: 1, scriptRam: SCRIPT_RAM,
	flight: { time: 0, counts: new Map(), workerRam: 0, launchedSince: new Map() },
});

test("makePlan asks for grow threads at min security from the money the hack leaves", () => {
	const { ns, asked } = formulasNs({ security: 8, money: 3e8 }); // the current state must not matter
	const plan = makePlan(ns, TARGET, 0.002, 0.2, SCRIPT_RAM, ctx());
	const [server] = asked.growThreads;
	assert.equal(server.hackDifficulty, MIN_SECURITY);
	assert.ok(Math.abs(server.moneyAvailable - MAX_MONEY * (1 - plan.stolen)) < 1);
	assert.equal(server.targetMoney, MAX_MONEY);
	const exact = Math.log(1 / (1 - plan.stolen)) / (Math.log(1.0035) * 0.5);
	assert.equal(plan.growThreads, Math.ceil(exact * CONFIG.growSafetyFormulas));
	assert.ok(plan.growWeakenThreads * WEAKEN_PER_THREAD >= (plan.growThreads * CONFIG.growSecurityPerThread + plan.hackThreads * CONFIG.hackSecurityPerThread) - 1e-9);
});

test("makePlan with catch-up asks to grow from further below max", () => {
	const { ns, asked } = formulasNs();
	makePlan(ns, TARGET, 0.002, 0.2, SCRIPT_RAM, ctx(), 1.25);
	const plan = makePlan(ns, TARGET, 0.002, 0.2, SCRIPT_RAM, ctx());
	assert.ok(Math.abs(asked.growThreads[0].moneyAvailable - MAX_MONEY * (1 - plan.stolen) / 1.25) < 1);
});

test("stepTarget with Formulas: timings at min security even while security is a bit high, ops still land in order", () => {
	const { ns } = formulasNs({ security: 6 }); // above min, but not desynced
	const state = newTargetState();
	state.mode = "batch";
	const before = Date.now();
	stepTarget(ns, TARGET, state, 1, [], SCRIPT_RAM, 2000, 0, ctx());
	assert.equal(state.timings.weaken, weakenAt(MIN_SECURITY));
	assert.ok(state.timings.hackPerThread > 0);
	assert.ok(state.pending.length >= 4);
	const live = times(6);
	for (let index = 0; index < state.pending.length; index += 4) {
		const ops = state.pending.slice(index, index + 4);
		assert.deepEqual(ops.map((op) => op.type), ["hack", "weaken", "grow", "weaken"]);
		// Launched now at today's (higher) security, each op must still be able to land on time.
		for (const op of ops) assert.ok(op.landTime - live[op.type] * op.durationSafety >= before, `${op.type} too late`);
	}
});

test("prep wave: weaken to min, then grow to max, then weaken the grow's security, in that landing order", () => {
	const { ns, asked, launched } = formulasNs({ security: 10, money: 5e8 });
	const pool = [{ host: "pserv-0", freeRam: 1e6 }];
	const before = Date.now();
	prepWaveFormulas(ns, TARGET, pool, SCRIPT_RAM, MIN_SECURITY, 10, MAX_MONEY, 5e8, ctx());
	assert.deepEqual(launched.map((op) => op.script), ["/hack/workers/weaken.js", "/hack/workers/grow.js", "/hack/workers/weaken.js"]);
	const [weaken, grow, growWeaken] = launched;
	assert.equal(weaken.threads, Math.ceil((10 - MIN_SECURITY) / WEAKEN_PER_THREAD));
	const lands = launched.map((op) => op.args[1]);
	assert.equal(lands[1] - lands[0], CONFIG.gapMs);
	assert.equal(lands[2] - lands[1], CONFIG.gapMs);
	assert.ok(lands[0] >= before + times(10).weaken, "the first weaken can land after starting at today's security");
	// Grow is sized for min security (where it lands) from today's money.
	assert.equal(asked.growThreads[0].hackDifficulty, MIN_SECURITY);
	assert.equal(asked.growThreads[0].moneyAvailable, 5e8);
	assert.ok(growWeaken.threads * WEAKEN_PER_THREAD >= grow.threads * CONFIG.growSecurityPerThread);
});

test("prep wave short of RAM: the weaken goes first, the grow shrinks to fit", () => {
	const { ns, launched } = formulasNs({ security: 10, money: 1e8 });
	const ram = 110 * 1.75; // the 100-thread weaken plus a little
	prepWaveFormulas(ns, TARGET, [{ host: "pserv-0", freeRam: ram }], SCRIPT_RAM, MIN_SECURITY, 10, MAX_MONEY, 1e8, ctx());
	const weaken = launched.find((op) => op.script === "/hack/workers/weaken.js");
	assert.equal(weaken.threads, 100);
	const used = launched.reduce((sum, op) => sum + op.threads * 1.75, 0);
	assert.ok(used <= ram + 1e-9);
});

test("prep wave with not even room for the weaken: sends what fits", () => {
	const { ns, launched } = formulasNs({ security: 10 });
	prepWaveFormulas(ns, TARGET, [{ host: "pserv-0", freeRam: 20 * 1.75 }], SCRIPT_RAM, MIN_SECURITY, 10, MAX_MONEY, MAX_MONEY, ctx());
	assert.deepEqual(launched.map((op) => [op.script, op.threads]), [["/hack/workers/weaken.js", 20]]);
});
