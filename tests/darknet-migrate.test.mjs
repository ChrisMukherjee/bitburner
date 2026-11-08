// Induced server migration: the manager's stall detection and target choice (darknet/dnet-manager.js
// manageMigration), the crawler's push step (darknet/crawler.js syncMigrate) and the worker (darknet/migrate.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { manageMigration, noteMigration } from "/darknet/dnet-manager.js";
import { syncMigrate } from "/darknet/crawler.js";
import { main as migrateMain } from "/darknet/migrate.js";
import { MIGRATE, MIGRATE_TARGET_FILE } from "/darknet/config.js";

const RAM = { "darknet/migrate.js": 5.8, "darknet/phish.js": 3.65 };
const MIN = 60 * 1000;

/** ns for the manager: `crawlers` are the hosts running a crawler, `linked` the stasis-linked ones. */
function managerNs({ crawlers, linked = [] }) {
	return fakeNs({ overrides: {
		ps: (host) => (crawlers.includes(host) ? [{ filename: "darknet/crawler.js", threads: 1, pid: 1 }] : []),
		scp: () => true,
		dnet: { getStasisLinkedServers: () => linked, connectToSession: () => ({ success: true }) },
	} });
}
function world(hosts, stationary = []) {
	const map = {}, passwords = {};
	for (const host of hosts) { map[host] = { isStationary: stationary.includes(host) }; passwords[host] = "x"; }
	return { map, passwords, earnings: {} };
}
const written = (ns) => JSON.parse(ns.files[MIGRATE_TARGET_FILE]);

test("nothing is pushed until the map has stalled", () => {
	const ns = managerNs({ crawlers: ["a", "b"] });
	const state = world(["a", "b"]);
	assert.deepEqual(manageMigration(ns, state, 0), []);
	assert.deepEqual(manageMigration(ns, state, MIGRATE.stallMs - 1), []);
	assert.deepEqual(manageMigration(ns, state, MIGRATE.stallMs), ["a", "b"]);
	assert.deepEqual(written(ns), ["a", "b"]);
});

test("targets skip stationary, stasis-linked, crawler-less and unopened servers, up to the cap", () => {
	const hosts = ["darkweb", "pinned", "nocrawler", "x", "y", "z"];
	const ns = managerNs({ crawlers: ["darkweb", "pinned", "x", "y", "z"], linked: ["pinned"] });
	const state = world(hosts, ["darkweb"]);
	delete state.passwords.z; // not opened by us
	manageMigration(ns, state, 0);
	assert.deepEqual(manageMigration(ns, state, MIGRATE.stallMs), ["x", "y"]);
});

test("a new server clears the targets and restarts the stall timer", () => {
	const ns = managerNs({ crawlers: ["a", "b"] });
	const state = world(["a"]);
	manageMigration(ns, state, 0);
	assert.deepEqual(manageMigration(ns, state, MIGRATE.stallMs), ["a"]);
	state.map.b = {}; state.passwords.b = "x";
	assert.deepEqual(manageMigration(ns, state, MIGRATE.stallMs + 1000), []);
	assert.deepEqual(written(ns), []);
	assert.deepEqual(manageMigration(ns, state, MIGRATE.stallMs + 1000 + MIGRATE.stallMs), ["a", "b"]);
});

test("a pushed server rests for the cooldown, and one that never moves is given up on", () => {
	const ns = managerNs({ crawlers: ["a", "b", "c"] });
	const state = world(["a", "b", "c"]);
	manageMigration(ns, state, 0);
	let now = MIGRATE.stallMs;
	assert.deepEqual(manageMigration(ns, state, now), ["a", "b"]);
	noteMigration(state.earnings, { host: "a", moved: true, at: now });
	noteMigration(state.earnings, { host: "b", moved: false, at: now });
	assert.deepEqual(manageMigration(ns, state, now + 1), ["c"]);
	now += MIGRATE.cooldownMs;
	assert.deepEqual(manageMigration(ns, state, now), ["c", "a"], "the never-pushed server goes first, then the least recently pushed");
	for (let i = 0; i < MIGRATE.giveUpAfter; i++) noteMigration(state.earnings, { host: "b", moved: false, at: now });
	now += MIGRATE.cooldownMs;
	assert.ok(!manageMigration(ns, state, now).includes("b"), "b is parked after repeated pushes that move nothing");
	assert.equal(state.earnings.migrate.moved, 1);
});

