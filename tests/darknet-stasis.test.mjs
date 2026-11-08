// Stasis link choice (darknet/dnet-manager.js manageStasis), the crawler's link/unlink step (darknet/crawler.js
// syncStasis) and promoter placement (stocks/stock-trader.js retargetPromoters).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { manageStasis } from "/darknet/dnet-manager.js";
import { syncStasis } from "/darknet/crawler.js";
import { retargetPromoters } from "/stocks/stock-trader.js";
import { STASIS_TARGET_FILE } from "/darknet/config.js";

const RAM = { "darknet/crawler.js": 10.85, "darknet/stasis.js": 13.65, "darknet/phish.js": 3.65, "stocks/workers/promote-stock.js": 3.6 };

/** ns for manageStasis: `servers` is host -> { maxRam, blocked, running: [scripts], stationary }. */
function managerNs(servers, { limit = 2, linked = [] } = {}) {
	return fakeNs({ overrides: {
		getScriptRam: (script) => RAM[script],
		ps: (host) => (servers[host]?.running ?? []).map((filename) => ({ filename, threads: 1, pid: 1 })),
		scp: () => true,
		dnet: {
			getStasisLinkLimit: () => limit,
			getStasisLinkedServers: () => linked,
			getBlockedRam: (host) => servers[host].blocked ?? 0,
			connectToSession: () => ({ success: true }),
		},
	} });
}
const entry = (maxRam, extra = {}) => ({ maxRam, running: ["darknet/crawler.js"], ...extra });
function world(servers) {
	const map = {}, passwords = {};
	for (const [host, info] of Object.entries(servers)) { map[host] = { maxRam: info.maxRam, isStationary: !!info.stationary }; passwords[host] = "x"; }
	return { map, passwords, earnings: {} };
}

test("stasis targets are the biggest usable servers, up to the cap", () => {
	const servers = { a: entry(32), b: entry(64), c: entry(128) };
	const ns = managerNs(servers, { limit: 2 });
	assert.deepEqual(manageStasis(ns, world(servers), null), ["c", "b"]);
	assert.deepEqual(JSON.parse(ns.files[STASIS_TARGET_FILE]), ["c", "b"]);
});

test("stasis ranks by usable RAM, not max RAM, and skips stationary and too-small servers", () => {
	const servers = { blocked: entry(256, { blocked: 250 }), open: entry(32), darkweb: entry(512, { stationary: true }), tiny: entry(8) };
	const ns = managerNs(servers, { limit: 4 });
	assert.deepEqual(manageStasis(ns, world(servers), null), ["open"]);
});

test("a linked server keeps its slot against a slightly bigger find (1.5x edge)", () => {
	const servers = { old: entry(64), found: entry(80) };
	const ns = managerNs(servers, { limit: 1, linked: ["old"] });
	assert.deepEqual(manageStasis(ns, world(servers), null), ["old"]);
});

test("stasis explains itself when no server has room", () => {
	const servers = { a: entry(8) };
	const state = world(servers);
	manageStasis(managerNs(servers), state, null);
	assert.match(state.earnings.stasisNote, /no server has/);
});

test("an unchanged target set is not rewritten or pushed again", () => {
	const servers = { a: entry(64) };
	const ns = managerNs(servers);
	manageStasis(ns, world(servers), ["a"]);
	assert.equal(ns.called("write").length, 0);
});

/** ns for a crawler on `self`; phish workers use `phishThreads` of `maxRam`. */
function crawlerNs({ maxRam, phishThreads, targets, linked = [], extraUsed = 0 }) {
	const used = 10.85 + extraUsed + phishThreads * 3.65;
	const ns = fakeNs({ files: { [STASIS_TARGET_FILE]: JSON.stringify(targets) }, overrides: {
		getScriptRam: (script) => RAM[script],
		getServerMaxRam: () => maxRam,
		getServerUsedRam: () => used,
		ps: () => [{ filename: "darknet/phish.js", threads: phishThreads, pid: 7 }],
		kill: () => true,
		exec: () => 1,
		spawn: () => {},
		getPortHandle: () => ({ tryWrite: () => true }),
		dnet: { getStasisLinkedServers: () => linked, getStasisLinkLimit: () => 2 },
	} });
	return ns;
}

test("a server with room hands its RAM to stasis.js, stopping phishing first", async () => {
	const ns = crawlerNs({ maxRam: 64, phishThreads: 5, targets: ["me"] });
	await syncStasis(ns, "me", { tryWrite: () => true });
	assert.equal(ns.called("kill").length, 1);
	assert.deepEqual(ns.called("spawn")[0][2], "link");
});

test("a linked server that is no longer wanted unlinks", async () => {
	const ns = crawlerNs({ maxRam: 64, phishThreads: 5, targets: [], linked: ["me"] });
	await syncStasis(ns, "me", { tryWrite: () => true });
	assert.equal(ns.called("spawn")[0][2], "unlink");
});

/** ns for promoters: positions give the long value, hosts is darkweb plus linked servers. */
function stockNs({ holdings, linked = [], free = {}, running = {} }) {
	const started = [];
	const ns = fakeNs({ files: { "data/darknet-passwords.txt": JSON.stringify({ darkweb: "p", x: "p" }) }, overrides: {
		format: { percent: (v) => String(v) },
		getScriptRam: () => 3.6,
		getServerMaxRam: (host) => free[host] ?? 0,
		getServerUsedRam: () => 0,
		isRunning: (pid) => pid in running,
		kill: () => true,
		ps: () => [],
		scp: () => true,
		exec: (script, host, threads, sym) => { started.push({ host, threads, sym }); return started.length + 100; },
		stock: {
			getPosition: (sym) => [holdings[sym] ?? 0, 0, 0, 0],
			getBidPrice: () => 1,
			getVolatility: () => 0.01,
		},
		dnet: { getStasisLinkedServers: () => linked, connectToSession: () => ({ success: true }) },
	} });
	return { ns, started };
}

test("promoters go on the biggest long positions, threads split evenly", () => {
	const { ns, started } = stockNs({ holdings: { AAA: 10, BBB: 500, CCC: 100 }, free: { darkweb: 100 } });
	const promoters = {};
	retargetPromoters(ns, ["AAA", "BBB", "CCC"], 10, promoters);
	assert.deepEqual(Object.keys(promoters).sort(), ["BBB", "CCC"]);
	assert.deepEqual(started.map((s) => s.threads), [5, 5]);
});

test("promotion stops for stocks no longer held and with no threads wanted", () => {
	const { ns } = stockNs({ holdings: { AAA: 5 }, free: { darkweb: 100 } });
	const promoters = { OLD: { workers: [{ pid: 1, host: "darkweb", threads: 2 }], threads: 2 } };
	retargetPromoters(ns, ["AAA", "OLD"], 4, promoters);
	assert.ok(!("OLD" in promoters));
	assert.ok("AAA" in promoters);
	retargetPromoters(ns, ["AAA"], 0, promoters);
	assert.deepEqual(promoters, {});
});
