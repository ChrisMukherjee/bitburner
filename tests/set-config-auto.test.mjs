// tools/set-config.js `auto`: the one-word switch for bitnodeRouteAuto (alias autoroute) and the help text that lists it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { main as setConfig, describeAuto, routeClearedText } from "/tools/set-config.js";
import { loadConfig } from "/utils/config.js";
import { DEFAULTS } from "/config.js";

const run = (args, files = {}) => {
	const ns = fakeNs({ files, overrides: { args } });
	return setConfig(ns).then(() => ns);
};

test("auto on writes bitnodeRouteAuto true, and loadConfig sees it", async () => {
	const ns = await run(["auto", "on"]);
	assert.equal(JSON.parse(ns.files["data/config.json"]).bitnodeRouteAuto, true);
	assert.equal(loadConfig(ns).bitnodeRouteAuto, true, "the saved file must change the merged config");
});

test("auto off writes false and keeps the player's other overrides", async () => {
	const ns = await run(["auto", "off"], { "data/config.json": JSON.stringify({ bitnodeRouteAuto: true, startupSkip: ["x.js"] }) });
	const saved = JSON.parse(ns.files["data/config.json"]);
	assert.equal(saved.bitnodeRouteAuto, false);
	assert.deepEqual(saved.startupSkip, ["x.js"], "other overrides survive");
});

test("auto alone shows the state and writes nothing", async () => {
	const ns = await run(["auto"]);
	assert.equal("data/config.json" in ns.files, false);
	assert.match(ns.terminal.join("\n"), DEFAULTS.bitnodeRouteAuto ? /ON/ : /OFF/, "reports the default when nothing is set");
});

test("auto with a bad word changes nothing", async () => {
	const ns = await run(["auto", "maybe"]);
	assert.equal("data/config.json" in ns.files, false);
	assert.match(ns.terminal.join("\n"), /ERROR/);
});

test("auto says when the player's own route outranks the plan", () => {
	const mine = { bitnodeRoute: [{ bitNode: 4, level: 3 }] };
	assert.match(describeAuto(mine, "on").text, /own route.*then the plan carries on/, "auto on: the plan continues after the route");
	assert.match(describeAuto(mine, "off").text, /then you pick/);
	assert.match(describeAuto({}, "on").text, /plan decides/);
});

test("the help lists auto and the alias name players type", async () => {
	const ns = await run([]);
	assert.match(ns.terminal.join("\n"), /auto on \/ auto off/, "set-config with no args must mention the auto route");
	assert.match(ns.terminal.join("\n"), /afk-route/);
});

test("choice: the auto route is on by default, so a fresh save follows the plan without being told", () => {
	assert.equal(DEFAULTS.bitnodeRouteAuto, true, "automation is the default; autoroute off is the opt-out");
	assert.equal(loadConfig(fakeNs()).bitnodeRouteAuto, true);
});

test("regression: route clear doesn't claim auto-destroy waits when the auto route is on", async () => {
	const on = await run(["route", "clear"]);
	const text = on.terminal.join("\n");
	assert.equal(DEFAULTS.bitnodeRouteAuto, true);
	assert.doesNotMatch(text, /waits for you/, "the default has auto on, so the plan decides");
	assert.match(text, /follows the plan/);
	const off = await run(["route", "clear"], { "data/config.json": JSON.stringify({ bitnodeRouteAuto: false }) });
	assert.match(off.terminal.join("\n"), /waits for you.*autoroute on/, "auto off: say what to run");
});

test("route clear warns when startup.js is told to skip auto-destroy", () => {
	assert.match(routeClearedText({ startupSkip: ["singularity/auto-destroy.js"] }), /startupSkip/);
	assert.doesNotMatch(routeClearedText({ startupSkip: [] }), /startupSkip/);
});

const resetInfo = (currentNode, owned) => ({ getResetInfo: () => ({ currentNode, ownedSF: new Map(owned) }) });
const runPlan = (info, files = {}) => {
	const ns = fakeNs({ files, overrides: { args: ["route", "plan"], ...info } });
	return setConfig(ns).then(() => ns.terminal.join("\n"));
};

test("route plan lists every plan step, marks the done ones and the next one", async () => {
	const text = await runPlan(resetInfo(1, [[1, 1]]));
	const lines = text.split("\n");
	for (const step of DEFAULTS.bitnodePlan) assert.ok(text.includes(`BN${step.bitNode}`) && text.includes(`level ${step.level}`), `step ${step.bitNode}:${step.level} must be listed`);
	assert.match(lines.find((line) => /tier\s+1 /.test(line)), /^ {2}ok /, "owning SF1.1 marks the first step done");
	const next = lines.filter((line) => line.includes(">>") && line.includes("tier"));
	assert.equal(next.length, 1, "one open step in the lowest open tier is marked next");
	assert.match(next[0], /BN4 +-> level 3/, "in BitNode 1 with SF1.1 owned, destroying gives SF1.2, so the next open step is tier 3 (BN4)");
});

test("route plan says whether your route overrides the plan and whether auto is on", async () => {
	const none = await runPlan(resetInfo(1, []));
	assert.match(none, /No bitnodeRoute of your own: the plan decides/);
	assert.match(none, DEFAULTS.bitnodeRouteAuto ? /Auto route is ON/ : /Auto route is OFF/);
	const own = await runPlan(resetInfo(1, []), { "data/config.json": JSON.stringify({ bitnodeRoute: [{ bitNode: 4, level: 3 }], bitnodeRouteAuto: false }) });
	assert.match(own, /overrides the plan.*then you pick/s);
	assert.match(own, /Auto route is OFF/);
});

test("route plan uses the player's own bitnodePlan", async () => {
	const text = await runPlan(resetInfo(5, []), { "data/config.json": JSON.stringify({ bitnodePlan: [{ bitNode: 7, level: 1, tier: 1 }] }) });
	assert.match(text, /1 steps/);
	assert.match(text, /BN7 /);
	assert.doesNotMatch(text, /BN12/);
});

test("an empty route's one-line answer points at route plan", async () => {
	const ns = await run(["route"]);
	assert.match(ns.terminal.join("\n"), /afk-route plan/);
});
