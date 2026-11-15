// Grafting (docs/grafting.md): the pure rules (singularity/graft-plan.js), the scan worker's candidates and the player-work
// step that starts a graft (singularity/player-work.js graftStep, the guard that never interrupts a graft in progress).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { DEFAULTS } from "/config.js";
import { graftingApiFromInfo } from "/utils/grafting.js";
import { graftBudget, pickGraft } from "/singularity/graft-plan.js";
import { main as scan } from "/singularity/workers/graft-scan.js";
import { main as start } from "/singularity/workers/graft-start.js";
import { graftStep, workStep } from "/singularity/player-work.js";

const rule = DEFAULTS.grafting;
const aug = (name, extra = {}) => ({ name, cost: 1e9, hours: 1, value: 0.2, reachable: false, ...extra });
const view = (candidates, extra = {}) => ({ candidates, cash: 1e11, plannedCost: 0, idle: true, rule, ...extra });

test("capability: grafting is BitNode 10 or Source-File 10", () => {
	assert.equal(graftingApiFromInfo({ currentNode: 10, ownedSF: new Map() }), true);
	assert.equal(graftingApiFromInfo({ currentNode: 1, ownedSF: new Map([[10, 1]]) }), true);
	assert.equal(graftingApiFromInfo({ currentNode: 1, ownedSF: new Map() }), false);
});

test("default config: grafting is on, with its numbers in the config", () => {
	assert.equal(rule.enabled, true);
	assert.ok(rule.maxFraction > 0 && rule.maxFraction <= 1 && rule.safety >= 1);
});

test("budget: only cash beyond the planned purchases (times safety), and never more than maxFraction of the cash", () => {
	assert.equal(graftBudget(100, 0, { maxFraction: 0.5, safety: 1.25 }), 50, "nothing planned: the share cap");
	assert.equal(graftBudget(100, 60, { maxFraction: 1, safety: 1.25 }), 25, "100 - 60 x 1.25");
	assert.equal(graftBudget(100, 90, { maxFraction: 1, safety: 1.25 }), 0, "never negative");
});

test("pick: the best value per hour of the player's time among the ones within the budget", () => {
	const slow = aug("Slow", { value: 0.3, hours: 3 });
	const fast = aug("Fast", { value: 0.2, hours: 1 });
	assert.equal(pickGraft(view([slow, fast])).name, "Fast", "0.2/h beats 0.1/h");
	assert.equal(pickGraft(view([slow, fast], { cash: 1e9 })), null, "the budget is half the cash, below a $1b price");
	assert.equal(pickGraft(view([fast], { rule: { ...rule, minValue: 0.5 } })), null, "below the least value");
	assert.equal(pickGraft(view([fast], { tried: new Set(["Fast"]) })), null, "tried recently");
});

test("pick: while the player has other work only augmentations no joined faction sells are taken", () => {
	const sold = aug("Sold", { reachable: true, value: 1 });
	const free = aug("Free", { reachable: false, value: 0.1 });
	assert.equal(pickGraft(view([sold, free], { idle: false })).name, "Free");
	assert.equal(pickGraft(view([sold, free], { idle: true })).name, "Sold", "idle: the best of all");
	assert.equal(pickGraft(view([sold], { idle: false })), null);
});

// --- the scan worker ---

function scanWorld({ augs, joinedSells = [], owned = [], installed = [], plan = null }) {
	const stats = { "Cranium": { hacking: 1.2 }, "Plain": {}, "Needs Cranium": { hacking: 1.1 }, "Owned": { hacking: 1.3 } };
	return fakeNs({
		files: plan ? { "data/aug-plan.json": JSON.stringify(plan) } : {},
		overrides: {
			getPlayer: () => ({ factions: ["Faction"] }),
			singularity: {
				getOwnedAugmentations: (withQueued) => (withQueued ? [...installed, ...owned] : installed),
				getAugmentationsFromFaction: () => joinedSells,
				getAugmentationPrereq: (name) => (name === "Needs Cranium" ? ["Cranium"] : []),
				getAugmentationStats: (name) => stats[name] ?? {},
			},
			grafting: {
				getGraftableAugmentations: () => augs,
				getAugmentationGraftPrice: (name) => (name === "Cranium" ? 3e9 : 1e9),
				getAugmentationGraftTime: () => 2 * 3.6e6,
			},
		},
	});
}

test("scan: wanted augmentations only, with price, hours and whether a joined faction sells them", async () => {
	const ns = scanWorld({ augs: ["Cranium", "Plain", "NeuroFlux Governor"], joinedSells: ["Cranium"] });
	await scan(ns);
	const posted = ns.portJson(46);
	assert.deepEqual(posted.candidates.map((item) => item.name), ["Cranium"], "no stats = no value; NeuroFlux is never grafted");
	assert.equal(posted.candidates[0].reachable, true);
	assert.equal(posted.candidates[0].cost, 3e9);
	assert.equal(posted.candidates[0].hours, 2);
	assert.ok(posted.candidates[0].value > 0);
});

test("scan: an augmentation whose prerequisite is not installed, or that is queued already, is left out; the plan's cost is passed on", async () => {
	const ns = scanWorld({ augs: ["Cranium", "Needs Cranium", "Owned"], owned: ["Owned"], plan: { checkedAt: Date.now(), cost: 7e9 } });
	await scan(ns);
	const posted = ns.portJson(46);
	assert.deepEqual(posted.candidates.map((item) => item.name), ["Cranium"], "Needs Cranium waits for Cranium to be installed");
	assert.equal(posted.plannedCost, 7e9);
	const queuedPrereq = scanWorld({ augs: ["Needs Cranium"], installed: ["Cranium"] });
	await scan(queuedPrereq);
	assert.deepEqual(queuedPrereq.portJson(46).candidates.map((item) => item.name), ["Needs Cranium"]);
});

