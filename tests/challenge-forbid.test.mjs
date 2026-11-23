// Challenges that rule a mechanic out (CHALLENGES bn2, bn3, bn6, bn7, bn10; `forbid` in the config): the config they produce, the capability
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
import { corpAccess } from "/utils/corporation.js";
import { corpReady } from "/corp/ready.js";
import { main as setConfig } from "/tools/set-config.js";
import { rollChallenges, retireChallenges, nameChallenges, disarm } from "/utils/challenge.js";
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

test("corpAccess and corpReady: the BN3 challenge keeps a corporation from being made; one that exists is left alone", () => {
	const config = loadConfig(withChallenges(["bn3"], 3));
	assert.ok(forbids(config, "corporation"), "bn3 forbids it in BitNode 3");
	assert.ok(!forbids(loadConfig(withChallenges(["bn3"], 1)), "corporation"), "and nowhere else");
	const corpNs = (has) => fakeNs({
		money: 1e15,
		overrides: { getResetInfo: () => info(3), corporation: { hasCorporation: () => has, canCreateCorporation: () => (has ? "CorporationExists" : "Success") } },
	});
	const none = corpAccess(corpNs(false), config);
	assert.deepEqual([none.available, none.canCreate, none.forbidden], [false, false, true]);
	assert.match(none.why, /challenge/);
	assert.equal(corpReady(corpNs(false), config), false, "startup doesn't start the manager to create one");
	assert.equal(corpReady(corpNs(false), loadConfig(fakeNs())), true, "the same run without the challenge does");
	const made = corpAccess(corpNs(true), config);
	assert.deepEqual([made.available, made.hasCorp, !!made.forbidden], [true, true, false], "created already: the manager keeps running it");
	assert.equal(corpReady(corpNs(true), config), true);
	assert.equal(corpAccess(corpNs(false)).available, true, "no config passed: unchanged behaviour");
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
	assert.deepEqual([rolled.state.run, rolled.state.node, rolled.state.active], [2, 10, ["bn10", "bn1"]], "bn10 (named during the run) and bn1 (kept) apply now");
	assert.equal(rollChallenges({ run: 1, node: 7, active: ["bn7"] }, 2, 7, ["bn7"]).retired.length, 1, "the next run of the same BitNode retires it too");
});

test("rollChallenges: inside the same run nothing changes once records exist; a name with no record waits for the next run", () => {
	const settled = rollChallenges({ run: 5, node: 7, active: ["bn7"] }, 5, 7, ["bn7", "bn2"]).state;
	assert.deepEqual(settled.active, ["bn7"], "bn2 named mid-run (an older state file) is not active yet");
	const again = rollChallenges(settled, 5, 7, ["bn7", "bn2"]);
	assert.deepEqual([again.changed, again.retired, again.state.active], [false, [], ["bn7"]], "a second start in the same run changes nothing");
	const fresh = rollChallenges(null, 5, 7, ["bn7", "bn2"]);
	assert.deepEqual(fresh.state.active, [], "no state file: nothing says which run they were meant for, so they wait instead of applying (and retiring) now");
	assert.deepEqual(fresh.adopted, ["bn7", "bn2"], "and the player is told, so --now is one command away");
	assert.deepEqual(rollChallenges(fresh.state, 6, 7, ["bn7", "bn2"]).state.active, ["bn7", "bn2"], "the next run applies them");
	assert.deepEqual(activeChallenges(["bn7", "bn2"], null), ["bn7", "bn2"], "loadConfig with no state file at all (a server it wasn't copied to): all apply");
	assert.deepEqual(activeChallenges(["bn7", "bn2"], { active: ["bn7"] }), ["bn7"]);
});

