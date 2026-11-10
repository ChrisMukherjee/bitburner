// utils/config.js loadConfig: layering of DEFAULTS, presets, BitNode sections and data/config.json,
// plus the two pieces of logic inside it (Bladeburner route, income mix).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { loadConfig } from "/utils/config.js";
import { DEFAULTS } from "/config.js";

const now = () => Date.now();

test("no data/config.json: the defaults, and no BitNode known yet", () => {
	const config = loadConfig(fakeNs());
	assert.deepEqual(config.augments.wantStats, DEFAULTS.augments.wantStats);
	assert.equal(config.augments.resetRule.minRunMinutes, DEFAULTS.augments.resetRule.minRunMinutes);
	assert.equal(config.bitnode, null);
});

test("loadConfig never changes DEFAULTS (each call gets its own copy)", () => {
	const before = JSON.stringify(DEFAULTS);
	const config = loadConfig(fakeNs({ files: { "data/config.json": JSON.stringify({ augments: { wantStats: ["combat"] } }) } }));
	config.augments.resetRule.waitMargin = 99;
	assert.equal(JSON.stringify(DEFAULTS), before);
});

test("user overrides: objects merge key by key, lists replace", () => {
	const custom = { augments: { wantStats: ["combat"], resetRule: { waitMargin: 0.2 } } };
	const config = loadConfig(fakeNs({ files: { "data/config.json": JSON.stringify(custom) } }));
	assert.deepEqual(config.augments.wantStats, ["combat"]);
	assert.equal(config.augments.resetRule.waitMargin, 0.2);
	// Untouched siblings survive the merge.
	assert.equal(config.augments.resetRule.minRunMinutes, DEFAULTS.augments.resetRule.minRunMinutes);
});

test("a bitnodes section applies only in that BitNode", () => {
	const custom = { bitnodes: { "2": { augments: { resetRule: { waitMargin: 0.3 } } } } };
	const inTwo = loadConfig(fakeNs({ files: { "data/config.json": JSON.stringify(custom), "data/bitnode.txt": "2" } }));
	const inThree = loadConfig(fakeNs({ files: { "data/config.json": JSON.stringify(custom), "data/bitnode.txt": "3" } }));
	assert.equal(inTwo.bitnode, 2);
	assert.equal(inTwo.augments.resetRule.waitMargin, 0.3);
	assert.equal(inThree.augments.resetRule.waitMargin, DEFAULTS.augments.resetRule.waitMargin);
});

