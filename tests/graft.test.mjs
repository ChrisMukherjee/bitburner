// Grafting (docs/grafting.md): the pure rules (singularity/graft-plan.js), the scan worker's candidates, the player-work
// step that starts a graft (singularity/player-work.js graftStep, the guard that never interrupts a graft in progress), and how the
// reset rule (singularity/buy-augs.js) treats a graft: no install during one, no rep measured over one, cash kept for the waited batch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { DEFAULTS, STAT_GROUPS } from "/config.js";
import { loadConfig } from "/utils/config.js";
import { entropyStackCost, ENTROPY_EFFECT } from "/utils/aug-filter.js";
import { graftingApiFromInfo, graftNote, readGraftInProgress, PLAYER_WORK_STATE_PORT, GRAFT_NOTE_MAX_AGE_MS } from "/utils/grafting.js";
import { graftBudget, pickGraft, graftNetValue } from "/singularity/graft-plan.js";
import { main as scan } from "/singularity/workers/graft-scan.js";
import { main as start } from "/singularity/workers/graft-start.js";
import { graftStep, workStep } from "/singularity/player-work.js";
import { setAugConfig, decideReset, valueAt, repRates, graftReserve } from "/singularity/buy-augs.js";

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
	const stats = { "Cranium": { hacking: 2 }, "Weak": { hacking: 1.1 }, "Plain": {}, "Needs Cranium": { hacking: 2 }, "Owned": { hacking: 1.3 } };
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

// --- grafting and the reset rule (singularity/buy-augs.js) ---
// An install cancels a graft and the game keeps its price; a graft also takes the player off faction work, and the rep rates
// measured over it read near zero. Both used to end in a reset with the one augment that fit.

const HOUR = 3600_000;
const FLAT = { growth: 0, dampHours: 1.5, maxMult: 4, source: "flat", samples: 0 };
function resetContext(changes = {}) {
	setAugConfig(JSON.parse(JSON.stringify(DEFAULTS.augments)));
	return {
		queued: [], plan: [{ aug: "Fits", price: 5e9, value: 0.1 }], upcoming: [], cash: 6e9, homeCash: 6e9, income: 3e6, incomeModel: FLAT,
		sinceInstallMs: 2 * HOUR, neuroflux: null, favors: [], daedalus: null, push: null, endgame: null, ratesMeasured: true, ...changes,
	};
}
const grafting = (changes = {}) => ({ aug: "Cranium", seenAt: Date.now(), endsAt: Date.now() + HOUR, cost: 3e9, ...changes });

test("regression: no reset while the player is grafting, even for The Red Pill (an install cancels the graft and keeps its price)", () => {
	const plain = resetContext();
	assert.equal(decideReset(plain).reset, true, "premise: with nothing better ahead the rule resets with the one augment");
	const held = decideReset({ ...plain, graft: grafting({ endsAt: Date.now() + 45 * 60_000 }) });
	assert.equal(held.reset, false);
	assert.match(held.reason, /Grafting Cranium, about 45 min left/);
	const redPill = resetContext({ queued: ["The Red Pill"] });
	assert.equal(decideReset(redPill).reset, true, "premise: The Red Pill resets at once");
	assert.equal(decideReset({ ...redPill, graft: grafting({ endsAt: null, cost: null }) }).reset, false, "a graft started by hand is waited for too");
});

test("regression: rep isn't measured over time spent grafting; the rates from before the graft are kept and the snapshot starts again", () => {
	const ns = fakeNs({ overrides: { getResetInfo: () => ({ lastAugReset: 0 }) } });
	const previous = { rep: { F: 1000 }, time: Date.now() - 30 * 60_000, perSecond: { F: 5 } };
	const rep = new Map([["F", 1000]]); // no rep gained: the player was grafting
	const measured = repRates(ns, previous, rep);
	assert.equal(measured.perSecond.F, 0, "premise: measured over the graft the rate reads zero");
	for (const [label, kept] of [["grafting now", repRates(ns, previous, rep, true)], ["grafting at the last check", repRates(ns, { ...previous, grafting: grafting() }, rep, false)]]) {
		assert.deepEqual(kept.perSecond, { F: 5 }, `${label}: the pre-graft rate`);
		assert.ok(kept.snapshotTime > previous.time, `${label}: the next measurement starts now, after the graft`);
	}
});