test("nameChallenges: a new name waits; --now applies it at once; one that applies stays on and is marked to carry on", () => {
	const state = { run: 1, node: 7, active: [], named: {} };
	assert.deepEqual(nameChallenges(state, ["bn7"], false).state.active, [], "named mid-run: for the next run");
	const armed = nameChallenges(state, ["bn7"], true).state;
	assert.deepEqual(armed.active, ["bn7"], "--now: applies in this run");
	const again = nameChallenges(armed, ["bn7"], false);
	assert.deepEqual(again.already, ["bn7"]);
	assert.deepEqual(again.state.active, ["bn7"], "naming it again never stops an attempt that is going on");
	assert.equal(again.state.named.bn7.again, 1, "and marks it for the next run too");
	assert.deepEqual(disarm(again.state, ["bn7"]), { run: 1, node: 7, active: [], named: {} }, "clear takes it out at once");
});

// A start of startup.js in a run (getResetInfo().lastNodeReset is when the BitNode run started): it settles the challenges, then
// records the BitNode for loadConfig.
const runAt = (ns, run, node) => {
	ns.getResetInfo = () => ({ currentNode: node, lastNodeReset: run, ownedSF: new Map(), bitNodeOptions: {} });
	const retired = retireChallenges(ns, run, node);
	ns.write("data/bitnode.txt", String(node), "w");
	return retired;
};
const named = (ns) => JSON.parse(ns.files["data/config.json"]).challenges ?? [];
const challengeNs = (files = {}) => fakeNs({ files: { "data/config.json": "{}", ...files } });

test("regression: bn7 named during BitNode 7.1 (no state file yet) is still on and applies in 7.2", async () => {
	// The reported bug: the run-state code arrived mid-run, so 7.1 had no state file. The first start after that treated every named
	// challenge as applying in 7.1, and the end of 7.1 then retired bn7 as a finished attempt before the 7.2 run it was set for.
	const ns = challengeNs({ "data/bitnode.txt": "7" });
	ns.getResetInfo = () => ({ currentNode: 7, lastNodeReset: 100, ownedSF: new Map(), bitNodeOptions: {} });
	ns.args = ["challenge", "bn7"];
	await setConfig(ns);
	assert.deepEqual(named(ns), ["bn7"]);
	assert.ok(!forbids(loadConfig(ns), "bladeburner"), "7.1 is not the run it was named for");
	runAt(ns, 100, 7); // startup.js again in 7.1 (an augmentation install)
	assert.ok(!forbids(loadConfig(ns), "bladeburner"), "an install inside 7.1 doesn't start it either");
	assert.deepEqual(runAt(ns, 200, 7), [], "7.1 ends: bn7 was waiting, not tried, so it doesn't retire");
	assert.deepEqual(named(ns), ["bn7"], "still named in data/config.json");
	assert.ok(forbids(loadConfig(ns), "bladeburner"), "and applies in 7.2");
	assert.deepEqual(runAt(ns, 300, 1), ["bn7"], "7.2 ends: that was its run, so it retires");
});

test("regression: a challenge named by an older version (no state file) waits for the next run instead of retiring with this one", () => {
	const ns = challengeNs({ "data/config.json": JSON.stringify({ challenges: ["bn7"] }), "data/bitnode.txt": "7" });
	runAt(ns, 100, 7); // first start with records, in the middle of 7.1
	assert.ok(!forbids(loadConfig(ns), "bladeburner"));
	assert.match(ns.toasts.join("\n"), /challenge bn7 --now/, "the player is told how to apply it in this run if it is still clean");
	assert.deepEqual(runAt(ns, 200, 7), []);
	assert.ok(forbids(loadConfig(ns), "bladeburner"), "applies in 7.2");
});

test("regression: naming a challenge again while it applies carries it into the next run instead of retiring it", async () => {
	const ns = challengeNs({ "data/bitnode.txt": "7" });
	runAt(ns, 100, 7);
	ns.args = ["challenge", "bn7", "--now"];
	await setConfig(ns);
	assert.ok(forbids(loadConfig(ns), "bladeburner"), "--now: on in 7.1");
	ns.args = ["challenge", "bn7"]; // the player wants 7.2 too (7.1 joined the division by hand, say)
	await setConfig(ns);
	assert.ok(forbids(loadConfig(ns), "bladeburner"), "still on in 7.1: naming it again never lifts an attempt");
	assert.match(ns.terminal.join("\n"), /already applies in this run and carries on into the next run/);
	runAt(ns, 100, 7); // startup.js again inside 7.1 (an augmentation install) keeps the mark
	assert.deepEqual(runAt(ns, 200, 7), [], "7.1 ends: not retired");
	assert.ok(forbids(loadConfig(ns), "bladeburner"), "on in 7.2");
	assert.deepEqual(runAt(ns, 300, 7), ["bn7"], "7.2 ends without being named again: retired");
});