test("start worker: grafts the named augmentation, focused unless told not to", async () => {
	const calls = [];
	const ns = fakeNs({ overrides: { args: ["Cranium", false], grafting: { graftAugmentation: (...args) => { calls.push(args); return true; } } } });
	await start(ns);
	assert.deepEqual(calls, [["Cranium", false]]);
});

// --- player-work ---

const player = (changes = {}) => ({ city: "Sector-12", money: 1e11, factions: [], jobs: {}, skills: { hacking: 500 }, ...changes });
function workWorld({ current = null, started = [], flights = [] } = {}) {
	return fakeNs({
		overrides: {
			getResetInfo: () => ({ currentNode: 10, ownedSF: new Map(), ownedAugs: new Map(), lastAugReset: 0 }),
			getScriptRam: () => 1,
			getHostname: () => "home",
			exec: (script, host, threads, ...args) => { started.push([script, ...args]); return 7; },
			scan: () => [],
			hasRootAccess: () => true,
			getServerMaxRam: () => 128,
			getServerUsedRam: () => 0,
			scp: () => true,
			singularity: {
				getCurrentWork: () => current, travelToCity: (city) => { flights.push(city); return true; }, stopAction: () => true,
				getFactionRep: () => 0, getCompanyRep: () => 0, workForFaction: () => true,
			},
		},
	});
}
const passState = (changes = {}) => ({
	config: JSON.parse(JSON.stringify(DEFAULTS)), focus: true, holdCity: false, studyLevel: 50, noCompany: true, goals: {}, gangDone: true, travelDone: true,
	graft: { time: Date.now(), plannedCost: 0, candidates: [aug("Cranium", { reachable: false })] }, ...changes,
});

test("graft step: flies to New Tokyo and starts the graft with the player's focus", () => {
	const started = [], flights = [];
	const ns = workWorld({ started, flights });
	const message = graftStep(ns, passState(), player(), false);
	assert.deepEqual(flights, ["New Tokyo"]);
	assert.deepEqual(started.map(([script, ...args]) => [script, ...args]).at(-1)?.slice(0, 3), ["singularity/workers/graft-start.js", "Cranium", true]);
	assert.match(message, /grafting Cranium/);
});

test("graft step: already in New Tokyo it does not fly; with too little cash for price plus flight it does nothing", () => {
	const flights = [], started = [];
	graftStep(workWorld({ started, flights }), passState(), player({ city: "New Tokyo" }), true);
	assert.equal(flights.length, 0);
	assert.equal(started.length, 1);
	const poor = workWorld({ started: [], flights });
	assert.equal(graftStep(poor, passState({ graft: { candidates: [aug("Cranium", { cost: 1e9 })] } }), player({ money: 1.9e9 }), true), null, "half of the cash is under the price");
	const allIn = JSON.parse(JSON.stringify(DEFAULTS));
	allIn.grafting.maxFraction = 1;
	assert.equal(graftStep(poor, passState({ config: allIn, graft: { candidates: [aug("Cranium", { cost: 1e9 })] } }), player({ money: 1e9 + 1e5 }), true), null, "the price fits but not the flight too");
	assert.equal(flights.length, 0, "no flight without the money");
});

test("graft step: off by config, nothing posted yet, or waiting in a city for an invite", () => {
	const ns = workWorld();
	const config = JSON.parse(JSON.stringify(DEFAULTS));
	config.grafting.enabled = false;
	assert.equal(graftStep(ns, passState({ config }), player(), true), null);
	assert.equal(graftStep(ns, passState({ graft: null }), player(), true), null);
	assert.equal(graftStep(ns, passState({ holdCity: true }), player(), true), null, "the invite flight is kept");
});

test("graft step: an augmentation tried a moment ago is not started again", () => {
	const started = [];
	const ns = workWorld({ started });
	assert.equal(graftStep(ns, passState({ graftTry: { name: "Cranium", at: Date.now() - 60_000 } }), player({ city: "New Tokyo" }), true), null);
	assert.equal(started.length, 0);
});

test("regression: a graft in progress is never replaced by faction work (the game does not refund it)", () => {
	const ns = workWorld({ current: { type: "GRAFTING", augmentation: "Cranium" } });
	const result = workStep(ns, passState({ goals: { CyberSec: { rep: 1e6, aug: "X", count: 1, skipped: 0 } } }), player({ factions: ["CyberSec"] }));
	assert.match(result.message, /grafting Cranium/);
	assert.equal(ns.called("singularity.workForFaction").length, 0);
	assert.equal(ns.called("singularity.stopAction").length, 0);
});

test("work step: with a faction to work for, only an augmentation no joined faction sells is grafted first; with nothing to do, the best one", () => {
	const reachable = aug("Sold", { reachable: true, value: 1 });
	const goals = { CyberSec: { rep: 1e6, aug: "X", count: 1, skipped: 0 } };
	const busy = workWorld();
	const busyResult = workStep(busy, passState({ goals, graft: { plannedCost: 0, candidates: [reachable] } }), player({ factions: ["CyberSec"] }));
	assert.equal(busy.called("singularity.workForFaction").length, 1, "the faction work goes on");
	assert.doesNotMatch(busyResult.message, /grafting/);
	const idle = workWorld();
	const idleResult = workStep(idle, passState({ graft: { plannedCost: 0, candidates: [reachable] } }), player({ factions: ["CyberSec"] }));
	assert.match(idleResult.message, /grafting Sold/);
});
