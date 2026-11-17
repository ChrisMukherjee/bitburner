// utils/sleeve-hold.js: keeping BitNode 10 open for the Covenant's sleeves (the shop decides, auto-destroy, auto-reset and the spenders obey).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fakeNs } from "./support/fake-ns.mjs";
import { sleeveWorld } from "./support/fake-sleeves.mjs";
import { DEFAULTS, CHALLENGES } from "/config.js";
import { loadConfig } from "/utils/config.js";
import { getBudget } from "/utils/spending.js";
import {
	SLEEVE_HOLD_PORT, MAX_COVENANT_SLEEVES, COVENANT_SKILL, covenantSleeveCost, covenantAccess, covenantGap, sleeveHold, sleeveSaving, postSleeveHold,
	readSleeveHold, sleeveHoldReason, sleeveHoldsReset, sleeveTrainFloor,
} from "/utils/sleeve-hold.js";
import { workStep, covenantStep } from "/singularity/player-work.js";
import { main as shop } from "/sleeves/sleeve-shop.js";
import { main as manage } from "/sleeves/sleeve-manager.js";

const HOUR = 3600_000;
/** A decision input: the next sleeve costs 10t, cash 1t, income 1b/s (a 9,000 s wait), a run that has taken 10 h. */
const view = (extra = {}) => ({ cost: 10e12, cash: 1e12, income: 1e9, runMs: 10 * HOUR, access: "member", canBuy: true, ...extra });
/** A fake ns that has the shop's last decision on port 45. */
const withDecision = (decision, time = Date.now()) => fakeNs({ ports: { [SLEEVE_HOLD_PORT]: { time, ...decision } } });

test("game: a Covenant sleeve costs 10t, then ten times more for each one bought, five in all", () => {
	assert.deepEqual([0, 1, 2, 3, 4].map(covenantSleeveCost), [10e12, 100e12, 1e15, 10e15, 100e15]);
	assert.equal(MAX_COVENANT_SLEEVES, 5);
	assert.equal(covenantSleeveCost(5), Infinity, "none left after the fifth");
	assert.equal(covenantSleeveCost(-1), Infinity);
});

test("game: the Covenant is open to members, and to a player whose hacking and every combat skill reach 850", () => {
	const skills = { hacking: 850, strength: 850, defense: 850, dexterity: 850, agility: 850 };
	assert.equal(covenantAccess({ factions: ["The Covenant"] }), "member");
	assert.equal(covenantAccess({ factions: [], skills }), "reachable");
	assert.equal(covenantAccess({ factions: [], skills: { ...skills, agility: 849 } }), "no");
	assert.equal(covenantAccess({}), "no", "a player with no skills listed is not close");
});

test("hold: the next sleeve is worth waiting for when it is affordable within the time this run has already taken", () => {
	const near = sleeveHold(view());
	assert.equal(near.hold, true, "9,000 s of a 10 h run");
	assert.ok(Math.abs(near.etaMs - 9e12 / 1e9 * 1000) < 1, "the wait is the missing cash over the income");
	const far = sleeveHold(view({ runMs: 1000 })); // a run only a second old: nothing is worth waiting a day for
	assert.equal(far.hold, false);
	const limit = view().runMs;
	assert.equal(sleeveHold(view({ income: 9e12 / (limit / 1000) * 1.01 })).hold, true, "just inside the run's length");
	assert.equal(sleeveHold(view({ income: 9e12 / (limit / 1000) * 0.99 })).hold, false, "just outside it");
});

test("hold: the allowed wait scales with the run's age and `runShare`", () => {
	const slow = view({ income: 1e8 }); // 90,000 s = 25 h of waiting, in a 10 h run
	assert.equal(sleeveHold(slow).hold, false);
	assert.equal(sleeveHold(slow, { runShare: 3 }).hold, true, "a player who accepts waiting three runs' length");
	assert.equal(sleeveHold({ ...slow, runMs: 30 * HOUR }).hold, true, "the same price is worth it in a longer run");
});

test("hold: an affordable sleeve is held for at once, and an unaffordable one with no measured income is not", () => {
	const now = sleeveHold(view({ cash: 11e12, runMs: 0 }));
	assert.equal(now.hold, true, "the shop buys it on its next pass");
	assert.equal(now.etaMs, 0);
	const unknown = sleeveHold(view({ income: 0 }));
	assert.equal(unknown.hold, false);
	assert.equal(unknown.etaMs, null);
});