test("a locked augment counts only with a measured rep rate: at zero (what a graft measured) the rule resets with what fits", () => {
	// What main builds from the rates: the locked augment's ETA and the favor rate. Kept rates keep the wait.
	const locked = (rate) => resetContext({
		upcoming: [{ aug: "Locked", price: 8e9, value: 0.3, etaMs: rate > 0 ? 1.5 * HOUR : null, faction: "F", missing: 1, repNeeded: 1 }],
		favors: [{ faction: "F", favor: 20, rep: 1e5, rate, repShare: 1 }],
	});
	assert.equal(decideReset(locked(20)).reset, false, "with the faction work's rate the rule waits for the locked augment");
	assert.equal(decideReset(locked(0)).reset, true, "with the graft's zero rate it resets with the one that fits: why repRates keeps the old rate");
});

test("graft reserve: while the rule waits, grafting leaves what that batch still needs from today's cash, never less than the batch that fits now", () => {
	const earned = (seconds) => 1e6 * seconds; // $1m/s
	const waiting = { reset: false, best: { inMinutes: 60, cost: 2e10 } };
	assert.equal(graftReserve(waiting, 5e9, earned), 2e10 - 3.6e9, "the batch's cost less an hour of income");
	assert.equal(graftReserve({ reset: false, best: { inMinutes: 600, cost: 2e10 } }, 5e9, earned), 5e9, "income covers it: the batch that fits now still counts");
	assert.equal(graftReserve({ reset: true, best: waiting.best }, 5e9, earned), 5e9, "resetting: only the batch bought now");
	assert.equal(graftReserve({ reset: false, best: null }, 5e9, earned), 5e9, "no later moment");
});

test("the reset rule's best later moment carries the cost of its augments (what the graft reserve protects)", () => {
	const ctx = resetContext({ upcoming: [{ aug: "Locked", price: 8e9, value: 0.3, etaMs: 1.5 * HOUR, faction: "F", missing: 1, repNeeded: 1 }] });
	const decision = decideReset(ctx);
	assert.equal(decision.reset, false);
	const later = valueAt(ctx, decision.best.inMinutes * 60_000);
	assert.ok(later.augs.includes("Locked"));
	assert.equal(decision.best.cost, Math.round(later.cost), "the batch at that moment, bought in price order");
});

test("regression: the graft scan protects the plan's graft reserve (the batch the reset waits for), not only the batch that fits now", async () => {
	const ns = scanWorld({ augs: ["Cranium"], plan: { checkedAt: Date.now(), cost: 5e9, graftReserve: 1.6e10 } });
	await scan(ns);
	assert.equal(ns.portJson(46).plannedCost, 1.6e10);
	assert.equal(pickGraft({ ...view(ns.portJson(46).candidates), cash: 2e10, plannedCost: ns.portJson(46).plannedCost }), null,
		"$20b - $16b x 1.25 leaves nothing for a $3b graft");
});

test("graft note: player-work notes a graft as it starts it, and the reset rule reads it from player-work's state until it goes stale", () => {
	const state = passState();
	graftStep(workWorld(), state, player({ city: "New Tokyo" }), true);
	assert.equal(state.grafting?.aug, "Cranium");
	assert.ok(Math.abs(state.grafting.endsAt - (state.graftTry.at + HOUR)) < 5, "ends after the candidate's hours");
	assert.equal(state.grafting.cost, 1e9);
	const ns = fakeNs({ ports: { [PLAYER_WORK_STATE_PORT]: { grafting: state.grafting, resetAt: 0 } } });
	assert.equal(readGraftInProgress(ns)?.aug, "Cranium");
	assert.equal(readGraftInProgress(ns, Date.now() + GRAFT_NOTE_MAX_AGE_MS + 1), null, "player-work stopped posting: no longer trusted");
	assert.equal(readGraftInProgress(fakeNs()), null, "nothing posted");
	assert.deepEqual(graftNote("Other", state.graftTry, 1), { aug: "Other", seenAt: 1, endsAt: null, cost: null }, "a graft started by hand: no end time or price");
});

// --- Entropy ---