test("an unchanged target list is not rewritten", () => {
	const ns = managerNs({ crawlers: ["a"] });
	const state = world(["a"]);
	manageMigration(ns, state, 0);
	manageMigration(ns, state, MIGRATE.stallMs);
	const writes = ns.called("write").length;
	manageMigration(ns, state, MIGRATE.stallMs + 5000);
	assert.equal(ns.called("write").length, writes);
});

/** ns for a crawler on "me": 40 GB with a phish worker using 20, neighbours as given. */
function crawlerNs({ targets, neighbours, running = [] }) {
	return fakeNs({ files: { [MIGRATE_TARGET_FILE]: JSON.stringify(targets) }, overrides: {
		getScriptRam: (script) => RAM[script],
		getServerMaxRam: () => 40,
		getServerUsedRam: () => 20,
		ps: () => running,
		kill: () => true,
		exec: () => 5,
		dnet: { probe: () => neighbours },
	} });
}

test("a crawler next to a target stops phishing and pushes it with the free RAM", () => {
	const phish = { filename: "darknet/phish.js", threads: 5, pid: 3 };
	const ns = crawlerNs({ targets: ["t"], neighbours: ["t", "u"], running: [phish] });
	// phishing killed frees 20 GB in the real game; the fake keeps used RAM fixed, so 20 GB free -> 3 threads
	syncMigrate(ns, { self: "me", pushed: new Map() });
	assert.equal(ns.called("kill").length, 1);
	assert.deepEqual(ns.called("exec")[0], ["darknet/migrate.js", "me", 3, "t"]);
});

test("no push when the target isn't a neighbour, a worker is already running or the target was pushed lately", () => {
	let ns = crawlerNs({ targets: ["t"], neighbours: ["u"] });
	syncMigrate(ns, { self: "me", pushed: new Map() });
	assert.equal(ns.called("exec").length, 0);
	ns = crawlerNs({ targets: ["t"], neighbours: ["t"], running: [{ filename: "darknet/migrate.js", threads: 3, pid: 9 }] });
	syncMigrate(ns, { self: "me", pushed: new Map() });
	assert.equal(ns.called("exec").length, 0);
	ns = crawlerNs({ targets: ["t"], neighbours: ["t"] });
	syncMigrate(ns, { self: "me", pushed: new Map([["t", Date.now()]]) });
	assert.equal(ns.called("exec").length, 0);
	ns = crawlerNs({ targets: [], neighbours: ["t"] });
	syncMigrate(ns, { self: "me", pushed: new Map() });
	assert.equal(ns.called("exec").length, 0);
});

/** ns for the worker: probe lists the target until `movesAfter` calls have been made. */
function workerNs({ movesAfter = Infinity, code = 200, success = true }) {
	let calls = 0;
	const ns = fakeNs({ overrides: {
		args: ["t"],
		getHostname: () => "me",
		getPortHandle: () => ({ tryWrite: (text) => { ns.report = JSON.parse(text); } }),
		dnet: {
			probe: () => (calls >= movesAfter ? [] : ["t"]),
			induceServerMigration: async () => { calls++; return { success, code }; },
		},
	} });
	return ns;
}

test("the worker pushes until the target is no longer a neighbour, then reports it moved", async () => {
	const ns = workerNs({ movesAfter: 3 });
	await migrateMain(ns);
	assert.equal(ns.called("dnet.induceServerMigration").length, 3);
	assert.deepEqual([ns.report.kind, ns.report.host, ns.report.moved], ["migrate", "t", true]);
});

test("the worker treats a 351 reply as moved and gives up after repeated refusals", async () => {
	let ns = workerNs({ code: 351, success: false });
	await migrateMain(ns);
	assert.equal(ns.report.moved, true);
	ns = workerNs({ code: 503, success: false });
	await migrateMain(ns);
	assert.equal(ns.report.moved, false);
	assert.equal(ns.called("dnet.induceServerMigration").length, 5);
});
