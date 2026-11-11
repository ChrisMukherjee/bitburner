// hack/batcher.js main loop, run for simulated minutes against tests/support/fake-hacking.mjs: servers whose money and
// security follow the game's formulas, workers that land when their landing time says. These check what the loop
// promises over time (prep, then hacks landing on a prepped server; retargeting; desync recovery; Formulas.exe bought
// mid-run; home's cores; a fresh BitNode's network), not the numbers of one plan (tests/batcher*.test.mjs do that).
import { test } from "node:test";
import assert from "node:assert/strict";
import { hackingSim, grownMoney, growThreadsFor, hackTime } from "./support/fake-hacking.mjs";
import { main, CONFIG } from "/hack/batcher.js";

const MIN = 60_000;
// A hack lands on a prepped server: the batcher latches into batching at min security + 0.01 (stepTarget)
const PREPPED_SECURITY = 0.01 + 1e-9;
const JOESGUNS = { maxMoney: 2.5e6, minSecurity: 5, requiredLevel: 10, growth: 20 };

/** Money hacked in the `windowMs` before `end` (simulated ms since the start). */
const hackedIn = (sim, end, windowMs) => sim.hacks.filter((hack) => hack.time > end - windowMs && hack.time <= end).reduce((sum, hack) => sum + hack.earned, 0);

test("simulator: growThreadsFor is the fewest threads that grow the money to the target", () => {
	const server = { hackDifficulty: 5, serverGrowth: 20, moneyMax: 1e9, moneyAvailable: 1e5 };
	const threads = growThreadsFor(server, 2e5);
	assert.ok(grownMoney({ ...server, moneyMax: Infinity }, threads) >= 2e5);
	assert.ok(grownMoney({ ...server, moneyMax: Infinity }, threads - 1) < 2e5);
});

for (const formulas of [true, false]) {
	test(`${formulas ? "with" : "without"} Formulas.exe: a run-down target is prepped, then every hack lands at min security, money comes back to max, and income is posted`, async () => {
		const sim = hackingSim({ formulas, homeRam: 256, servers: { joesguns: { ...JOESGUNS, money: 5e5, security: 15, ram: 16 }, pserv: { ram: 512 } } });
		await sim.run(main, 10 * MIN);
		assert.ok(sim.hacks.length > 100, `${sim.hacks.length} hacks`);
		const worstSecurity = Math.max(...sim.hacks.map((hack) => hack.securityAboveMin));
		assert.ok(worstSecurity <= PREPPED_SECURITY, `a hack landed ${worstSecurity} above min security`);
		const lowest = Math.min(...sim.hacks.map((hack) => hack.moneyShare));
		assert.ok(lowest >= CONFIG.batchFromMoney, `a hack landed on ${lowest} of max money, under batchFromMoney`);
		assert.ok(sim.hacks.slice(-20).every((hack) => hack.moneyShare >= 0.999), "the catch-up growth brings money back to max");
		assert.equal(sim.execFailures, 0, "every exec the RAM pool planned fits, on a server the workers were copied to");
		assert.deepEqual(sim.prepOverlaps, [], "a prep wave starts only once nothing else runs against the target");
		assert.equal(sim.ns.logs.filter((line) => /joesguns prepped/.test(line)).length, 1, "prepped once, then batching until the end");
		// With no game lag nearly every op finds the RAM its batch was spaced for (status line: "N dropped"; a few go
		// while the catch-up growth changes the batch size)
		const dropped = sim.ns.logs.filter((line) => line.startsWith("  [batch]")).map((line) => Number(line.match(/(\d+) dropped/)[1]));
		const total = dropped.reduce((sum, count) => sum + count, 0);
		assert.ok(dropped.length > 10 && total <= 0.05 * sim.hacks.length, `${total} batches dropped for ${sim.hacks.length} hacks`);
		// Port 24 (utils/income.js): the average over incomeWindowMs, posted with the status line every logMs
		const posted = sim.port(24);
		const actual = hackedIn(sim, posted.time - sim.start, CONFIG.incomeWindowMs) / (CONFIG.incomeWindowMs / 1000);
		assert.ok(Math.abs(posted.perSecond - actual) <= 0.25 * actual, `posted ${posted.perSecond}/s, hacked ${actual}/s`);
		// Port 31: what share-manager.js must leave free is never negative or more than the network
		const claim = sim.port(31);
		assert.ok(claim.wantFree >= 0 && claim.wantFree <= 256 + 512, `wantFree ${claim.wantFree}`);
	});
}

