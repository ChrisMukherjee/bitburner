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
	SLEEVE_HOLD_PORT, MAX_COVENANT_SLEEVES, covenantSleeveCost, covenantAccess, sleeveHold, sleeveSaving, postSleeveHold, readSleeveHold,
	sleeveHoldReason, sleeveHoldsReset,
} from "/utils/sleeve-hold.js";
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

test("shop: no Covenant, no hold (a player out of reach of the invite is never kept waiting)", async () => {
	const sim = sleeveWorld({
		node: 10, sleeves: [{}], money: 1e9, sleeveCost: 5e12, memoryCost: 1e15,
		overrides: { getPlayer: () => ({ money: 1e9, factions: [], jobs: {}, karma: 0, skills: { hacking: 900, strength: 1, defense: 1, dexterity: 1, agility: 1 } }), getTotalScriptIncome: () => [1e9, 0] },
	});
	await shop(sim.ns);
	assert.equal(JSON.parse(sim.ns.ports[SLEEVE_HOLD_PORT]).hold, false);
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
