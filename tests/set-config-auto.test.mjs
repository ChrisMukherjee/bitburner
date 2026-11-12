// tools/set-config.js `auto`: the one-word switch for bitnodeRouteAuto (alias autoroute) and the help text that lists it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { main as setConfig, describeAuto } from "/tools/set-config.js";
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
