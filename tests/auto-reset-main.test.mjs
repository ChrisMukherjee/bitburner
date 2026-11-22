// singularity/auto-reset.js main loop: the planner runs every check, and only RESET advice that survives every guard
// (--dry, the sleeve hold, the hold after a reset that bought nothing) stops the other scripts. resetNow itself is in
// reset-sequence.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeWorld } from "./support/fake-world.mjs";
import { main } from "/singularity/auto-reset.js";

const PLAN = "data/aug-plan.json";
const STOP = "test: stop";

const advice = (changes = {}) => ({
	queued: [], affordable: ["A"], cost: 1e9, buyList: [{ aug: "A", faction: "F" }], neurofluxFaction: "F",
	decision: { reset: false, push: false, reason: "waiting", curve: [{ inMinutes: 0, augs: 1, neuroflux: 0 }] }, ...changes,
});

/**
 * Runs main for `checks` planner passes. `plans[i]` is what the planner writes on pass i (a function of the plan so far,
 * or null for a planner that crashes and writes nothing); the last one repeats.
 */
async function loop({ plans, checks = 1, args = {}, bought = { augs: ["A"], neuroflux: 0 }, files = {}, ports = {}, homeRam = 256, plannerFits = true, money = 0 }) {
	let pass = 0;
	let sleeps = 0;
	const execs = [];
	const world = fakeWorld({
		homeRam, files, ports, money, servers: { "pserv-0": { ram: 64 } },
		scriptRam: (script) => (script === "singularity/buy-augs.js" && !plannerFits ? 1000 : 2),
		onExec: (script, scriptArgs, game) => {
			execs.push([script, ...scriptArgs].join(" "));
			if (script === "singularity/buy-augs.js") {
				const make = plans[Math.min(pass++, plans.length - 1)];
				if (make) game.ns.write(PLAN, JSON.stringify({ checkedAt: Date.now(), ...make(pass) }), "w");
			}
			if (script === "singularity/workers/aug-buyer.js") {
				const current = JSON.parse(game.ns.read(PLAN));
				current.lastBuy = { at: Date.now() + 1, ...bought };
				game.ns.write(PLAN, JSON.stringify(current), "w");
			}
			return { exits: !["startup.js", "singularity/install-augs.js"].includes(script) };
		},
		overrides: {
			flags: (schema) => ({ ...Object.fromEntries(schema.map(([name, value]) => [name, value])), ...args }),
			sleep: async (ms) => { if (ms >= 60_000 && ++sleeps >= checks) throw new Error(STOP); return true; },
		},
	});
	world.start("singularity/auto-reset.js");
	world.ns.pid = world.running().find((proc) => proc.filename === "singularity/auto-reset.js").pid;
	world.start("hack/batcher.js");
	let returned = false;
	try {
		await main(world.ns);
		returned = true;
	} catch (err) {
		if (err.message !== STOP) throw err;
	}
	return { world, execs, returned };
}

const reset = (changes = {}) => () => advice({ decision: { reset: true, push: false, reason: "value per hour peaked", curve: [{ inMinutes: 0, augs: 1, neuroflux: 0 }] }, resetSince: Date.now(), ...changes });
const wait = () => advice();

test("wait advice: it plans each check and leaves every other script alone", async () => {
	const { world, execs } = await loop({ plans: [wait], checks: 3 });
	assert.equal(execs.filter((line) => line === "singularity/buy-augs.js --plan").length, 3);
	assert.ok(world.names("home").includes("hack/batcher.js"));
	assert.ok(!execs.some((line) => line.includes("aug-buyer") || line.includes("install-augs")));
});

test("RESET advice buys and installs, then the script ends (the install replaces the run)", async () => {
	const { execs, returned } = await loop({ plans: [reset()], checks: 3 });
	assert.equal(returned, true, "main returns after a successful install");
	assert.deepEqual(execs, [
		"singularity/buy-augs.js --plan", "stocks/stock-trader.js --liquidate --no-buy-tix",
		"singularity/workers/aug-buyer.js", "singularity/install-augs.js --force startup.js",
	]);
});

