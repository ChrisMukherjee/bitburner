// singularity/buy-programs.js: the buying order (the darknet program moves up once home can run the darknet)
// and a pass of the buyer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { loadConfig } from "/utils/config.js";
import { programOrder, main } from "/singularity/buy-programs.js";

const names = (list) => list.map((program) => program.name);
const DEFAULT_ORDER = ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe", "HTTPWorm.exe", "SQLInject.exe", "DarkscapeNavigator.exe", "Formulas.exe"];
const EARLY_DARKNET = ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe", "HTTPWorm.exe", "DarkscapeNavigator.exe", "SQLInject.exe", "Formulas.exe"];
const settings = loadConfig(fakeNs());

test("small home: port openers first, the darknet program after them", () => {
	assert.deepEqual(names(programOrder(64, settings)), DEFAULT_ORDER);
});

test("home as big as the darknet stage: the darknet program comes before SQLInject", () => {
	const mid = settings.startupStages.mid;
	assert.deepEqual(names(programOrder(mid, settings)), EARLY_DARKNET);
	assert.deepEqual(names(programOrder(mid / 2, settings)), DEFAULT_ORDER);
});

test("the threshold can be set, and a huge one keeps the old order", () => {
	assert.deepEqual(names(programOrder(32, { programs: { darknetFirstHomeRam: 32 } })), EARLY_DARKNET);
	assert.deepEqual(names(programOrder(4096, { programs: { darknetFirstHomeRam: 1e9 } })), DEFAULT_ORDER);
});

test("without any settings the old order stays", () => {
	assert.deepEqual(names(programOrder(4096, {})), DEFAULT_ORDER);
});

/** A game where TOR is owned and the programs in `owned` are on home; programs cost their darkweb price. */
function buyerNs({ money, homeRam, owned }) {
	const files = new Set(owned);
	const costs = { "BruteSSH.exe": 500e3, "FTPCrack.exe": 1.5e6, "relaySMTP.exe": 5e6, "HTTPWorm.exe": 30e6, "SQLInject.exe": 250e6, "DarkscapeNavigator.exe": 50e6, "Formulas.exe": 5e9 };
	const ns = fakeNs({
		money,
		overrides: {
			getServerMaxRam: () => homeRam,
			hasTorRouter: () => true,
			fileExists: (name) => files.has(name),
			singularity: {
				getDarkwebProgramCost: (name) => costs[name],
				purchaseProgram: (name) => { if (costs[name] > money) return false; money -= costs[name]; files.add(name); return true; },
			},
		},
	});
	return ns;
}
const FIRST_FOUR = ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe", "HTTPWorm.exe"];

test("big home with $70m: buys the darknet program, not SQLInject", async () => {
	const ns = buyerNs({ money: 70e6, homeRam: 128, owned: FIRST_FOUR });
	await main(Object.assign(ns, { flags: () => ({ once: true }) }));
	assert.deepEqual(ns.called("singularity.purchaseProgram"), [["DarkscapeNavigator.exe"]]);
});

test("small home with $70m: waits for SQLInject and buys nothing", async () => {
	const ns = buyerNs({ money: 70e6, homeRam: 32, owned: FIRST_FOUR });
	await main(Object.assign(ns, { flags: () => ({ once: true }) }));
	assert.equal(ns.called("singularity.purchaseProgram").length, 0);
});
