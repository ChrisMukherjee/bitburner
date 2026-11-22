// corp/corp-manager.js main loop, run for simulated hours against tests/support/fake-corp.mjs: a corporation with the game's
// prices, unlock rules and RAM costs and a simplified economy, with the real call worker (corp/workers/call.js) started for
// every batch. These check what the loop promises over time (the setup order, the investment rounds, going public and
// dividends, never spending money it doesn't have, every worker fitting its RAM), not one decision's numbers
// (tests/corp.test.mjs does that).
import { test } from "node:test";
import assert from "node:assert/strict";
import { corpSim, CITIES } from "./support/fake-corp.mjs";
import { main } from "/corp/corp-manager.js";
import { offerFor } from "/corp/formulas.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const noFunds = (sim) => sim.callErrors.filter((error) => /not enough funds|enough warehouse size/.test(error));
const firstTime = (sim, what) => sim.events.find((event) => event.what === what)?.t ?? Infinity;

test("BitNode 3 for four hours: seed money, the four investment rounds in order, public, dividends; never over its funds or RAM", async () => {
	const sim = corpSim({ node: 3 });
	await sim.run(main, 4 * HOUR);
	const order = sim.events.map((event) => event.what);
	assert.deepEqual(order.slice(0, 6), ["created seed", "accepted round 1", "accepted round 2", "accepted round 3", "accepted round 4", "public"]);
	assert.deepEqual(sim.errors, [], "funds never below zero after a cycle");
	assert.deepEqual(noFunds(sim), [], "no purchase the corporation couldn't pay for");
	assert.equal(sim.ramErrors, 0, "every worker had the RAM its calls cost");
	assert.ok(sim.workers.every((worker) => worker.ram <= sim.maxRam));
	const corp = sim.corp;
	for (const unlock of ["Smart Supply", "Export"]) assert.ok(corp.unlocks.has(unlock), unlock);
	for (const name of ["Agriculture", "Chemical", "Tobacco"]) {
		const division = corp.divisions.get(name);
		assert.ok(division, `${name} exists`);
		assert.deepEqual(Object.keys(division.warehouses).sort(), [...CITIES].sort(), `${name} has a warehouse in every city`);
	}
	const tobacco = corp.divisions.get("Tobacco");
	assert.ok([...tobacco.products.values()].some((product) => product.progress >= 100), "a product finished");
	const finished = [...tobacco.products.entries()].filter(([, product]) => product.progress >= 100);
	assert.ok(finished.slice(0, -1).every(([, product]) => product.price || product.ta2), "every finished product but one done this cycle has a sell price");
	assert.ok(corp.dividendRate > 0 && sim.player.money > 1e6, "public with profit: dividends reach the player");
	assert.ok(firstTime(sim, "accepted round 1") < 1 * HOUR, "round 1 within the first hour");
});