test("broken data/config.json: defaults plus a sticky error, no crash", () => {
	const ns = fakeNs({ files: { "data/config.json": "{ not json" } });
	const config = loadConfig(ns);
	assert.deepEqual(config.augments.wantStats, DEFAULTS.augments.wantStats);
	assert.equal(ns.terminal.length, 1);
	assert.match(ns.terminal[0], /isn't valid JSON/);
});

test("challenge bn1 caps home only in BitNode 1", () => {
	const custom = JSON.stringify({ challenges: ["bn1"] });
	const inOne = loadConfig(fakeNs({ files: { "data/config.json": custom, "data/bitnode.txt": "1" } }));
	const inSeven = loadConfig(fakeNs({ files: { "data/config.json": custom, "data/bitnode.txt": "7" } }));
	assert.equal(inOne.homeUpgrades.ram.maxGB, 128);
	assert.equal(inSeven.homeUpgrades?.ram?.maxGB, DEFAULTS.homeUpgrades?.ram?.maxGB);
});

// --- Bladeburner route (routeAdjust) ---

const bladeburnerPort = (state, extra = {}) => ({ 36: { state, stateTime: now(), ...extra } });

test("regression: Daedalus chase is off while Bladeburner is the route", () => {
	for (const state of ["boot", "train", "run"]) {
		const config = loadConfig(fakeNs({ ports: bladeburnerPort(state) }));
		const aug = config.augments;
		assert.equal(aug.resetRule.daedalusPush, false, `daedalusPush in state ${state}`);
		assert.equal(aug.resetRule.daedalusFavor, false, `daedalusFavor in state ${state}`);
		assert.ok(!aug.wantStats.includes("hacking"), `hacking dropped in state ${state}`);
		assert.ok(aug.wantStats.includes("combat") && aug.wantStats.includes("bladeburner"));
		assert.equal(aug.resetRule.weights.strength, 1);
	}
});

test("Bladeburner on hold: the route estimate decides", () => {
	const combat = loadConfig(fakeNs({ ports: bladeburnerPort("hold", { plan: { route: "combat" } }) }));
	const hacking = loadConfig(fakeNs({ ports: bladeburnerPort("hold", { plan: { route: "hacking" } }) }));
	assert.equal(combat.augments.resetRule.daedalusPush, false);
	assert.equal(hacking.augments.resetRule.daedalusPush, DEFAULTS.augments.resetRule.daedalusPush);
	assert.ok(hacking.augments.wantStats.includes("hacking"));
});

test("a stale Bladeburner state (over 15 min old) counts as off", () => {
	const stale = { 36: { state: "run", stateTime: now() - 20 * 60_000 } };
	const config = loadConfig(fakeNs({ ports: stale }));
	assert.equal(config.augments.resetRule.daedalusFavor, DEFAULTS.augments.resetRule.daedalusFavor);
	assert.deepEqual(config.augments.wantStats, DEFAULTS.augments.wantStats);
});

test("no Bladeburner state or garbage on the port: hacking route as configured", () => {
	for (const ports of [{}, { 36: "not json" }, { 36: "42" }]) {
		const config = loadConfig(fakeNs({ ports }));
		assert.deepEqual(config.augments.wantStats, DEFAULTS.augments.wantStats);
		assert.equal(config.augments.resetRule.daedalusPush, DEFAULTS.augments.resetRule.daedalusPush);
	}
});

// --- Income mix (incomeAdjust) ---

test("income mix: money stats follow where this run's money came from", () => {
	const post = { time: now(), sinceInstall: { hacknet: 9e8, hacking: 1e8 }, sinceStart: {} };
	const config = loadConfig(fakeNs({ ports: { 38: post } }));
	assert.equal(config.augments.incomeMixSource, "this run");
	assert.ok(Math.abs(config.augments.incomeFactors.hacknet_node_money - 0.9) < 1e-9);
	assert.ok(Math.abs(config.augments.incomeFactors.hacking_money - 0.1) < 1e-9);
});

test("income mix: too little earned this run falls back to the BitNode, then to the default", () => {
	const small = { time: now(), sinceInstall: { hacking: 10 }, sinceStart: { hacknet: 5e8, hacking: 5e8 } };
	assert.equal(loadConfig(fakeNs({ ports: { 38: small } })).augments.incomeMixSource, "this BitNode");
	const old = { ...small, time: now() - 60 * 60_000 };
	const config = loadConfig(fakeNs({ ports: { 38: old } }));
	assert.equal(config.augments.incomeMixSource, "default");
	assert.equal(config.augments.incomeFactors.hacking_money, DEFAULTS.augments.incomeMix.unknownPortions.hacking ?? 0);
});

test("Bladeburner route: The Blade's Simulacrum counts as wanted and resets at once; simulacrumFirst false turns it off", () => {
	const SIMULACRUM = "The Blade's Simulacrum";
	const config = loadConfig(fakeNs({ ports: bladeburnerPort("run") }));
	assert.ok(config.augments.special[SIMULACRUM]);
	assert.deepEqual(config.augments.resetRule.routeKeyAugs, [SIMULACRUM]);
	assert.ok(config.augments.special["The Red Pill"], "the other special augments stay");
	const hacking = loadConfig(fakeNs({ ports: bladeburnerPort("hold", { plan: { route: "hacking" } }) }));
	assert.equal(hacking.augments.special[SIMULACRUM], undefined);
	assert.equal(hacking.augments.resetRule.routeKeyAugs, undefined);
	const off = loadConfig(fakeNs({ ports: bladeburnerPort("run"), files: { "data/config.json": JSON.stringify({ bladeburner: { simulacrumFirst: false } }) } }));
	assert.equal(off.augments.special[SIMULACRUM], undefined);
});