test("hold: no hold outside BitNode 10, with every sleeve bought, out of reach of the Covenant, or with the kill switch off", () => {
	assert.equal(sleeveHold(view({ canBuy: false })).hold, false);
	assert.equal(sleeveHold(view({ cost: Infinity })).hold, false);
	assert.equal(sleeveHold(view({ access: "no" })).hold, false);
	assert.equal(sleeveHold(view(), { enabled: false }).hold, false);
	assert.equal(sleeveHold(view({ access: "reachable" })).hold, true, "joining the Covenant first is part of the wait");
	assert.match(sleeveHold(view({ access: "reachable" })).reason, /joins The Covenant/);
});

test("hold: each sleeve is judged at its own price, so the dearer ones need far more income to be held for", () => {
	const income = 1e9;
	const holds = [0, 1, 2, 3, 4].map((bought) => sleeveHold(view({ cost: covenantSleeveCost(bought), cash: 0, income })).hold);
	assert.deepEqual(holds, [true, false, false, false, false], "10t is 3 h of 1b/s, 100t is 28 h: past this 10 h run");
	const rich = [0, 1, 2, 3, 4].map((bought) => sleeveHold(view({ cost: covenantSleeveCost(bought), cash: 0, income: 1e12 })).hold);
	assert.deepEqual(rich, [true, true, true, true, false], "with 1t/s the first four fit (the fifth, $100q, is 28 h away)");
});

test("saving: the sleeve's whole price is kept once the cash has reached `progress` of it, not before", () => {
	const decision = { hold: true, cost: 10e12 };
	assert.equal(sleeveSaving(decision, 4e12, { progress: 0.5 }), 0, "investing in income still shortens the wait");
	assert.equal(sleeveSaving(decision, 5e12, { progress: 0.5 }), 10e12);
	assert.equal(sleeveSaving({ ...decision, progress: 0.8 }, 5e12), 0, "the posted `progress` is used when the caller gives none");
	assert.equal(sleeveSaving({ hold: false, cost: 10e12 }, 9e12), 0, "nothing is kept without a hold");
	assert.equal(sleeveSaving(null, 9e12), 0);
});

test("port: the decision is read back while recent, and ignored when old or missing", () => {
	const ns = fakeNs();
	assert.equal(readSleeveHold(ns), null, "nothing posted");
	postSleeveHold(ns, { hold: true, cost: 10e12, etaMs: 5, reason: "x" });
	assert.equal(readSleeveHold(ns).hold, true);
	assert.equal(readSleeveHold(ns, Date.now() + 11 * 60_000), null, "a decision from a shop that stopped is not trusted");
});

test("auto-destroy: while the shop says hold the BitNode is kept open, and the kill switch or a stale decision releases it", () => {
	const ns = withDecision({ hold: true, cost: 10e12, reason: "the next sleeve is near" });
	assert.match(sleeveHoldReason(ns, DEFAULTS.sleeves.hold), /^holding BitNode 10 for a Covenant sleeve: the next sleeve is near/);
	assert.equal(sleeveHoldReason(ns, { enabled: false }), "", "kill switch");
	assert.equal(sleeveHoldReason(withDecision({ hold: false, cost: 10e12, reason: "far" }), DEFAULTS.sleeves.hold), "");
	assert.equal(sleeveHoldReason(withDecision({ hold: true, cost: 10e12 }, Date.now() - 20 * 60_000), DEFAULTS.sleeves.hold), "", "stale");
	assert.equal(sleeveHoldReason(fakeNs(), DEFAULTS.sleeves.hold), "", "no shop, no hold: scripts without the Sleeve API are not held");
});

test("auto-reset: an install that would wipe cash saved for a sleeve waits; an affordable sleeve or too little saved does not", () => {
	const ns = withDecision({ hold: true, cost: 10e12, reason: "near" });
	const rule = DEFAULTS.sleeves.hold;
	assert.match(sleeveHoldsReset(ns, rule, 6e12), /saving for a Covenant sleeve/);
	assert.equal(sleeveHoldsReset(ns, rule, 1e12), "", "less than half-way: the install's gains are worth more");
	assert.equal(sleeveHoldsReset(ns, rule, 10e12), "", "affordable: the install's spend-all buys the sleeve first");
	assert.equal(sleeveHoldsReset(ns, { ...rule, enabled: false }, 6e12), "", "kill switch");
});

