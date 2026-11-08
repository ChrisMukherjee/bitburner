// singularity/buy-augs.js: the reset rule (decideReset and the pieces it is built from).
// Each test builds the context buy-augs.js main would pass, from plain numbers, with the default
// config (loadConfig on an empty fake ns) unless it says otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { loadConfig } from "/utils/config.js";
import {
	setAugConfig, decideReset, homeBeforeNeuroFlux, valueAt, whatFits, cheapestFill,
	favorToRep, repToFavor, requirementMet,
} from "/singularity/buy-augs.js";
import { homeUpgradeBeatsNeuroFlux } from "/singularity/ready.js";

const HOUR = 3600_000;
const MINUTE = 60_000;
const FLAT = { growth: 0, dampHours: 1.5, maxMult: 4, source: "flat", samples: 0 };

/** Default config, with resetRule changes laid over it. Returns the augments section. */
function useConfig(ruleChanges = {}, ns = fakeNs()) {
	const augments = loadConfig(ns).augments;
	Object.assign(augments.resetRule, ruleChanges);
	setAugConfig(augments);
	return augments;
}

/** A decideReset context: a 2h old run with nothing to buy, unless overridden. */
function context(changes = {}) {
	return {
		queued: [], plan: [], upcoming: [], cash: 0, homeCash: 0, income: 0, incomeModel: FLAT,
		sinceInstallMs: 2 * HOUR, neuroflux: null, favors: [], daedalus: null, push: null, endgame: null,
		ratesMeasured: true, ...changes,
	};
}

/** NeuroFlux at $100m a level with plenty of rep. */
const neuroflux = (changes = {}) => ({ price: 1e8, repReq: 1e3, value: 0.05, rep: 1e9, rate: 0, ...changes });

// --- Building blocks ---

test("whatFits buys most expensive first, each next one 1.9x dearer, skipping what doesn't fit", () => {
	const plan = [{ aug: "A", price: 100 }, { aug: "B", price: 50 }, { aug: "C", price: 10 }];
	const fit = whatFits(plan, 200);
	assert.deepEqual(fit.augs, ["A", "B"]); // C would cost 10 x 1.9^2 = 36.1 more
	assert.equal(fit.cost, 100 + 50 * 1.9);
	assert.ok(Math.abs(fit.mult - 1.9 * 1.9) < 1e-12);
});

test("cheapestFill takes the cheapest augments that still fit once bought in price order", () => {
	const pool = [{ aug: "d", price: 1000 }, { aug: "c", price: 30 }, { aug: "a", price: 10 }, { aug: "b", price: 20 }];
	assert.deepEqual(cheapestFill(pool, 100, 3), ["a", "b"]); // a+b+c in price order costs 104.1
	assert.deepEqual(cheapestFill(pool, 1e9, 2), ["a", "b"]);
});

test("favor and rep convert back and forth (the game's formula)", () => {
	for (const favor of [0, 10, 75, 150]) assert.ok(Math.abs(repToFavor(favorToRep(favor)) - favor) < 1e-9);
	assert.ok(Math.abs(favorToRep(150) - 462_000) < 2_000);
});

test("requirementMet handles nested any/all conditions and fails on unknown kinds", () => {
	const player = { money: 1e9, skills: { hacking: 2500, strength: 10 } };
	assert.equal(requirementMet({ type: "money", money: 1e8 }, player), true);
	assert.equal(requirementMet({ type: "skills", skills: { hacking: 2500 } }, player), true);
	const either = { type: "someCondition", conditions: [{ type: "skills", skills: { hacking: 3000 } }, { type: "skills", skills: { strength: 5 } }] };
	assert.equal(requirementMet(either, player), true);
	assert.equal(requirementMet({ type: "everyCondition", conditions: [either, { type: "money", money: 1e10 }] }, player), false);
	assert.equal(requirementMet({ type: "somethingNew" }, player), false);
});

// --- When to reset ---