test("--dry says it would reset and does nothing", async () => {
	const { world, execs, returned } = await loop({ plans: [reset()], args: { dry: true }, checks: 2 });
	assert.equal(returned, false);
	assert.ok(!execs.some((line) => line.includes("aug-buyer") || line.includes("install-augs")));
	assert.ok(world.names("home").includes("hack/batcher.js"));
	assert.ok(world.ns.logs.some((line) => /would reset now/.test(line)));
});

test("after a reset that bought nothing it holds RESET advice for retryMinutes instead of stopping everything every check", async () => {
	// Advice counts an augment, the buyer gets none: resetNow gives up. The next checks (10 minutes apart) must not retry.
	const { execs } = await loop({ plans: [reset()], bought: { augs: [], neuroflux: 0 }, checks: 3 });
	assert.equal(execs.filter((line) => line.includes("aug-buyer")).length, 1, "one attempt, then held for the next checks");
});

test("a planner that can't run (no RAM) or crashes is logged and retried, never treated as advice", async () => {
	let { world, execs } = await loop({ plans: [reset()], plannerFits: false, checks: 2 });
	assert.ok(!execs.some((line) => line.includes("aug-buyer")), "no plan, no reset");
	assert.ok(world.ns.logs.some((line) => /couldn't plan/.test(line)));
	({ world, execs } = await loop({ plans: [null], checks: 2 }));
	assert.ok(!execs.some((line) => line.includes("aug-buyer")));
	assert.ok(world.ns.logs.some((line) => /couldn't plan/.test(line)));
});

test("an old plan file is not mistaken for a fresh one", async () => {
	const stale = JSON.stringify({ checkedAt: 1, ...reset()() });
	const { execs } = await loop({ plans: [null], files: { [PLAN]: stale }, checks: 1 });
	assert.ok(!execs.some((line) => line.includes("aug-buyer")), "a crashed planner leaves the old RESET file behind; it must not trigger a reset");
});

test("new affordable augments are announced once, not on every check", async () => {
	const { world } = await loop({ plans: [() => advice({ affordable: ["A"] }), () => advice({ affordable: ["A"] }), () => advice({ affordable: ["A", "B"] })], checks: 3 });
	const toasts = world.ns.toasts.filter((line) => /affordable/.test(line));
	assert.equal(toasts.length, 1, "A is the baseline of the first plan; only B is new");
	assert.match(toasts[0], /B/);
});

test("the switch to RESET is announced once per stretch, and only by the check the planner marked", async () => {
	const { world } = await loop({ plans: [reset()], args: { dry: true }, checks: 1 });
	assert.equal(world.ns.toasts.filter((line) => /Reset advice is now RESET/.test(line)).length, 1);
	const old = await loop({ plans: [() => ({ ...reset()(), resetSince: 1 })], args: { dry: true }, checks: 1 });
	assert.equal(old.world.ns.toasts.filter((line) => /Reset advice is now RESET/.test(line)).length, 0, "resetSince before this check: already announced");
});

test("a Covenant sleeve the shop is saving for holds the reset, unless The Red Pill is part of it", async () => {
	const hold = { time: Date.now(), hold: true, reason: "sleeve within reach", cost: 5e12 };
	const saving = await loop({ plans: [reset()], ports: { 45: hold }, money: 4e12, checks: 1 });
	assert.ok(!saving.execs.some((line) => line.includes("aug-buyer")), "holding");
	assert.ok(saving.world.ns.logs.some((line) => /holding the reset/.test(line)));
	const withPill = await loop({ plans: [reset({ affordable: ["The Red Pill"] })], ports: { 45: hold }, money: 4e12, checks: 1 });
	assert.ok(withPill.execs.some((line) => line.includes("aug-buyer")), "The Red Pill ends the BitNode, so that install is never held back");
});