test("a better target that opens up mid-run takes over; the old one drains (nothing is killed) and is forgotten", async () => {
	const sim = hackingSim({ homeRam: 64, hacking: 300, servers: {
		joesguns: JOESGUNS,
		phantasy: { maxMoney: 2.4e8, minSecurity: 7, requiredLevel: 400, growth: 25 },
		pserv: { ram: 128 },
	} });
	sim.at(3 * MIN, (world) => { world.hacking = 500; }); // phantasy becomes hackable
	await sim.run(main, 12 * MIN); // ns.kill isn't in the fake: calling it would fail the run
	const on = (target) => sim.hacks.filter((hack) => hack.target === target);
	assert.ok(on("joesguns").length > 0 && on("phantasy").length > 0);
	assert.ok(sim.ns.logs.some((line) => /Targets: phantasy .*draining joesguns/.test(line)));
	// Drained: joesguns's last batches land within a retarget interval and a weaken time of the switch
	const joesWeaken = hackTime({ requiredHackingSkill: 10, hackDifficulty: 5 }, 500) * 4;
	assert.ok(Math.max(...on("joesguns").map((hack) => hack.time)) <= 3 * MIN + CONFIG.retargetMs + joesWeaken);
	assert.ok(on("phantasy").every((hack) => hack.securityAboveMin <= PREPPED_SECURITY));
	assert.ok(![...sim.procs.values()].some((proc) => proc.args[0] === "joesguns"), "no workers left on the old target");
	assert.match(sim.ns.logs.filter((line) => line.includes(" active, ")).at(-1), /1 active, 0 draining/, "forgotten once drained");
});

test("a target knocked out of sync (security pushed up) re-preps, then lands every hack at min security again", async () => {
	const sim = hackingSim({ homeRam: 256, servers: { joesguns: { ...JOESGUNS, ram: 16 }, pserv: { ram: 512 } } });
	const push = 5 * MIN;
	sim.at(push, (world) => { world.hosts.joesguns.security += 30; });
	await sim.run(main, 12 * MIN);
	assert.ok(sim.ns.logs.some((line) => /joesguns desynced/.test(line)));
	const after = sim.hacks.filter((hack) => hack.time > push);
	const firstClean = after.findIndex((hack) => hack.securityAboveMin <= PREPPED_SECURITY);
	assert.ok(firstClean >= 0, "hacks resume after the re-prep");
	assert.ok(after.slice(firstClean).every((hack) => hack.securityAboveMin <= PREPPED_SECURITY), "only batches already in flight landed on the raised security");
	assert.ok(after.slice(firstClean).length > 100);
	assert.deepEqual(sim.prepOverlaps, [], "the re-prep waits for the batches in flight to land");
});

test("Formulas.exe bought mid-run: exact planning takes over with one toast, and hacks still land at min security", async () => {
	const sim = hackingSim({ formulas: false, homeRam: 256, servers: { joesguns: { ...JOESGUNS, ram: 16 }, pserv: { ram: 512 } } });
	sim.at(5 * MIN, (world) => world.buyFormulas());
	await sim.run(main, 10 * MIN);
	assert.deepEqual(sim.ns.toasts, ["[batcher] Formulas.exe found: exact planning on."]);
	const after = sim.hacks.filter((hack) => hack.time > 5 * MIN);
	assert.ok(after.length > 100);
	assert.ok(after.every((hack) => hack.securityAboveMin <= PREPPED_SECURITY));
});

test("home's cores: grow and weaken run on home with fewer threads and still bring money back to max", async () => {
	const sim = hackingSim({ homeRam: 1024, homeCores: 8, servers: { joesguns: { ...JOESGUNS, money: 1e6, security: 12 } } });
	await sim.run(main, 10 * MIN);
	assert.ok(sim.ns.called("exec").some(([script, host]) => script.endsWith("grow.js") && host === "home"));
	assert.ok(sim.hacks.length > 100);
	assert.ok(sim.hacks.every((hack) => hack.securityAboveMin <= PREPPED_SECURITY));
	assert.ok(sim.hacks.slice(-20).every((hack) => hack.moneyShare >= 0.999));
});

test("fresh BitNode without Formulas.exe: an 8GB home and the servers that need no ports start earning", async () => {
	const fresh = (maxMoney, money, minSecurity, security, requiredLevel, growth, ram) => ({ maxMoney, money, minSecurity, security, requiredLevel, growth, ram });
	const sim = hackingSim({ formulas: false, homeRam: 8, hacking: 1, servers: {
		"n00dles": fresh(1.75e6, 7e4, 1, 1, 1, 3000, 4),
		"foodnstuff": fresh(5e7, 2e6, 3, 10, 1, 5, 16),
		"sigma-cosmetics": fresh(5.75e7, 2.3e6, 3, 10, 5, 10, 16),
		"joesguns": fresh(6.25e7, 2.5e6, 5, 15, 10, 20, 16),
		"hong-fang-tea": fresh(7.5e7, 3e6, 5, 15, 30, 20, 16),
		"harakiri-sushi": fresh(1e8, 4e6, 5, 15, 40, 40, 16),
		"nectar-net": fresh(6.88e7, 2.75e6, 7, 20, 20, 25, 16),
	} });
	await sim.run(main, 20 * MIN);
	assert.ok(sim.hacks.length > 0, "nothing hacked in 20 minutes");
	assert.ok(sim.hacks[0].time < 10 * MIN, `first hack after ${Math.round(sim.hacks[0].time / 1000)}s`);
	assert.ok(sim.hacks.every((hack) => hack.securityAboveMin <= PREPPED_SECURITY));
	assert.equal(sim.execFailures, 0);
	assert.deepEqual(sim.prepOverlaps, []);
});
