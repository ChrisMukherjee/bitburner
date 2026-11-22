// Challenges that rule a mechanic out (CHALLENGES bn2, bn6, bn7; `forbid` in the config): the config they produce, the capability
// helpers that report the mechanic as not available, what loadConfig drops with it, and retiring a challenge when its BitNode ends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { loadConfig } from "/utils/config.js";
import { DEFAULTS, CHALLENGES, CHALLENGE_GROUPS } from "/config.js";
import { forbids } from "/utils/forbid.js";
import { bladeburnerAccess } from "/utils/bladeburner.js";
import { gangAccess } from "/utils/gang.js";
import { bladeburnerReady } from "/bladeburner/ready.js";
import { gangReady } from "/gang/ready.js";
import { rollChallenges, retireChallenges, armNow, disarm } from "/utils/challenge.js";
import { CHALLENGE_STATE_FILE, activeChallenges } from "/utils/config.js";

const withChallenges = (challenges, node, extra = {}) => fakeNs({
	files: { "data/config.json": JSON.stringify({ challenges, ...extra }), "data/bitnode.txt": String(node) },
});
const info = (currentNode, sf = []) => ({ currentNode, ownedSF: new Map(sf.map((n) => [n, 1])), bitNodeOptions: {} });
const bbNs = (currentNode, sf = []) => fakeNs({ overrides: { getResetInfo: () => info(currentNode, sf) } });
const gangNs = (currentNode, sf = [], inGang = false) => fakeNs({
	overrides: { getResetInfo: () => info(currentNode, sf), gang: { inGang: () => inGang }, heart: { break: () => -60_000 } },
});

test("nothing is forbidden by default", () => {
	assert.deepEqual(DEFAULTS.forbid, [], "the default plays every mechanic");
	assert.deepEqual(loadConfig(fakeNs()).forbid, []);
});

test("every forbidding challenge forbids only in the BitNode it is about, and the group sets both Bladeburner ones", () => {
	for (const [name, challenge] of Object.entries(CHALLENGES)) {
		if (!challenge.settings.bitnodes) continue;
		for (const node of challenge.nodes ?? []) {
			assert.ok(challenge.settings.bitnodes[node]?.forbid?.length, `${name} must forbid something in BitNode ${node}`);
			assert.equal(challenge.retire, true, `${name} forbids a mechanic, so it must retire (a later run would be blocked silently)`);
		}
	}
	assert.deepEqual(CHALLENGE_GROUPS["bn6-7"], ["bn6", "bn7"]);
	assert.ok(forbids(loadConfig(withChallenges(["bn7"], 7)), "bladeburner"), "bn7 forbids the division in BitNode 7");
	assert.ok(!forbids(loadConfig(withChallenges(["bn7"], 6)), "bladeburner"), "but not in BitNode 6 (that is bn6's job)");
	assert.ok(!forbids(loadConfig(withChallenges(["bn6", "bn7"], 3)), "bladeburner"), "and not in any other BitNode");
	assert.ok(forbids(loadConfig(withChallenges(["bn6"], 6)), "bladeburner"));
	assert.ok(forbids(loadConfig(withChallenges(["bn2"], 2)), "gang"));
	assert.ok(!forbids(loadConfig(withChallenges(["bn2"], 2)), "bladeburner"), "the gang challenge leaves Bladeburner alone");
});

test("forbids accepts a config, a list or a bare name", () => {
	assert.ok(forbids({ forbid: ["gang"] }, "gang"));
	assert.ok(forbids(["gang"], "gang"));
	assert.ok(forbids("gang", "gang"));
	assert.ok(!forbids(null, "gang") && !forbids({}, "gang") && !forbids({ forbid: ["bladeburner"] }, "gang"));
});

test("bladeburnerAccess: a forbidding challenge makes the division not available, and says why", () => {
	assert.equal(bladeburnerAccess(bbNs(7)).available, true, "no config passed: unchanged behaviour");
	const config = loadConfig(withChallenges(["bn7"], 7));
	const access = bladeburnerAccess(bbNs(7), config);
	assert.equal(access.available, false);
	assert.equal(access.forbidden, true, "a challenge is the reason, so callers can skip the missing-API advice");
	assert.match(access.why, /challenge/);
	assert.equal(bladeburnerAccess(bbNs(1, [6]), loadConfig(withChallenges(["bn7"], 1))).available, true, "outside the BitNode the config forbids nothing");
});