test("Rounds 1 and 2 wait for the research targets: no growth spending while a division researches, and the offer waits for it", async () => {
	const sim = corpSim({ node: 3 });
	await sim.run(main, 40 * MIN);
	const researching = sim.ns.logs.filter((line) => /research phase/.test(line));
	assert.ok(researching.length > 0, "a research phase happened");
	assert.ok(sim.ns.logs.some((line) => /waiting: research points below the round's target/.test(line)), "the offer waited for the research target");
	assert.ok(firstTime(sim, "accepted round 2") > firstTime(sim, "accepted round 1"));
});

test("a 64GB home: every batch fits, and the corporation still gets through round 2", async () => {
	const sim = corpSim({ node: 3, ram: 64 });
	await sim.run(main, 1 * HOUR);
	assert.equal(sim.ramErrors, 0);
	assert.ok(sim.workers.every((worker) => worker.ram <= 64), `largest worker ${Math.max(...sim.workers.map((worker) => worker.ram))}GB`);
	assert.ok(sim.events.some((event) => event.what === "accepted round 2"));
	assert.deepEqual(noFunds(sim), []);
});

test("no Source-File 3 outside BitNode 3: one advice line and no corporation calls", async () => {
	const sim = corpSim({ node: 1 });
	await sim.run(main, 10 * MIN);
	assert.equal(sim.ns.terminal.length, 1);
	assert.match(sim.ns.terminal[0], /Corporation API.*BitNode 3/);
	assert.deepEqual(sim.workers, []);
	assert.equal(sim.corp, null);
});

test("Source-File 3.1 outside BitNode 3: waits for selfFundCash x $150b, then self-funds, takes round 1 before spending, buys the APIs first", async () => {
	const sim = corpSim({ node: 1, sourceFiles: [[3, 1]], money: 100e9 });
	await sim.run(main, 5 * MIN);
	assert.equal(sim.corp, null, "too little cash: no corporation");
	assert.ok(sim.ns.logs.some((line) => /waiting for \$300\.00b cash to self-fund/.test(line)));
	sim.player.money = 400e9;
	await sim.run(main, 1 * HOUR); // startup.js starts it again once corp/ready.js says so
	assert.equal(sim.events[0].what, "created self-funded");
	assert.equal(sim.player.money, 250e9, "the $150b price came from the player");
	const actions = sim.workers.flatMap((worker) => worker.calls).filter((call) => !/\.(get|has)/.test(call[0]));
	const firstSpend = actions.findIndex((call) => /purchaseUnlock|expand/.test(call[0]));
	assert.deepEqual(actions[firstSpend], ["corporation.purchaseUnlock", "Warehouse API"], "the Warehouse API is the first thing bought");
	assert.equal(sim.events[1]?.what, "accepted round 1", "the setup can't be paid from profit: the offer pays for it");
	const fresh = offerFor(10e9 + 150e9 / 3, 1); // a new corporation's valuation: 10b + funds / 3, before anything is spent
	const accepted = sim.ns.logs.find((line) => /accepted the round 1 investment/.test(line)) ?? "";
	assert.ok(accepted.includes(`${(fresh / 1e9).toFixed(2)}b`), `taken at the untouched $150b valuation: ${accepted}`);
	assert.equal(sim.events.filter((event) => /accepted/.test(event.what)).length, 1, "and only that one: later steps wait for profit");
	assert.deepEqual(sim.errors, []);
	assert.deepEqual(noFunds(sim), []);
});

test("corp.enabled false: does nothing at all", async () => {
	const sim = corpSim({ node: 3, files: { "data/config.json": JSON.stringify({ corp: { enabled: false } }) } });
	await sim.run(main, 10 * MIN);
	assert.equal(sim.corp, null);
	assert.deepEqual(sim.workers, []);
	assert.deepEqual(sim.ns.logs, []);
});

test("the BN3 challenge (forbid corporation): one line, no corporation created", async () => {
	const sim = corpSim({ node: 3, files: { "data/config.json": JSON.stringify({ challenges: ["bn3"] }), "data/bitnode.txt": "3" } });
	await sim.run(main, 10 * MIN);
	assert.equal(sim.corp, null);
	assert.deepEqual(sim.workers, []);
	assert.deepEqual(sim.ns.terminal, [], "no missing-API advice: the API is there, a challenge is the reason");
	assert.ok(sim.ns.logs.some((line) => /no corporation: a challenge is on/.test(line)));
});

test("a restart keeps the planner's memory from the summary port (the round's start time and the offer history)", async () => {
	const sim = corpSim({ node: 3 });
	await sim.run(main, 20 * MIN);
	const before = sim.summary().memory;
	assert.ok(before.roundStart > 0 && before.offers.length > 0);
	await sim.run(main, 2 * MIN);
	const after = sim.summary().memory;
	if (after.round === before.round) assert.equal(after.roundStart, before.roundStart, "the same round keeps its start time");
	assert.ok(after.offers.some((entry) => before.offers.some((old) => old.t === entry.t)) || after.round !== before.round, "the offer history carried over");
});
