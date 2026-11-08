// utils/bitnode-route.js: which BitNode comes next (your route, else the plan's suggestion).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { nextRouteStep, suggestedStep, routeStep, easeScore } from "/utils/bitnode-route.js";

/** In BitNode `node`, owning these Source-File levels ([[1, 3], [4, 1]] ...). */
const inNode = (node, owned) => fakeNs({ overrides: { getResetInfo: () => ({ currentNode: node, ownedSF: new Map(owned) }) } });
/** Saved multipliers for other BitNodes (utils/bitnode-mults.js shape). */
const mults = (others) => ({ known: true, get: () => 1, other: (bitNode) => others[bitNode] ?? null });

test("the route counts the level that destroying this BitNode gives", () => {
	const route = [{ bitNode: 1, level: 3 }, { bitNode: 4, level: 1 }];
	assert.deepEqual(nextRouteStep(inNode(1, [[1, 1]]), route), { bitNode: 1, level: 3 });
	assert.deepEqual(nextRouteStep(inNode(1, [[1, 2]]), route), { bitNode: 4, level: 1 }); // this destroy makes SF1.3
	assert.equal(nextRouteStep(inNode(4, [[1, 3]]), route), null);
});

test("easeScore: easier multipliers score higher; unknown is 0", () => {
	assert.equal(easeScore(null), 0);
	assert.ok(easeScore({ ScriptHackMoney: 2 }) > 0);
	assert.ok(easeScore({ AugmentationMoneyCost: 3 }) < 0);
	assert.ok(Math.abs(easeScore({ ScriptHackMoney: 2, AugmentationMoneyCost: 2 })) < 1e-12);
});

test("the plan's suggestion takes the first open tier, easiest BitNode first when multipliers are known", () => {
	const plan = [{ bitNode: 1, level: 1, tier: 1 }, { bitNode: 5, level: 1, tier: 2 }, { bitNode: 2, level: 1, tier: 2 }];
	const ns = inNode(1, []);
	assert.equal(suggestedStep(ns, plan, null).bitNode, 5, "no multipliers: listed order");
	const easierTwo = mults({ 2: { ScriptHackMoney: 2 }, 5: { ScriptHackMoney: 0.5 } });
	assert.equal(suggestedStep(ns, plan, easierTwo).bitNode, 2);
	assert.equal(suggestedStep(inNode(2, [[1, 1], [5, 1]]), plan, null), null);
});

test("routeStep: your own route first; once it's done, no suggestion overrides it", () => {
	const config = { bitnodeRoute: [{ bitNode: 4, level: 1 }], bitnodePlan: [{ bitNode: 2, level: 1, tier: 1 }], bitnodeRouteAuto: true };
	assert.equal(routeStep(inNode(1, [[1, 1]]), config, null).source, "route");
	assert.equal(routeStep(inNode(4, [[1, 1]]), config, null), null);
	const auto = routeStep(inNode(1, [[1, 1]]), { ...config, bitnodeRoute: [] }, null);
	assert.deepEqual([auto.bitNode, auto.source], [2, "suggested"]);
	assert.equal(routeStep(inNode(1, [[1, 1]]), { ...config, bitnodeRoute: [], bitnodeRouteAuto: false }, null).source, "suggestion-only");
});