test("game: a stack's cost is -ln(0.98) per unit of wanted-stat weight, so it follows the config's weights and income mix", () => {
	const augments = DEFAULTS.augments;
	const weights = augments.wantStats.flatMap((group) => Object.keys(STAT_GROUPS[group] ?? {}))
		.reduce((sum, key) => sum + (augments.resetRule.weights[key] ?? augments.resetRule.defaultWeight) * (augments.incomeFactors?.[key] ?? 1), 0);
	assert.ok(Math.abs(entropyStackCost(augments) - -Math.log(ENTROPY_EFFECT) * weights) < 1e-12);
	const hackingOnly = { ...augments, wantStats: ["hacking"] };
	assert.ok(entropyStackCost(hackingOnly) < entropyStackCost(augments), "fewer wanted stats, less to lose");
	assert.ok(entropyStackCost(augments) > 0.1, "with the default stats one stack costs about as much as a decent augmentation");
});

test("pick: an augmentation worth less than the Entropy stack it adds is not grafted, however cheap", () => {
	const weak = aug("Weak", { value: 0.15, entropyCost: 0.2 });
	const strong = aug("Strong", { value: 0.5, entropyCost: 0.2 });
	assert.equal(graftNetValue(strong), 0.5 - 0.2);
	assert.equal(pickGraft(view([weak])), null, "net -0.05");
	assert.equal(pickGraft(view([weak, strong])).name, "Strong");
	assert.equal(pickGraft(view([aug("Meh", { value: 0.22, entropyCost: 0.2 })])), null, "net 0.02 is under minValue");
});

test("pick: ranks by value net of Entropy per hour", () => {
	const big = aug("Big", { value: 0.6, entropyCost: 0.4, hours: 1 });   // net 0.2
	const small = aug("Small", { value: 0.3, entropyCost: 0.1, hours: 1 }); // net 0.2, the same hour: tie -> cheaper first
	const better = aug("Better", { value: 0.45, entropyCost: 0.1, hours: 1 }); // net 0.35
	assert.equal(pickGraft(view([big, small, better])).name, "Better");
});

function entropyWorld({ entropy, owned = [], augs = ["Cranium", "Congruity Implant"], config = null }) {
	const ns = scanWorld({ augs, owned });
	ns.getPlayer = () => ({ factions: ["Faction"], entropy });
	if (config) ns.write("data/config.json", JSON.stringify(config), "w");
	return ns;
}

test("scan: candidates carry the Entropy cost; with Congruity owned or queued it is 0", async () => {
	const ns = entropyWorld({ entropy: 19 });
	await scan(ns);
	const posted = ns.portJson(46);
	const cranium = posted.candidates.find((item) => item.name === "Cranium");
	assert.ok(Math.abs(cranium.entropyCost - entropyStackCost(loadConfig(ns).augments)) < 1e-12, "the loaded config (income mix applied) decides the weights");
	assert.equal(posted.entropy, 19);
	const safe = entropyWorld({ entropy: 0, owned: ["Congruity Implant"] });
	await scan(safe);
	assert.equal(safe.portJson(46).candidates.find((item) => item.name === "Cranium")?.entropyCost, 0, "no stack to add");
});

test("scan: the Congruity Implant is worth the stacks it clears, and nothing with no entropy to clear", async () => {
	const stacked = entropyWorld({ entropy: 19 });
	await scan(stacked);
	const congruity = stacked.portJson(46).candidates.find((item) => item.name === "Congruity Implant");
	assert.ok(Math.abs(congruity.value - 19 * entropyStackCost(loadConfig(stacked).augments)) < 1e-9, "19 stacks cleared");
	assert.equal(congruity.entropyCost, 0);
	const clean = entropyWorld({ entropy: 0 });
	await scan(clean);
	assert.equal(clean.portJson(46).candidates.some((item) => item.name === "Congruity Implant"), false, "nothing to clear");
});

test("regression: an augmentation worth less than the Entropy stack it adds is left out of the scan; grafting.entropy false (the kill switch) brings it back", async () => {
	const weighed = entropyWorld({ entropy: 0, augs: ["Weak"] });
	await scan(weighed);
	assert.deepEqual(weighed.portJson(46).candidates, [], "ln(1.1) is less than a stack's cost with the default stats");
	const ignored = entropyWorld({ entropy: 19, augs: ["Weak", "Congruity Implant"], config: { grafting: { entropy: false } } });
	await scan(ignored);
	const names = ignored.portJson(46).candidates.map((item) => item.name);
	assert.deepEqual(names, ["Weak"], "entropy ignored: Weak is back, and the Congruity Implant is worth nothing");
});
