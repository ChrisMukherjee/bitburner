// What an augmentation install keeps and what it wipes (docs/install-persistence.md): the route model's faction rep
// (bladeburner/route-model.js) and the cash install-augs.js spends on what survives (singularity/install-augs.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { loadConfig } from "/utils/config.js";
import { projectRoute, favorToRep, repToFavor, DONATE_REP } from "/bladeburner/route-model.js";
import { leftoverBuyers } from "/singularity/install-augs.js";

// One strong aug whose rep (120k) is about 4.5 runs of work (each run earns about 26.5k at favor 0)
const hackingRun = ({ rep = {}, augs, hackRoute = {}, maxRuns = 8 } = {}) => ({
	augs: augs ?? [{ name: "Big", price: 1e9, rep: 1.2e5, f: ["F"], h: 1.3, e: 1, cs: [1, 1, 1, 1] }], nf: null, installed: 31, runHours: 4,
	income: 3e9, expRate: 6e4, mult: { hacking: 1.24, hackExp: 1, combat: [1, 1, 1, 1], combatExp: 1 }, scenario: { income: 0, exp: 0 }, maxRuns,
	rep: { facMult: 1, bn: 1, timeShare: 0.7, ...rep },
	hackRoute: { required: 6000, daedalusAugs: 99, daedalusMoney: 1e11, daedalusHack: 2500, rpRep: 2.5e6, rpPrice: 1e10, rpHeld: false, startStage: 0, ...hackRoute },
});
const runOf = (result, aug) => result.log.find((entry) => entry.names.includes(aug))?.run ?? Infinity;

test("favor formulas match the game: 150 favor is the donation line, about 462k rep", () => {
	assert.ok(Math.abs(favorToRep(150) - DONATE_REP) < 1e-6);
	assert.ok(Math.abs(repToFavor(favorToRep(81.3)) - 81.3) < 1e-9);
	assert.ok(Math.abs(DONATE_REP - 462_500) < 1000);
});

test("route model: faction rep restarts at every install, so an aug needs its rep inside one run", () => {
	const kept = projectRoute("hacking", hackingRun({ rep: { resetOnInstall: false } }));
	const real = projectRoute("hacking", hackingRun());
	assert.equal(runOf(kept, "Big"), 5, "the old model added up rep across installs: bought once 5 runs' rep summed to 120k");
	assert.equal(runOf(real, "Big"), Infinity, "one run never earns 120k at this rate, and favor alone hasn't reached the donation line in 8 runs");
	// The rep still turns into favor at each install, so favor climbs run by run
	const favors = real.log.map((entry) => entry.favor.F);
	assert.ok(favors.every((value, index) => index === 0 || value > favors[index - 1]), `favor grows every install: ${favors.map(Math.round)}`);
	assert.ok(favors[0] > 30 && favors[0] < 45, "26.5k rep is about 37 favor");
});

test("route model: favor speeds rep up and opens donations, so today's favor matters", () => {
	const none = projectRoute("hacking", hackingRun());
	const some = projectRoute("hacking", hackingRun({ rep: { favor: { F: 100 } } }));
	const line = projectRoute("hacking", hackingRun({ rep: { favor: { F: 150 } } }));
	assert.ok(runOf(some, "Big") < runOf(none, "Big"), "100 favor reaches the donation line within the modelled runs");
	assert.equal(runOf(line, "Big"), 1, "at 150 favor the missing rep is bought with money in the first run");
	assert.equal(runOf(projectRoute("hacking", hackingRun({ rep: { favor: { F: 150 }, donateFavor: 200 } })), "Big") > 1, true, "the line comes from getFavorToDonate");
});

test("route model: today's rep counts in the first modelled run only", () => {
	const now = projectRoute("hacking", hackingRun({ rep: { now: { F: 1e5 } } }));
	assert.equal(runOf(now, "Big"), 1, "100k held + one run's rep reach 120k");
	const later = projectRoute("hacking", hackingRun({ augs: [{ name: "Big", price: 1e9, rep: 1.2e5, f: ["F"], h: 1.3, e: 1, cs: [1, 1, 1, 1] }, { name: "Huge", price: 2e9, rep: 2.5e5, f: ["F"], h: 1.5, e: 1, cs: [1, 1, 1, 1] }], rep: { now: { F: 1e5 } } }));
	assert.ok(runOf(later, "Huge") > 2, "the 100k held this run doesn't carry into the next one");
});

test("route model: Daedalus rep for The Red Pill restarts too, needs the invite again each run, and favor speeds it up", () => {
	// Daedalus joined now, 2.5m rep for The Red Pill, about 26.5k rep a run: both models get there through 150 favor and a donation
	const cfg = (rep, hackRoute = {}) => ({ ...hackingRun({ rep, hackRoute: { startStage: 1, required: 500, daedalusHack: 100, ...hackRoute }, maxRuns: 400 }), augs: [] });
	const kept = projectRoute("hacking", cfg({ resetOnInstall: false }));
	const real = projectRoute("hacking", cfg({}));
	assert.equal(kept.reached, true);
	assert.equal(real.reached, true);
	assert.ok(real.runs < kept.runs, `favor speeds up each run's rep, so the donation line comes sooner: ${real.runs} runs, old model ${kept.runs}`);
	// The invite needs hacking 2500 again after every install: a run that can't reach it earns no Daedalus rep at all
	const gated = projectRoute("hacking", cfg({}, { daedalusHack: 2500 }));
	const gatedOld = projectRoute("hacking", cfg({ resetOnInstall: false }, { daedalusHack: 2500 }));
	assert.equal(gatedOld.reached, true, "the old model kept earning Daedalus rep without the invite");
	assert.equal(gated.reached, false);
	const donating = projectRoute("hacking", cfg({ favor: { Daedalus: 150 } }));
	assert.equal(donating.reached, true);
	assert.ok(donating.hours < 20, "150 Daedalus favor: the rep is bought with money in the first run");
});

test("route model: rep already held for The Red Pill counts only in the run that holds it", () => {
	const cfg = { ...hackingRun({ hackRoute: { startStage: 1, required: 1000, rpHeld: true, rpPrice: 1e14 }, maxRuns: 3 }), augs: [] };
	const result = projectRoute("hacking", cfg);
	assert.ok(result.log.every((entry) => entry.note !== "Red Pill bought"), "too poor in run 1, and the held rep is gone after the install");
});

test("persistence config: on by default, with kill switches", () => {
	const config = loadConfig(fakeNs());
	assert.deepEqual(config.persistence, { routeRepResets: true, spendLeftover: true });
});

test("leftoverBuyers: stock access (unless the trader is skipped), then gang equipment; nothing when switched off", () => {
	assert.deepEqual(leftoverBuyers({ startupSkip: [] }), [["stocks/workers/buy-market-access.js", 0, "--4s"], ["gang/workers/spend-leftover.js", 0]]);
	assert.deepEqual(leftoverBuyers({ startupSkip: ["stocks/stock-trader.js"] }), [["gang/workers/spend-leftover.js", 0]], "no trader, no market access");
	assert.deepEqual(leftoverBuyers({ persistence: { spendLeftover: false }, startupSkip: [] }), []);
	assert.equal(leftoverBuyers(loadConfig(fakeNs())).length, 2, "default config");
});
