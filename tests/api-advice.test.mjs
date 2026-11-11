// utils/api-advice.js and tools/api-advice.js: what the scripts tell the player when an API or item a BitNode unlocks is missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { FEATURES, ADVICE_FILE, pickSource, missingApiAdvice, missingList, adviseOnce, adviseMissing, adviceSummary, requireApi } from "/utils/api-advice.js";
import { main as installAugs } from "/singularity/install-augs.js";
import { main as autoDestroy } from "/singularity/auto-destroy.js";
import { main as adviceTool } from "/tools/api-advice.js";
import { DEFAULTS } from "/config.js";

const info = (currentNode, owned = [], lastNodeReset = 1) => ({ currentNode, ownedSF: new Map(owned), lastNodeReset });

test("the advice names the BitNode to destroy and the Source-File level it gives, from what is owned", () => {
	const none = missingApiAdvice("singularity", info(1));
	assert.match(none, /Singularity API/);
	assert.match(none, /destroy BitNode 4 \(The Singularity\) for SF4\.1/);
	assert.match(none, /meanwhile|still runs/i, "says what the scripts do without it");
	assert.match(missingApiAdvice("bladeburner", info(1, [[6, 1]])), /destroy BitNode 7 \(Bladeburners 2079\) for SF7\.1/, "SF6 is owned, so the other source is named");
});

test("with several sources the plan's order decides; without a plan the listed order", () => {
	const node = info(1);
	assert.equal(pickSource([6, 7], node, []), 6);
	assert.equal(pickSource([6, 7], node, [{ bitNode: 7 }, { bitNode: 6 }]), 7);
	assert.equal(pickSource([6, 7], info(1, [[6, 1]]), []), 7, "a source already owned is not recommended");
	assert.equal(pickSource([4], info(1, [[4, 1]]), []), null);
});

test("a feature bought in the game says what to buy, and TOR first when it is missing", () => {
	assert.match(missingApiAdvice("formulas", info(1), { have: { tor: true } }), /buy Formulas\.exe/);
	assert.match(missingApiAdvice("formulas", info(1), { have: { tor: false } }), /TOR first/);
	assert.match(missingApiAdvice("formulas", info(1)), /BitNode 5/, "Source-File 5 gives it too");
});

test("a BitNode that forbids the API gets its reason and no recommendation to destroy anything", () => {
	const text = missingApiAdvice("bladeburner", info(6), { reason: "this BitNode's multipliers give no Bladeburner rank" });
	assert.match(text, /no Bladeburner rank/);
	assert.doesNotMatch(text, /Recommendation/);
});

test("missingList skips what is available and keeps the order of FEATURES", () => {
	const have = { singularity: true, multipliers: false, formulas: false, gang: true, bladeburner: { available: false, why: "needs BitNode 6 or 7 or Source-File 6 or 7" } };
	const ids = missingList(info(1), have, {}).map((entry) => entry.id);
	assert.deepEqual(ids, Object.keys(FEATURES).filter((id) => ["multipliers", "formulas", "bladeburner"].includes(id)));
	const bladeburner = missingList(info(1), have).find((entry) => entry.id === "bladeburner" || entry.id === "bladeburner");
	assert.match(bladeburner.text, /destroy BitNode 6/, "'needs BitNode 6 or 7' is the missing Source-File, so it still recommends one");
	assert.deepEqual(missingList(info(1), { singularity: true }), []);
});

test("adviseOnce prints each piece once per BitNode run, and again in a new run", () => {
	const ns = fakeNs();
	const entry = { id: "gang", text: missingApiAdvice("gang", info(1)) };
	assert.equal(adviseOnce(ns, [entry], info(1, [], 100), DEFAULTS).length, 1);
	assert.equal(adviseOnce(ns, [entry], info(1, [], 100), DEFAULTS).length, 0, "no repeat in the same run");
	assert.equal(ns.terminal.length, 1);
	assert.equal(adviseOnce(ns, [entry], info(1, [], 200), DEFAULTS).length, 1, "a new BitNode run says it again");
	assert.equal(ns.terminal.length, 2);
});