test("bladeburnerAccess: without the API the reason is still the missing API, not the challenge", () => {
	const access = bladeburnerAccess(bbNs(1), { forbid: ["bladeburner"] });
	assert.equal(access.forbidden, false);
	assert.match(access.why, /needs BitNode 6 or 7/);
});

test("startup's ready checks: neither mechanic is started while a challenge forbids it", () => {
	const bb = loadConfig(withChallenges(["bn6"], 6));
	assert.equal(bladeburnerReady(bbNs(6), bb), false);
	assert.equal(bladeburnerReady(bbNs(6), loadConfig(fakeNs())), true, "the same run without the challenge starts it");
	const gang = loadConfig(withChallenges(["bn2"], 2));
	const ns = gangNs(2);
	ns.getPlayer = () => ({ factions: DEFAULTS.gang.factions });
	assert.equal(gangReady(ns, gang), false, "a gang faction is joined and the karma is there, yet no manager starts to form it");
	assert.equal(gangReady(ns, loadConfig(fakeNs())), true, "the same run without the challenge forms the gang");
});

test("gangAccess: forbidden until a gang exists; an existing gang is left alone", () => {
	const config = loadConfig(withChallenges(["bn2"], 2));
	const none = gangAccess(gangNs(2), config);
	assert.deepEqual([none.available, none.canCreate, none.forbidden], [false, false, true]);
	const formed = gangAccess(gangNs(2, [], true), config);
	assert.deepEqual([formed.available, formed.inGang, !!formed.forbidden], [true, true, false], "joined already: the manager keeps running it");
	assert.equal(gangAccess(gangNs(2)).available, true, "no config passed: unchanged behaviour");
});

test("loadConfig: forbidding Bladeburner sends the route to hacking and drops Bladeburner augments and sleeve jobs", () => {
	const custom = { augments: { wantStats: ["hacking", "bladeburner", "combat"] } };
	const config = loadConfig(withChallenges(["bn7"], 7, custom));
	assert.equal(config.bladeburner.route, "hacking");
	assert.deepEqual(config.augments.wantStats, ["hacking", "combat"], "only the Bladeburner group goes");
	assert.equal(config.sleeves.weights.bladeburner, 0);
	const elsewhere = loadConfig(withChallenges(["bn7"], 3, custom));
	assert.equal(elsewhere.bladeburner.route, DEFAULTS.bladeburner.route, "other BitNodes keep the default route");
	assert.ok(elsewhere.augments.wantStats.includes("bladeburner"));
});

test("loadConfig: forbidding gangs stops the start-stage invite and the sleeves' karma work", () => {
	const config = loadConfig(withChallenges(["bn2"], 2));
	assert.equal(config.gang.startInvite, false);
	assert.equal(config.sleeves.weights.karma, 0);
	const plain = loadConfig(withChallenges(["bn2"], 4));
	assert.equal(plain.gang.startInvite, DEFAULTS.gang.startInvite);
	assert.equal(plain.sleeves.weights.karma, DEFAULTS.sleeves.weights.karma);
});

test("loadConfig: bn10 forbids sleeve jobs and augmentations in BitNode 10 only, and keeps buying sleeves", () => {
	const config = loadConfig(withChallenges(["bn10"], 10));
	assert.ok(forbids(config, "sleeves"));
	assert.equal(config.sleeves.manage, false, "the manager gives no job, so no sleeve gains experience");
	assert.equal(config.sleeves.buy.augments, false);
	assert.equal(config.sleeves.buy.sleeves, DEFAULTS.sleeves.buy.sleeves, "owning sleeves is allowed, so the shop still buys them");
	assert.equal(config.sleeves.buy.memory, DEFAULTS.sleeves.buy.memory);
	const elsewhere = loadConfig(withChallenges(["bn10"], 4));
	assert.equal(elsewhere.sleeves.manage, DEFAULTS.sleeves.manage);
	assert.equal(elsewhere.sleeves.buy.augments, DEFAULTS.sleeves.buy.augments);
});

const state = (run, node, active) => JSON.stringify({ run, node, active });