test("nothing ready: no reset", () => {
	useConfig();
	assert.equal(decideReset(context()).reset, false);
});

test("The Red Pill ready: reset at once, even in a young run", () => {
	useConfig();
	const decision = decideReset(context({ queued: ["The Red Pill"], sinceInstallMs: 5 * MINUTE }));
	assert.equal(decision.reset, true);
	assert.match(decision.reason, /The Red Pill/);
});

test("a run younger than minRunMinutes waits", () => {
	const augments = useConfig();
	const decision = decideReset(context({ queued: ["X"], sinceInstallMs: (augments.resetRule.minRunMinutes - 1) * MINUTE }));
	assert.equal(decision.reset, false);
	assert.match(decision.reason, /minimum/);
});

test("holdForQueued holds until that many are ready", () => {
	useConfig({ holdForQueued: 40 });
	const decision = decideReset(context({ queued: ["X", "Y"] }));
	assert.equal(decision.reset, false);
	assert.match(decision.reason, /holdForQueued/);
});

test("NeuroFlux alone is a valid reset when no later moment beats it", () => {
	useConfig();
	const decision = decideReset(context({ cash: 1e9, homeCash: 1e9, neuroflux: neuroflux() }));
	assert.equal(decision.curve[0].augs, 0);
	assert.equal(decision.curve[0].neuroflux, 3); // $100m, $217m, $469m; the 4th ($1.02b) doesn't fit
	assert.equal(decision.reset, true);
});

test("regression: NeuroFlux bought with future cash counts at later moments (no early resets for 1-2 levels)", () => {
	useConfig();
	// One level affordable now; at $1m/s the next hour buys three more. The old forecast dropped
	// NeuroFlux from later moments once their cash passed the next home upgrade's price, so "now" won.
	const ctx = context({ cash: 1e8, homeCash: 1e8, income: 1e6, sinceInstallMs: HOUR, neuroflux: neuroflux() });
	assert.equal(valueAt(ctx, 0).neuroflux, 1);
	assert.equal(valueAt(ctx, 60 * MINUTE).neuroflux, 4);
	const decision = decideReset(ctx);
	assert.equal(decision.reset, false);
	assert.ok(decision.best.inMinutes > 0);
});

test("waiting wins when a later moment brings a valuable augment within maxWaitMinutes", () => {
	useConfig();
	const upcoming = [{ aug: "Big", faction: "F", repNeeded: 1, missing: 1, price: 1e8, value: 1, etaMs: 30 * MINUTE }];
	const decision = decideReset(context({ queued: ["small"], plan: [], upcoming, cash: 1e9, homeCash: 1e9 }));
	assert.equal(decision.reset, false);
	assert.equal(decision.best.inMinutes, 30);
});

test("a later moment past maxWaitMinutes doesn't hold the reset", () => {
	useConfig({ maxWaitMinutes: 20 });
	const upcoming = [{ aug: "Big", faction: "F", repNeeded: 1, missing: 1, price: 1e8, value: 1, etaMs: 30 * MINUTE }];
	const ctx = context({ queued: [], plan: [{ aug: "small", price: 1e6, value: 0.1 }], upcoming, cash: 1e9, homeCash: 1e9 });
	assert.equal(decideReset(ctx).reset, true);
});

// --- Home upgrade before NeuroFlux ---

test("regression: a NeuroFlux-only reset waits while a home upgrade is affordable", () => {
	useConfig();
	const decision = decideReset(context({ cash: 1e9, homeCash: 1e9, neuroflux: neuroflux() }));
	assert.equal(decision.reset, true);
	const held = homeBeforeNeuroFlux(decision, true);
	assert.equal(held.reset, false);
	assert.match(held.reason, /home upgrade/);
	// No upgrade affordable: the reset stands.
	assert.equal(homeBeforeNeuroFlux(decision, false).reset, true);
});