test("regression: the kill switch silences the advice and the status list", () => {
	const ns = fakeNs();
	const config = { ...DEFAULTS, missingApiAdvice: { enabled: false } };
	assert.deepEqual(adviseMissing(ns, "gang", info(1), config), []);
	assert.equal(ns.terminal.length, 0);
	assert.equal(ns.read(ADVICE_FILE), "");
});

test("default config turns the advice on", () => {
	assert.equal(DEFAULTS.missingApiAdvice.enabled, true);
});

test("the tool lists what is missing, prints it once, and drops what the player has since gained", async () => {
	/** @param {number[][]} owned @param {boolean} formulas */
	const run = (owned, formulas, files = {}) => fakeNs({
		files: { ...(formulas ? { "Formulas.exe": "" } : {}), ...files },
		overrides: {
			getResetInfo: () => ({ currentNode: 1, ownedSF: new Map(owned), lastNodeReset: 7, ownedAugs: new Map(), bitNodeOptions: {} }),
			hasTorRouter: () => true,
		},
	});
	const ns = run([], false);
	await adviceTool(ns);
	const saved = JSON.parse(ns.read(ADVICE_FILE));
	assert.deepEqual(saved.items.map((item) => item.id), ["singularity", "multipliers", "formulas", "gang", "bladeburner"]);
	assert.equal(ns.terminal.length, 5);
	await adviceTool(ns);
	assert.equal(ns.terminal.length, 5, "a second pass in the same run prints nothing new");
	// Source-File 4 and Formulas.exe arrive: those lines go away from the list.
	ns.write("Formulas.exe", "", "w");
	ns.getResetInfo = () => ({ currentNode: 1, ownedSF: new Map([[4, 1]]), lastNodeReset: 7, ownedAugs: new Map(), bitNodeOptions: {} });
	await adviceTool(ns);
	assert.deepEqual(JSON.parse(ns.read(ADVICE_FILE)).items.map((item) => item.id), ["multipliers", "gang", "bladeburner"]);
	assert.equal(ns.terminal.length, 5);
});

test("the status line is the label and the recommendation", () => {
	const line = adviceSummary(missingApiAdvice("singularity", info(1)));
	assert.match(line, /^Singularity API \(SF4\): destroy BitNode 4/);
});

test("the config's advice kill switch also stops the tool", async () => {
	const ns = fakeNs({ files: { "data/config.json": JSON.stringify({ missingApiAdvice: { enabled: false } }) }, overrides: { getResetInfo: () => { throw new Error("must not be called"); } } });
	await adviceTool(ns);
	assert.equal(ns.terminal.length, 0);
});

test("requireApi: true when available; otherwise says what to do every time it is asked, and the kill switch keeps only the fact", () => {
	const ns = fakeNs({ overrides: { getScriptName: () => "singularity/x.js" } });
	assert.equal(requireApi(ns, "singularity", true, info(1), DEFAULTS), true);
	assert.equal(ns.terminal.length, 0);
	assert.equal(requireApi(ns, "singularity", false, info(1), DEFAULTS), false);
	assert.equal(requireApi(ns, "singularity", false, info(1), DEFAULTS), false);
	assert.equal(ns.terminal.length, 2, "a script you run answers each time (no once-only dedupe)");
	assert.match(ns.terminal[0], /singularity\/x\.js.*destroy BitNode 4/);
	requireApi(ns, "singularity", false, info(1), { ...DEFAULTS, missingApiAdvice: { enabled: false } });
	assert.doesNotMatch(ns.terminal[2], /Recommendation/);
	assert.match(ns.terminal[2], /not available/);
});

test("regression: Singularity scripts started by hand without the API print the advice and stop instead of failing in the game", async () => {
	for (const main of [installAugs, autoDestroy]) {
		const ns = fakeNs({
			overrides: {
				getScriptName: () => "singularity/script.js", flags: () => ({ _: [] }),
				getResetInfo: () => ({ currentNode: 1, ownedSF: new Map(), lastAugReset: 0, lastNodeReset: 0, ownedAugs: new Map() }),
				singularity: new Proxy({}, { get: () => () => { throw new Error("must not touch ns.singularity"); } }),
			},
		});
		await main(ns);
		assert.equal(ns.terminal.length, 1);
		assert.match(ns.terminal[0], /Singularity API.*destroy BitNode 4/);
	}
});