test("a challenge set during a run waits for the next run (bn10 set in 10.1 for 10.2)", () => {
	// Run 1 of BitNode 10 started with no challenge; the player names bn10 during it.
	const files = { "data/config.json": JSON.stringify({ challenges: ["bn10"] }), "data/bitnode.txt": "10", [CHALLENGE_STATE_FILE]: state(1, 10, []) };
	const during = loadConfig(fakeNs({ files }));
	assert.ok(!forbids(during, "sleeves"), "set mid-run: nothing is forbidden yet, this run can't earn it anyway");
	assert.equal(during.sleeves.manage, DEFAULTS.sleeves.manage);
	// The next run starts (BitNode 10 again): startup rolls the state over and the challenge is active, not retired.
	const ns = fakeNs({ files });
	assert.deepEqual(retireChallenges(ns, 2, 10), []);
	assert.deepEqual(JSON.parse(ns.files[CHALLENGE_STATE_FILE]).active, ["bn10"]);
	assert.ok(forbids(loadConfig(ns), "sleeves"), "from the start of the next run");
});

test("rollChallenges: a challenge that was active in the run that ended retires; one named later stays and starts", () => {
	const names = ["bn7", "bn10", "bn1"];
	const rolled = rollChallenges({ run: 1, node: 7, active: ["bn7", "bn1"] }, 2, 10, names);
	assert.deepEqual(rolled.retired, ["bn7"], "bn7 was active in the BitNode 7 run that ended");
	assert.deepEqual(rolled.names, ["bn10", "bn1"]);
	assert.deepEqual(rolled.state, { run: 2, node: 10, active: ["bn10", "bn1"] }, "bn10 (named during the run) and bn1 (kept) apply now");
	assert.equal(rollChallenges({ run: 1, node: 7, active: ["bn7"] }, 2, 7, ["bn7"]).retired.length, 1, "the next run of the same BitNode retires it too");
});

test("rollChallenges: inside the same run nothing changes, and with no saved state everything applies", () => {
	const same = rollChallenges({ run: 5, node: 7, active: ["bn7"] }, 5, 7, ["bn7", "bn2"]);
	assert.deepEqual([same.changed, same.retired, same.state.active], [false, [], ["bn7"]], "bn2 named mid-run is not active yet");
	const fresh = rollChallenges(null, 5, 7, ["bn7", "bn2"]);
	assert.deepEqual(fresh.state.active, ["bn7", "bn2"], "an older save (no state file) keeps its challenges");
	assert.deepEqual(fresh.retired, []);
	assert.deepEqual(activeChallenges(["bn7", "bn2"], null), ["bn7", "bn2"], "no state: all apply");
	assert.deepEqual(activeChallenges(["bn7", "bn2"], { active: ["bn7"] }), ["bn7"]);
});

test("--now makes it apply in this run, and naming or clearing it again takes it back out", () => {
	assert.deepEqual(armNow({ run: 1, node: 7, active: [] }, ["bn7"]).active, ["bn7"]);
	assert.deepEqual(disarm({ run: 1, node: 7, active: ["bn7", "bn1"] }, ["bn7"]).active, ["bn1"]);
	assert.equal(armNow(null, ["bn7"]), null, "no state file: nothing to arm, everything already applies");
});

test("clearing a challenge applies at once, even mid-run", () => {
	const files = { "data/config.json": JSON.stringify({ challenges: [] }), "data/bitnode.txt": "7", [CHALLENGE_STATE_FILE]: state(1, 7, ["bn7"]) };
	assert.ok(!forbids(loadConfig(fakeNs({ files })), "bladeburner"), "the config no longer names it");
});

test("retireChallenges: takes it out of data/config.json, keeps the rest, and tells the player how to retry", () => {
	const ns = fakeNs({ files: { "data/config.json": JSON.stringify({ challenges: ["bn7", "bn1"], startupSkip: ["x.js"] }), [CHALLENGE_STATE_FILE]: state(1, 7, ["bn7", "bn1"]) } });
	assert.deepEqual(retireChallenges(ns, 2, 10), ["bn7"]);
	const saved = JSON.parse(ns.files["data/config.json"]);
	assert.deepEqual(saved.challenges, ["bn1"]);
	assert.deepEqual(saved.startupSkip, ["x.js"], "other overrides survive");
	assert.match(ns.toasts.join("\n"), /challenge bn7/, "the toast says how to go for it again");
	assert.deepEqual(retireChallenges(ns, 2, 10), [], "a second start inside the same run changes nothing");
	const broken = fakeNs({ files: { "data/config.json": "{ nope" } });
	assert.deepEqual(retireChallenges(broken, 2, 10), []);
	assert.equal(broken.files["data/config.json"], "{ nope", "a file that isn't JSON is never rewritten");
});