test("spending: the hacknet and server managers leave cash saved for a sleeve alone", () => {
	const policy = { reserve: 1e6, maxFraction: 1 };
	const money = 6e12;
	const plain = fakeNs({ overrides: { getPlayer: () => ({ money }), getTotalScriptIncome: () => [0, 0] } });
	assert.equal(getBudget(plain, policy), money - policy.reserve, "no hold: as before");
	const holding = fakeNs({ ports: { [SLEEVE_HOLD_PORT]: { time: Date.now(), hold: true, cost: 10e12 } }, overrides: { getPlayer: () => ({ money }), getTotalScriptIncome: () => [0, 0] } });
	assert.equal(getBudget(holding, policy), 0, "6t is past half-way to a 10t sleeve, so none of it is spendable");
	const early = fakeNs({ ports: { [SLEEVE_HOLD_PORT]: { time: Date.now(), hold: true, cost: 10e12 } }, overrides: { getPlayer: () => ({ money: 1e12 }), getTotalScriptIncome: () => [0, 0] } });
	assert.equal(getBudget(early, policy), 1e12 - policy.reserve, "before half-way spending on income goes on");
});

test("default config: the hold is on, with a kill switch, and the manager runs", () => {
	assert.equal(DEFAULTS.sleeves.hold.enabled, true);
	assert.ok(DEFAULTS.sleeves.hold.runShare > 0 && DEFAULTS.sleeves.hold.progress > 0 && DEFAULTS.sleeves.hold.progress <= 1);
	assert.equal(DEFAULTS.sleeves.manage, true);
});

// --- the shop posts the decision ---

test("shop in BitNode 10: after buying what it can, it posts whether the next sleeve is worth holding for", async () => {
	const sim = sleeveWorld({
		node: 10, sleeves: [{}], money: 1e9, sleeveCost: 5e12, memoryCost: 1e15,
		overrides: { getPlayer: () => ({ money: 1e9, factions: ["The Covenant"], jobs: {}, karma: 0, skills: {} }), getTotalScriptIncome: () => [1e9, 0] },
	});
	await shop(sim.ns);
	const posted = JSON.parse(sim.ns.ports[SLEEVE_HOLD_PORT]);
	assert.equal(posted.hold, true, "5t is about 83 min of 1b/s, inside the run's length");
	assert.equal(posted.cost, 5e12);
	assert.equal(posted.progress, DEFAULTS.sleeves.hold.progress);
	assert.match(sim.ns.logs.join("\n"), /Holding BitNode 10/);
});

test("shop: out of the Covenant's reach (no skills to train, or none the gym can raise), no hold and the reason names what is missing", async () => {
	const sim = sleeveWorld({
		node: 10, sleeves: [{}], money: 1e9, sleeveCost: 5e12, memoryCost: 1e15,
		overrides: { getPlayer: () => ({ money: 1e9, factions: [], jobs: {}, karma: 0, skills: { hacking: 100, strength: 900, defense: 900, dexterity: 900, agility: 900 } }), getTotalScriptIncome: () => [1e9, 0] },
	});
	await shop(sim.ns);
	const posted = JSON.parse(sim.ns.ports[SLEEVE_HOLD_PORT]);
	assert.equal(posted.hold, false);
	assert.equal(posted.train, false);
	const hackingOnly = sleeveHold(view({ access: "no", missing: [{ name: "hacking", have: 400 }] }));
	assert.equal(hackingOnly.hold, false, "the gym can't raise hacking");
	assert.equal(hackingOnly.train, false);
	assert.match(hackingOnly.reason, /hacking 400/, "the reason says which skill is short");
});

// --- the Covenant invite needs combat skills: the player trains for them while the sleeve is worth it ---

const SHORT = [{ name: "strength", have: 120 }, { name: "defense", have: 90 }, { name: "dexterity", have: 300 }, { name: "agility", have: 849.9 }];

test("regression: a rich player short only of combat skill is asked to train for the Covenant, not left with a silent shop", () => {
	// $71q cash, the first sleeves cost $10t, $100t, $1q: all affordable, but the invite wants every combat skill at 850.
	const decision = sleeveHold(view({ access: "no", cash: 71e15, missing: SHORT }));
	assert.equal(decision.train, true, "the gym is the way to the invite");
	assert.equal(decision.floor, COVENANT_SKILL);
	assert.equal(decision.hold, true, "the BitNode stays open while the training is within a new run's length");
	assert.equal(decision.etaMs, 0);
	assert.match(decision.reason, /strength 120/);
});