test("a reset that buys real augments isn't held for a home upgrade", () => {
	useConfig();
	const decision = decideReset(context({ plan: [{ aug: "A", price: 1e8, value: 0.3 }], cash: 1e9, homeCash: 1e9, neuroflux: neuroflux() }));
	assert.equal(decision.reset, true);
	assert.equal(homeBeforeNeuroFlux(decision, true).reset, true);
});

test("homeUpgradeBeatsNeuroFlux reads the home buyers' notes on port 33", () => {
	const gates = (notes) => fakeNs({ ports: { 33: notes } });
	assert.equal(homeUpgradeBeatsNeuroFlux(gates({}), 1e12), false, "no note: NeuroFlux gets the cash");
	assert.equal(homeUpgradeBeatsNeuroFlux(gates({ "home-ram": { needCash: 5e9 } }), 1e10), true);
	assert.equal(homeUpgradeBeatsNeuroFlux(gates({ "home-ram": { needCash: 5e9 } }), 1e9), false);
	assert.equal(homeUpgradeBeatsNeuroFlux(gates({ "home-ram": { done: true }, "home-cores": { needCash: 2e9 } }), 3e9), true);
	assert.equal(homeUpgradeBeatsNeuroFlux(gates({ "home-ram": { done: true } }), 1e15), false);
});

// --- Daedalus ---

/** Daedalus joined with 150 favor and most of The Red Pill's rep. */
const daedalus = (changes = {}) => ({
	favor: 150, rep: 2e6, rate: 0, redPillRep: 2.5e6, threshold: 150, joinAgeMs: HOUR, repMult: 1, ...changes,
});

test("Daedalus can take donations and the money is there: no reset", () => {
	useConfig();
	const decision = decideReset(context({ queued: ["X"], cash: 1e12, homeCash: 1e12, daedalus: daedalus() }));
	assert.equal(decision.reset, false);
	assert.match(decision.reason, /donations/);
});

test("Daedalus favor reaches the donation line on reset, and work is slower: reset", () => {
	useConfig();
	const d = daedalus({ favor: 100, rep: 4e5, rate: 10 });
	const decision = decideReset(context({ queued: ["X"], income: 1e9, daedalus: d }));
	assert.equal(decision.reset, true);
	assert.match(decision.reason, /Daedalus favor/);
});

test("regression: under the Bladeburner route the Daedalus rule doesn't drive resets", () => {
	const ns = fakeNs({ ports: { 36: { state: "run", stateTime: Date.now() } } });
	useConfig({}, ns);
	const decision = decideReset(context({ queued: ["X"], cash: 1e12, homeCash: 1e12, daedalus: daedalus() }));
	assert.doesNotMatch(decision.reason, /Daedalus/);
	assert.equal(decision.reset, true); // the normal rule: nothing better later at no income
});

test("Daedalus push: enough cheap augments affordable for the invite count resets now", () => {
	useConfig();
	const push = { need: 30, installed: 25, missing: 3, fill: ["a", "b", "c"] };
	const decision = decideReset(context({ push }));
	assert.equal(decision.reset, true);
	assert.equal(decision.push, true);
});

// --- After The Red Pill ---

test("after The Red Pill: hacking already at the daemon's level means no reset", () => {
	useConfig();
	const endgame = { daemonLevel: 3000, level: 3000, exp: 1e12, rate: 1e6, statsOf: new Map() };
	const decision = decideReset(context({ queued: ["X"], endgame }));
	assert.equal(decision.reset, false);
	assert.match(decision.reason, /auto-destroy/);
});

test("after The Red Pill: a batch that gets there much sooner resets", () => {
	useConfig();
	// Level 1000 of 3000 at a slow exp rate; the batch doubles the hacking multiplier.
	const statsOf = new Map([["Boost", { hacking: 2, hacking_exp: 2 }]]);
	const endgame = { daemonLevel: 3000, level: 1000, exp: 1e8, rate: 10, statsOf };
	const decision = decideReset(context({ queued: ["Boost"], endgame }));
	assert.equal(decision.reset, true);
});