test("every retiring challenge: named in one run of its BitNode, it applies in the next and retires when that one ends", async () => {
	for (const [name, challenge] of Object.entries(CHALLENGES).filter(([, challenge]) => challenge.retire)) {
		const node = challenge.nodes[0];
		const ns = challengeNs({ "data/bitnode.txt": String(node) });
		runAt(ns, 100, node);
		ns.args = ["challenge", name];
		await setConfig(ns);
		const forbidden = challenge.settings.bitnodes[node].forbid[0];
		assert.ok(!forbids(loadConfig(ns), forbidden), `${name}: not in the run it was named in`);
		assert.deepEqual(runAt(ns, 200, node), [], `${name}: kept when that run ends`);
		assert.ok(forbids(loadConfig(ns), forbidden), `${name}: applies in the next run of BitNode ${node}`);
		assert.deepEqual(runAt(ns, 300, node), [name], `${name}: retires when the run it applied in ends`);
		assert.ok(!forbids(loadConfig(ns), forbidden), `${name}: the run after that plays normally`);
	}
});

test("a challenge named in another BitNode waits through runs of other BitNodes and retires only after its own", async () => {
	const ns = challengeNs({ "data/bitnode.txt": "10" });
	runAt(ns, 100, 10);
	ns.args = ["challenge", "bn6-7"];
	await setConfig(ns);
	assert.deepEqual(runAt(ns, 200, 1), [], "BitNode 10 ended: neither was about it");
	assert.deepEqual(runAt(ns, 300, 7), [], "BitNode 1 ended: neither was about it");
	assert.ok(forbids(loadConfig(ns), "bladeburner"), "bn7 applies in BitNode 7");
	assert.deepEqual(runAt(ns, 400, 6), ["bn7"], "BitNode 7 ended: bn7 retires, bn6 waits for BitNode 6");
	assert.ok(forbids(loadConfig(ns), "bladeburner"), "bn6 applies in BitNode 6");
	assert.deepEqual(runAt(ns, 500, 1), ["bn6"]);
	assert.deepEqual(named(ns), []);
});

test("bn1 doesn't retire: it stays on through every run until challenge clear", async () => {
	const ns = challengeNs({ "data/bitnode.txt": "1" });
	runAt(ns, 100, 1);
	ns.args = ["challenge", "bn1"];
	await setConfig(ns);
	assert.deepEqual(runAt(ns, 200, 1), []);
	assert.deepEqual(runAt(ns, 300, 1), []);
	assert.equal(loadConfig(ns).homeUpgrades.ram.maxGB, 128, "still capped in the third run");
	ns.args = ["challenge", "clear"];
	await setConfig(ns);
	assert.equal(loadConfig(ns).homeUpgrades.ram.maxGB, DEFAULTS.homeUpgrades.ram.maxGB, "clear lifts it at once");
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

test("challenge with no arguments lists the challenges in BitNode order", async () => {
	const ns = fakeNs({ overrides: { args: ["challenge"], getResetInfo: () => ({ currentNode: 1, lastNodeReset: 1, ownedSF: new Map() }) } });
	await setConfig(ns);
	const names = ns.terminal.filter((line) => /^(ON |NEXT|off) /.test(line)).map((line) => line.split(/\s+/)[1].replace(":", ""));
	const numbers = names.map((name) => parseInt(name.replace(/\D+/, ""), 10));
	assert.deepEqual(names.length, Object.keys(CHALLENGES).length, "every challenge is listed");
	assert.deepEqual(numbers, [...numbers].sort((first, second) => first - second), "bn1, bn2, bn6, bn7, bn10, not the order config.js happens to list them in");
});