test("train: not worth it when the sleeve is far away, the income unknown, or the rule off; hacking short trains but does not hold", () => {
	assert.equal(sleeveHold(view({ access: "no", cash: 0, income: 1e3, missing: SHORT })).train, false, "the price is days of income away");
	assert.equal(sleeveHold(view({ access: "no", cash: 0, income: 0, missing: SHORT })).train, false, "no measured income");
	assert.equal(sleeveHold(view({ access: "no", cash: 71e15, missing: SHORT }), { enabled: false }).train, false, "kill switch");
	const both = sleeveHold(view({ access: "no", cash: 71e15, missing: [...SHORT, { name: "hacking", have: 700 }] }));
	assert.equal(both.train, true);
	assert.equal(both.hold, false, "hacking comes with the run: not worth keeping the BitNode open for");
	assert.equal(sleeveHold(view({ access: "member", cash: 71e15 })).train, false, "a member needs nothing trained");
});

test("train: the hold ends once the training has taken longer than a new BitNode 10 run would (it cannot stall the route for good)", () => {
	const input = { access: "no", cash: 71e15, missing: SHORT };
	assert.equal(sleeveHold(view({ ...input, trainingMs: 9 * HOUR })).hold, true);
	const late = sleeveHold(view({ ...input, trainingMs: 11 * HOUR })); // the run has taken 10 h
	assert.equal(late.hold, false);
	assert.equal(late.train, true, "the player may still train, the BitNode is just no longer held");
});

test("covenantGap lists the skills under 850", () => {
	assert.deepEqual(covenantGap({ skills: { hacking: 850, strength: 849.9, defense: 900, dexterity: 1, agility: 850 } }), [{ name: "strength", have: 849 }, { name: "dexterity", have: 1 }]);
	assert.deepEqual(covenantGap({}), [], "no skills listed: nothing known");
});

test("shop: a rich player short of combat skill posts train, keeps the start time while training, and says so in its log", async () => {
	const skills = { hacking: 900, strength: 120, defense: 90, dexterity: 300, agility: 400 };
	const sim = sleeveWorld({
		node: 10, sleeves: [{}], money: 71e15, sleeveCost: 10e12, memoryCost: 1e18,
		overrides: { getPlayer: () => ({ money: 71e15, factions: [], jobs: {}, karma: 0, skills }), getTotalScriptIncome: () => [1e9, 0] },
	});
	sim.ns.sleeve.purchaseSleeve = () => ({ success: false, message: "You must be a member of The Covenant" }); // as the game does
	await shop(sim.ns);
	const first = JSON.parse(sim.ns.ports[SLEEVE_HOLD_PORT]);
	assert.equal(first.train, true);
	assert.equal(first.floor, COVENANT_SKILL);
	assert.equal(typeof first.since, "number");
	assert.match(sim.ns.logs.join("\n"), /training strength 120/);
	await shop(sim.ns);
	assert.equal(JSON.parse(sim.ns.ports[SLEEVE_HOLD_PORT]).since, first.since, "the start time is kept while the training goes on");
});

