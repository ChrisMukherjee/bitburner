// Small shared helpers whose answers other scripts act on: utils/targets.js (the batcher's no-Formulas estimate of a
// prepped target), utils/nuke-all.js (which servers get opened with the port programs owned) and utils/find-path.js
// (the connect chain printed for the player).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { estimateAtMinSecurity, scoreTarget, isHackable } from "/utils/targets.js";
import { nukeAllServers } from "/utils/nuke-all.js";
import { findPath } from "/utils/find-path.js";

function targetNs({ security = 20, min = 10, level = 100, weaken = 1000, hackPct = 0.01, chance = 0.5, maxMoney = 1e9, files = {} } = {}) {
	return fakeNs({
		files,
		overrides: {
			fileExists: (file) => file in files,
			getServerSecurityLevel: () => security,
			getServerMinSecurityLevel: () => min,
			getServerRequiredHackingLevel: () => level,
			getWeakenTime: () => weaken,
			hackAnalyze: () => hackPct,
			hackAnalyzeChance: () => chance,
			getServerMaxMoney: () => maxMoney,
			hasRootAccess: () => true,
		},
	});
}

test("without Formulas a prepped target's weaken time is the current one rescaled by the game's time formula", () => {
	const ns = targetNs({ security: 20, min: 10, level: 100, weaken: 5500 });
	const estimate = estimateAtMinSecurity(ns, "n00dles");
	const scale = (2.5 * 100 * 10 + 500) / (2.5 * 100 * 20 + 500);
	assert.ok(Math.abs(estimate.weaken - 5500 * scale) < 1e-9, "time scales with (2.5 * level * security + 500)");
	assert.ok(estimate.weaken < 5500, "min security is faster than the current, higher security");
});

test("without Formulas hack percent and chance scale with (100 - security) and chance never passes 1", () => {
	const ns = targetNs({ security: 50, min: 10, hackPct: 0.01, chance: 0.9 });
	const estimate = estimateAtMinSecurity(ns, "n00dles");
	const scale = (100 - 10) / (100 - 50);
	assert.ok(Math.abs(estimate.hackPerThread - 0.01 * scale) < 1e-12);
	assert.equal(estimate.chance, 1, "0.9 x 1.8 is capped at certainty");
});

test("a target already at min security is not rescaled", () => {
	const ns = targetNs({ security: 10, min: 10, weaken: 4000, hackPct: 0.02, chance: 0.6 });
	assert.deepEqual(estimateAtMinSecurity(ns, "x"), { weaken: 4000, hackPerThread: 0.02, chance: 0.6 });
});

test("scoreTarget ranks money x chance per millisecond of weaken time, and 0 for an unusable estimate", () => {
	const ns = targetNs({ maxMoney: 1e9 });
	assert.equal(scoreTarget(ns, "x", { weaken: 1000, chance: 0.5 }), (1e9 * 0.5) / 1000);
	assert.ok(scoreTarget(ns, "x", { weaken: 1000, chance: 0.5 }) > scoreTarget(ns, "x", { weaken: 2000, chance: 0.5 }), "slower is worse");
	assert.equal(scoreTarget(ns, "x", { weaken: 0, chance: 1 }), 0);
});

test("isHackable needs root, money and a hacking level high enough, and never home", () => {
	const ns = targetNs({ level: 100, maxMoney: 1e6 });
	assert.equal(isHackable(ns, "n00dles", 100), true);
	assert.equal(isHackable(ns, "n00dles", 99), false, "one level short");
	assert.equal(isHackable(ns, "home", 1000), false);
	assert.equal(isHackable(targetNs({ maxMoney: 0 }), "pserv-0", 1000), false, "no money (a bought server)");
});

// --- nuke-all ---

function nukeWorld({ programs = [], servers }) {
	const opened = [];
	const nuked = [];
	const rooted = new Set(Object.entries(servers).filter(([, s]) => s.root).map(([name]) => name));
	const ns = fakeNs({
		overrides: {
			fileExists: (file) => programs.includes(file),
			scan: (host) => (host === "home" ? Object.keys(servers) : []),
			hasRootAccess: (host) => host === "home" || rooted.has(host),
			getServerNumPortsRequired: (host) => servers[host].ports,
			brutessh: (host) => opened.push(["ssh", host]), ftpcrack: (host) => opened.push(["ftp", host]),
			relaysmtp: (host) => opened.push(["smtp", host]), httpworm: (host) => opened.push(["http", host]), sqlinject: (host) => opened.push(["sql", host]),
			nuke: (host) => { nuked.push(host); rooted.add(host); },
		},
	});
	return { ns, opened, nuked };
}

test("nukeAll opens only servers whose port requirement the owned programs cover", () => {
	const { ns, nuked } = nukeWorld({ programs: ["BruteSSH.exe", "FTPCrack.exe"], servers: { easy: { ports: 0 }, two: { ports: 2 }, three: { ports: 3 } } });
	nukeAllServers(ns);
	assert.deepEqual(nuked.sort(), ["easy", "two"], "two programs cover 2 ports, not 3");
});

test("nukeAll runs each owned port program on a server it opens, and none it doesn't own", () => {
	const { ns, opened } = nukeWorld({ programs: ["BruteSSH.exe", "HTTPWorm.exe"], servers: { box: { ports: 2 } } });
	nukeAllServers(ns);
	assert.deepEqual(opened.map(([kind]) => kind).sort(), ["http", "ssh"]);
});

test("nukeAll leaves servers that already have root alone", () => {
	const { ns, opened, nuked } = nukeWorld({ programs: ["BruteSSH.exe"], servers: { done: { ports: 1, root: true } } });
	nukeAllServers(ns);
	assert.deepEqual([opened, nuked], [[], []]);
});

// --- find-path ---

test("findPath returns the shortest chain from home, and [] for an unreachable server", () => {
	const links = { home: ["a", "b"], a: ["home", "c"], b: ["home", "c", "d"], c: ["a", "b"], d: ["b", "e"], e: ["d"], island: [] };
	const ns = fakeNs({ overrides: { scan: (host) => links[host] ?? [] } });
	assert.deepEqual(findPath(ns, "e"), ["home", "b", "d", "e"]);
	assert.deepEqual(findPath(ns, "c").length, 3, "two hops, either way round");
	assert.deepEqual(findPath(ns, "home"), ["home"]);
	assert.deepEqual(findPath(ns, "island"), []);
});
