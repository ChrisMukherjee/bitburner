// utils/bitnode-route.js: which BitNode comes next (your route, else the plan's suggestion), and the default plan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { DEFAULTS } from "/config.js";
import { nextRouteStep, suggestedStep, routeStep, easeScore } from "/utils/bitnode-route.js";
import { main as setConfig } from "/tools/set-config.js";
import { main as saveBitnodeMults } from "/tools/save-bitnode-mults.js";

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

/**
 * Plays a plan from a new save: in each BitNode, destroys it and enters the BitNode the plan suggests, until the plan is
 * done. Returns the BitNodes entered after the first BitNode 1, in order, and the Source-File levels owned at the end.
 */
function playPlan(plan, saved = null) {
	let node = 1;
	const owned = new Map();
	const entered = [];
	for (let step = suggestedStep(inNode(node, []), plan, saved); step; step = suggestedStep(inNode(node, [...owned]), plan, saved)) {
		owned.set(node, (owned.get(node) ?? 0) + 1); // the destroy
		node = step.bitNode;
		entered.push(node);
		assert.ok(entered.length < 200, "the plan never ends");
	}
	owned.set(node, (owned.get(node) ?? 0) + 1); // the last destroy
	return { entered, owned };
}

/** The default plan after the first BitNode 1 (docs/bitnode-order.md), multiplier-only levels in the listed order. */
const DEFAULT_ORDER = [
	1, // SF1.2
	4, 4, 4,
	5,
	1, // SF1.3
	2,
	6,
	10, 10, 10,
	7, 7, 7,
	3, 3, 3,
	9, 9, 9,
	5, 5, 2, 2, 6, 6, // levels 2 and 3 that only raise multipliers
	14, 14, 14,
	15, 15, 15,
	8, 8, 8,
	13, 13, 13,
	11, 11, 11,
];

test("default plan: a new save goes through every Source-File in the documented order, then BitNode 12", () => {
	const { entered, owned } = playPlan(DEFAULTS.bitnodePlan);
	assert.deepEqual(entered.slice(0, DEFAULT_ORDER.length), DEFAULT_ORDER);
	assert.deepEqual(new Set(entered.slice(DEFAULT_ORDER.length)), new Set([12]), "only BitNode 12 after BitNode 11");
	for (let bitNode = 1; bitNode <= 15; bitNode++) {
		assert.equal(owned.get(bitNode), bitNode === 12 ? 50 : 3, `Source-File ${bitNode} at the end`);
	}
	// The rules the order rests on.
	const first = (bitNode) => entered.indexOf(bitNode);
	assert.ok([2, 5, 6].every((bitNode) => first(4) < first(bitNode)), "Singularity (SF4.3) first after SF1.2");
	assert.ok([10, 9, 13].every((bitNode) => first(6) < first(bitNode)), "Bladeburner, a way out without hacking, before 10, 9 and 13");
	assert.ok(first(10) < first(7), "sleeves before BitNode 7");
});

test("default plan: levels 2 and 3 of BitNodes 5, 2 and 6 share a tier, so with Source-File 5 the easiest goes first", () => {
	const sixEasiest = mults({ 6: { ScriptHackMoney: 2 }, 5: { ScriptHackMoney: 0.5 }, 2: { ScriptHackMoney: 0.25 } });
	const { entered } = playPlan(DEFAULTS.bitnodePlan, sixEasiest);
	const start = DEFAULT_ORDER.indexOf(9) + 3;
	assert.deepEqual(entered.slice(start, start + 6), [6, 6, 5, 5, 2, 2]);
	// Every other step has a tier of its own, so the multipliers leave it where it is.
	assert.deepEqual(entered.slice(0, start), DEFAULT_ORDER.slice(0, start));
	assert.deepEqual(entered.slice(start + 6, DEFAULT_ORDER.length), DEFAULT_ORDER.slice(start + 6));
});

test("regression: afk-route takes BitNode 15 (it stopped at 14)", async () => {
	const ns = fakeNs({ overrides: { args: ["route", "15:3"] } });
	await setConfig(ns);
	assert.deepEqual(JSON.parse(ns.files["data/config.json"]).bitnodeRoute, [{ bitNode: 15, level: 3 }]);
	const tooBig = fakeNs({ overrides: { args: ["route", "16:1"] } });
	await setConfig(tooBig);
	assert.equal(tooBig.files["data/config.json"], undefined, "nothing saved");
	assert.match(tooBig.terminal.join("\n"), /ERROR "16:1"/);
});

test("regression: the multipliers of BitNode 15 are saved for the plan's suggestion (it stopped at 14)", async () => {
	const ns = fakeNs({
		files: { "data/bitnode.txt": "6" },
		overrides: {
			getBitNodeMultipliers: (n = 6) => {
				if (n < 1 || n > 15) throw new Error(`Invalid BitNode: ${n}.`);
				return { ScriptHackMoney: n };
			},
			getHostname: () => "home",
		},
	});
	await saveBitnodeMults(ns);
	const saved = JSON.parse(ns.files["data/bitnode-mults.json"]);
	assert.deepEqual(Object.keys(saved.others).map(Number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
	assert.equal(saved.others[15].ScriptHackMoney, 15);
});