test("shop: when the game refuses an affordable sleeve it says why in its log instead of failing silently", async () => {
	const sim = sleeveWorld({
		node: 10, sleeves: [{}], money: 71e15, sleeveCost: 10e12, memoryCost: 1e18,
		overrides: { getPlayer: () => ({ money: 71e15, factions: [], jobs: {}, karma: 0, skills: {} }), getTotalScriptIncome: () => [1e9, 0] },
	});
	sim.ns.sleeve.purchaseSleeve = () => ({ success: false, message: "You must be a member of The Covenant" });
	await shop(sim.ns);
	assert.match(sim.ns.logs.join("\n"), /refused sleeve #1.*member of The Covenant/);
});

test("player-work: while the shop says train, the lowest combat stat goes to the gym toward 850; off or stale, nothing is started", () => {
	const player = { city: "Sector-12", money: 1e12, factions: [], jobs: {}, karma: 0, numPeopleKilled: 0, skills: { hacking: 900, strength: 120, defense: 90, dexterity: 300, agility: 400 } };
	const world = (decision, time = Date.now()) => fakeNs({
		ports: decision ? { [SLEEVE_HOLD_PORT]: { time, ...decision } } : {},
		overrides: { singularity: { gymWorkout: () => true, travelToCity: () => true, getCurrentWork: () => null } },
	});
	const state = () => ({ config: JSON.parse(JSON.stringify(DEFAULTS)), focus: false, holdCity: false });
	assert.equal(sleeveTrainFloor(world({ train: true, floor: 850 }), DEFAULTS.sleeves.hold), 850);
	const ns = world({ train: true, floor: COVENANT_SKILL });
	assert.match(covenantStep(ns, state(), player, null), /\[covenant\] training def/, "the lowest stat first");
	assert.deepEqual(ns.called("singularity.gymWorkout").map((call) => call[1]), ["def"]);
	const off = world({ train: true, floor: COVENANT_SKILL });
	const stopped = state();
	stopped.config.sleeves.hold.enabled = false;
	assert.equal(covenantStep(off, stopped, player, null), null, "kill switch");
	assert.equal(covenantStep(world({ train: false }), state(), player, null), null, "nothing asked");
	assert.equal(covenantStep(world({ train: true, floor: COVENANT_SKILL }, Date.now() - 20 * 60_000), state(), player, null), null, "a stale post is ignored");
	assert.equal(covenantStep(world(null), state(), player, null), null, "no shop, nothing asked");
	const there = { ...player, skills: { ...player.skills, strength: 850, defense: 850, dexterity: 850, agility: 850 } };
	assert.equal(covenantStep(world({ train: true, floor: COVENANT_SKILL }), state(), there, null), null, "every skill is there: join-factions.js takes the invite");
});

test("player-work: the Covenant's gym comes before faction work in a full pass, and the pass is not done while it is asked", () => {
	const player = { city: "Sector-12", money: 1e12, factions: ["CyberSec"], jobs: {}, karma: 0, numPeopleKilled: 0, skills: { hacking: 900, strength: 120, defense: 90, dexterity: 300, agility: 400 } };
	const ns = fakeNs({
		ports: { [SLEEVE_HOLD_PORT]: { time: Date.now(), train: true, floor: COVENANT_SKILL } },
		overrides: {
			getResetInfo: () => ({ currentNode: 10, ownedSF: new Map(), ownedAugs: new Map(), lastAugReset: 0 }),
			singularity: { getCurrentWork: () => null, getFactionRep: () => 0, getCompanyRep: () => 1e9, workForFaction: () => true, gymWorkout: () => true, travelToCity: () => true, commitCrime: () => 3000, stopAction: () => true, applyToCompany: () => "", workForCompany: () => true },
			getScriptRam: () => 1,
		},
	});
	const result = workStep(ns, {
		config: JSON.parse(JSON.stringify(DEFAULTS)), focus: false, holdCity: false, studyLevel: 50, noCompany: true,
		goals: { CyberSec: { rep: 1e6, aug: "X", count: 1, skipped: 0 } }, gangDone: true, travelDone: true,
	}, player);
	assert.match(result.message, /\[covenant\]/);
	assert.equal(ns.called("singularity.workForFaction").length, 0, "faction work waits for the gym");
	assert.equal(result.done, false);
});

test("shop outside BitNode 10 posts nothing, so nothing there is ever held", async () => {
	const sim = sleeveWorld({ node: 1, sourceFiles: [[10, 1]], sleeves: [{}], money: 1e9 });
	await shop(sim.ns);
	assert.equal(SLEEVE_HOLD_PORT in sim.ns.ports, false);
});

test("regression: the sleeve hold is wired into auto-destroy, auto-reset (never for The Red Pill) and the spending helper", () => {
	const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
	assert.match(read("singularity/auto-destroy.js"), /sleeveHoldReason\(ns, config\.sleeves\?\.hold\)/, "auto-destroy asks before it destroys");
	assert.match(read("singularity/auto-reset.js"), /!ready\.includes\(RED_PILL\)\s*\?\s*sleeveHoldsReset/, "the reset that installs The Red Pill is never held");
	assert.match(read("utils/spending.js"), /sleeveSaving\(readSleeveHold\(ns\)/, "getBudget keeps the saved cash");
});

// --- the BN10 challenge ---

test("BN10 challenge: the manager gives no sleeve a job and the shop buys no augmentation, only in BitNode 10", () => {
	const challenged = (node) => loadConfig(fakeNs({ files: { "data/config.json": JSON.stringify({ challenges: ["bn10"] }), "data/bitnode.txt": String(node) } }));
	assert.ok(CHALLENGES.bn10, "listed, so `challenge bn10` finds it");
	assert.equal(challenged(10).sleeves.manage, false);
	assert.equal(challenged(10).sleeves.buy.augments, false);
	assert.equal(challenged(10).sleeves.buy.sleeves, true, "owning idle sleeves is allowed, so the hold still works");
	assert.equal(challenged(1).sleeves.manage, true, "other BitNodes keep their sleeves working");
});

test("BN10 challenge: with manage off, the manager does nothing at all (no job, no experience)", async () => {
	const sim = sleeveWorld({ node: 10, sleeves: [{}, {}], files: { "data/config.json": JSON.stringify({ sleeves: { manage: false } }) } });
	await manage(sim.ns);
	assert.equal(sim.apiLog.length, 0, "not one Sleeve API call");
});
