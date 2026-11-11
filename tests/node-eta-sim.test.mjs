// bladeburner/node-eta.js main, run the way startup.js runs it (every few minutes, on any server), against the Bladeburner simulator
// (tests/support/fake-bladeburner.mjs) that also plays bb-pass.js, so the route estimate reads the live readings and rank samples
// the real passes leave on port 36. These check what the runs promise together: the exp rate it measures and drops at an install,
// the income history it keeps across runs, the plan it posts for bb-manage.js (route, hold with its hysteresis, daemon level), the
// first-guess commit, a failed estimate, and running off home. tests/bladeburner.test.mjs checks pickRoute, committedRoute and the model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bladeburnerSim, START } from "./support/fake-bladeburner.mjs";
import { main as play } from "/bladeburner/bb-pass.js";
import { main as eta } from "/bladeburner/node-eta.js";
import { postBladeburner } from "/bladeburner/state.js";

const port = (sim) => sim.ns.portJson(36);
const report = (sim) => sim.ns.read("data/node-eta.txt");
const history = (sim) => JSON.parse(sim.ns.read("data/node-eta-history.json") || "[]");
const line = (text, pattern) => text.split("\n").find((row) => pattern.test(row));
const MIN = 60_000;
const HARSH = { BladeburnerRank: 0.05, BladeburnerSkillCost: 3 }; // a BitNode that nerfs Bladeburner hard
const nodeFiles = (node, mults) => ({ "data/bitnode.txt": String(node), "data/bitnode-mults.json": JSON.stringify({ node, mults }) });

/** A BitNode 6 player with Singularity: hacking 242 of the daemon's 400, Daedalus joined with the Red Pill's rep, so hacking finishes. */
function world({ files = {}, route = {}, ...options } = {}) {
	const sim = bladeburnerSim({
		rank: 10, income: 5e7, actions: { Tracking: { count: 2000 } }, config: options.config ?? {},
		route: { node: 6, expRate: 300, exp: 1e6, factions: ["CyberSec", "Daedalus"], rep: { Daedalus: 3e6 }, server: { requiredHackingSkill: 400 }, ...route },
		...options,
	});
	for (const [name, text] of Object.entries(files)) sim.ns.files[name] = text;
	return sim;
}

test("without the Singularity or the Bladeburner API it says so and writes nothing", async () => {
	const noBladeburner = world({ route: { node: 1, ownedSF: new Map([[4, 3]]) } });
	await noBladeburner.etaRuns(eta);
	assert.match(noBladeburner.ns.logs.join("\n"), /needs the Singularity and Bladeburner APIs/);
	assert.equal(noBladeburner.ns.read("data/node-eta.txt"), "");
	assert.equal(port(noBladeburner).plan, undefined);
	const noSingularity = world({ route: { node: 6, ownedSF: new Map() } });
	await noSingularity.etaRuns(eta);
	assert.match(noSingularity.ns.logs.join("\n"), /needs the Singularity and Bladeburner APIs/);
	assert.equal(port(noSingularity).plan, undefined);
});

test("a first run, before bb-pass.js has read anything: a report, a plan with no route yet, and the debug lines", async () => {
	const sim = world({ post: {} });
	const text = await sim.etaRuns(eta);
	assert.match(text, /BitNode 6\n/, "the header names the BitNode");
	assert.match(text, /Hacking 242\/400; multiplier 1\.00; exp rate still measuring/);
	assert.match(text, /Red Pill: rep 3000000\/2500000/);
	assert.match(text, /Bladeburner: no live readings yet|first guess/);
	assert.match(text, /\(computed in \d+ ms\)\n$/);
	const plan = port(sim).plan;
	assert.equal(plan.route, undefined, "no live readings and no clear first guess: the config route applies");
	assert.equal(plan.hold, false);
	assert.equal(plan.daemonLevel, 400, "the live server's requirement");
	assert.equal(plan.time, sim.now());
	const pass = sim.ns.portJson(37)["bladeburner/node-eta.js"];
	assert.ok(pass.lines.length > 0 && pass.lines.every((row) => /^(Hacking, |Bladeburner, |RECOMMENDED|Bladeburner "run"|Confidence)/.test(row)), pass.lines.join("|"));
});

test("game: before the daemon exists its level is 3000 times the BitNode's difficulty (BitNode 6: 6000, BitNode 13: 9000)", async () => {
	const six = world({ route: { server: null } });
	await six.etaRuns(eta);
	assert.equal(port(six).plan.daemonLevel, 6000);
	const thirteen = world({ route: { node: 13, ownedSF: new Map([[4, 3], [6, 1]]), server: null } });
	await thirteen.etaRuns(eta);
	assert.equal(port(thirteen).plan.daemonLevel, 9000);
});

test("the hacking exp rate is measured over the run's samples: none for the first two minutes, then the real rate", async () => {
	const sim = world();
	let text = await sim.etaRuns(eta, 2, MIN); // samples 1 minute apart
	assert.match(text, /exp rate still measuring/);
	text = await sim.etaRuns(eta, 2, MIN);
	assert.match(text, /exp rate 300\.0\/s/, "300 exp a second, as the simulator trains");
});

test("the exp samples keep the last 30 minutes, and start over after an install or when exp falls", async () => {
	const sim = world();
	await sim.etaRuns(eta, 20, 2 * MIN);
	const samples = port(sim).eta.samples;
	assert.ok(samples.every((sample) => sim.now() - sample.t < 30 * MIN + 2 * MIN), "nothing older than half an hour (plus the run in progress)");
	assert.ok(samples.length >= 14 && samples.length <= 16, `${samples.length} samples`);
	const stamp = port(sim).eta.stamp;
	assert.equal(stamp, String(sim.resetAt));
	sim.resetAt = sim.now(); // augmentations installed
	sim.hackExp = 5e5;
	await sim.etaRuns(eta, 1);
	assert.equal(port(sim).eta.samples.length, 1, "a new run measures from scratch");
	assert.equal(port(sim).eta.stamp, String(sim.resetAt), "the samples belong to the new run");
	sim.hackExp = 1000; // exp fell without a new stamp (a reset the game did not announce)
	await sim.etaRuns(eta, 1, 2 * MIN);
	assert.deepEqual(port(sim).eta.samples.map((sample) => sample.exp), [1000], "samples from a higher exp are not a rate");
});

test("the income history: one entry per run, the best income of the run, the latest multiplier; none while income or level is missing", async () => {
	const sim = world();
	await sim.etaRuns(eta, 1);
	assert.deepEqual(history(sim).map((entry) => [entry.stamp, entry.mult, entry.income]), [[String(sim.resetAt), 1, 5e7]]);
	sim.income = 2e7; // a dip later in the same run: the best is kept
	await sim.etaRuns(eta, 1, 2 * MIN);
	assert.equal(history(sim).length, 1);
	assert.equal(history(sim)[0].income, 5e7);
	sim.income = 8e7;
	await sim.etaRuns(eta, 1, 2 * MIN);
	assert.equal(history(sim)[0].income, 8e7);
	sim.resetAt = sim.now();
	await sim.etaRuns(eta, 1, 2 * MIN);
	assert.equal(history(sim).length, 2, "a new run is a new entry");
	const none = world();
	none.income = 0;
	await none.etaRuns(eta, 1);
	assert.equal(none.ns.read("data/node-eta-history.json"), "", "no income: nothing to record");
	const lowLevel = world({ route: { exp: 0 } });
	await lowLevel.etaRuns(eta, 1);
	assert.equal(lowLevel.ns.read("data/node-eta-history.json"), "", "hacking level under 10: income is not the multiplier's");
});

test("the income history keeps the last 30 runs", async () => {
	const old = Array.from({ length: 30 }, (_, i) => ({ stamp: `old${i}`, t: i, mult: 1 + i / 100, income: 1e6 * (i + 1) }));
	const sim = world({ files: { "data/node-eta-history.json": JSON.stringify(old) } });
	await sim.etaRuns(eta, 1);
	const kept = history(sim);
	assert.equal(kept.length, 30);
	assert.equal(kept[0].stamp, "old1", "the oldest is dropped");
	assert.equal(kept.at(-1).stamp, String(sim.resetAt));
});

test("income growth: claimed only from a history that fits (3+ runs, a clean power law); otherwise the verdict uses flat income and says why", async () => {
	const none = world();
	assert.match(await none.etaRuns(eta, 1), /Confidence: low, income growth with the multiplier is not measured yet/);
	const clean = [1, 1.2, 1.5, 2, 2.5].map((mult, i) => ({ stamp: `r${i}`, t: i, mult, income: 1e7 * mult ** 1.5 }));
	const fit = world({ files: { "data/node-eta-history.json": JSON.stringify(clean) } });
	fit.income = 1e7; // this run sits on the same law (multiplier 1)
	assert.match(await fit.etaRuns(eta, 3, 2 * MIN), /Confidence: medium, income growth measured over 6 runs \(income ~ multiplier\^1\.\d\d/);
	assert.match(report(fit), /Hacking, measured:/);
	const noisy = [[1.27, 9e5], [1.27, 4e5], [1.37, 2.9e5], [1.44, 2e5], [1.49, 2.2e6], [1.64, 2.4e6], [1.9, 7e8]].map(([mult, income], i) => ({ stamp: `n${i}`, t: i, mult, income }));
	const bad = world({ files: { "data/node-eta-history.json": JSON.stringify(noisy) } });
	assert.match(await bad.etaRuns(eta, 1), /Confidence: low, the income fit over \d+ runs is not usable/);
});

test("with the live readings of bb-pass.js: the route is committed (not a guess) and stays the same run after run", async () => {
	const sim = world({ post: {} });
	await sim.passes(play, 70);
	await sim.etaRuns(eta, 4, 5 * MIN);
	const routes = [];
	for (let i = 0; i < 3; i++) {
		await sim.etaRuns(eta, 1, 5 * MIN);
		routes.push(port(sim).plan.route);
	}
	assert.ok(routes.every((route) => route === "hacking" || route === "combat"));
	assert.equal(new Set(routes).size, 1, `the route flipped: ${routes}`);
	assert.equal(port(sim).plan.prior, undefined, "from readings, not from the first guess");
	assert.doesNotMatch(report(sim), /first guess/);
	assert.match(report(sim), /Bladeburner calibration: the model predicts/);
	assert.match(report(sim), /Best action chance now 85% \(Tracking\); rank \d+\/400000/);
});

test("the route follows the one that finishes: hacking when only hacking can, and it moves off a committed combat route for it", async () => {
	const sim = world({ post: { plan: { route: "combat", time: START } } });
	await sim.passes(play, 70);
	await sim.etaRuns(eta, 2, 5 * MIN);
	assert.match(report(sim), /Hacking, middle[^\n]*: \d+ h \(\d+ runs\)/, "the hacking route finishes");
	assert.match(report(sim), /Bladeburner, middle[^\n]*: not reached/);
	assert.equal(port(sim).plan.route, "hacking", "the committed route cannot finish: the other one is more than 25 % better");
	assert.match(report(sim), /RECOMMENDED ROUTE: hacking over several resets, about \d+ h/);
});

test("regression: the first guess commits hacking only when Bladeburner is nerfed or slower, and bladeburner.priorRoute false turns that off", async () => {
	const files = nodeFiles(6, HARSH);
	const sim = world({ files });
	await sim.etaRuns(eta, 3, 2 * MIN); // enough runs to measure the exp rate: the hacking route needs it
	assert.equal(port(sim).plan.route, "hacking");
	assert.equal(port(sim).plan.prior, true);
	assert.match(report(sim), /Route committed from the first guess: hacking, without training for Bladeburner/);
	assert.match(report(sim), /RECOMMENDED ROUTE \(first guess\)/);
	const off = world({ files, config: { bladeburner: { priorRoute: false } } });
	await off.etaRuns(eta, 3, 2 * MIN);
	assert.equal(off.ns.portJson(36).plan.route, undefined, "no first guess: Bladeburner trains and measures first");
	assert.match(report(off), /Bladeburner: no live readings yet/);
	assert.doesNotMatch(report(off), /committed from the first guess/);
});

test("a first guess with the Bladeburner multipliers unknown (no Source-File 5) assumes no nerf", async () => {
	const sim = world();
	await sim.etaRuns(eta, 1);
	assert.match(report(sim), /multipliers unknown without Source-File 5: no nerf assumed/);
	const nerfed = world({ files: nodeFiles(6, HARSH) });
	await nerfed.etaRuns(eta, 1);
	assert.match(report(nerfed), /this BitNode's rank x0\.05 and skill cost x3\.00/);
});

// ---- hold
async function held({ chance, previous }) {
	const sim = world({ post: previous === undefined ? {} : { plan: { route: "combat", hold: previous, time: START } }, actions: Object.fromEntries(["Tracking", "Bounty Hunter", "Retirement", "Investigation", "Undercover Operation", "Sting Operation", "Raid", "Stealth Retirement Operation", "Assassination"].map((name) => [name, { chance, count: 100 }])) });
	await sim.passes(play, 3);
	await sim.etaRuns(eta, 1);
	return { hold: port(sim).plan.hold, text: report(sim) };
}

test("hold has hysteresis: held below 30 % best chance, resumed only above 40 %", async () => {
	assert.equal((await held({ chance: 0.2, previous: false })).hold, true, "under 30 %: hold");
	assert.equal((await held({ chance: 0.35, previous: false })).hold, false, "between: a running Bladeburner keeps running");
	assert.equal((await held({ chance: 0.35, previous: true })).hold, true, "between: a held Bladeburner stays held");
	assert.equal((await held({ chance: 0.5, previous: true })).hold, false, "over 40 %: resumes");
	const holding = await held({ chance: 0.2, previous: false });
	assert.match(holding.text, /Bladeburner "run" now: HOLD: best chance 20% is too low to earn rank/);
	assert.match((await held({ chance: 0.5, previous: false })).text, /Bladeburner "run" now: run: best chance 50%/);
});

test("no live readings: it never holds (Bladeburner has to run once to read the chances)", async () => {
	const sim = world({ post: { plan: { hold: true, time: START } } });
	await sim.etaRuns(eta, 1);
	assert.equal(port(sim).plan.hold, false);
	assert.match(report(sim), /Bladeburner "run" now: no data yet, it runs once to read the real chances/);
});

// ---- done, installed, failed
test("every Black Op done: no Bladeburner route, no recommendation, no committed route", async () => {
	const sim = world({ post: { blackOps: { done: true, time: START } } });
	await sim.passes(play, 3);
	postBladeburner(sim.ns, { blackOps: { done: true, time: sim.now() } });
	await sim.etaRuns(eta, 1);
	assert.match(report(sim), /Bladeburner: every Black Op is done/);
	assert.doesNotMatch(report(sim), /RECOMMENDED ROUTE/);
	assert.doesNotMatch(report(sim), /Bladeburner, /);
	assert.equal(port(sim).plan.route, undefined);
});

test("The Red Pill installed and the level reached: no hacking route left to model", async () => {
	const sim = world({ route: { owned: ["NeuroFlux Governor", "The Red Pill"], server: { requiredHackingSkill: 200 } } });
	await sim.etaRuns(eta, 3, 2 * MIN);
	assert.match(report(sim), /Red Pill: installed/);
	assert.doesNotMatch(report(sim), /^Hacking, /m);
	assert.doesNotMatch(report(sim), /Hacking: needs a measured exp rate/);
});

test("a hacking route that is not modelled yet says what it needs (a measured exp rate and income)", async () => {
	const sim = world();
	sim.income = 0;
	await sim.etaRuns(eta, 3, 2 * MIN);
	assert.match(report(sim), /Hacking: needs a measured exp rate and income first/);
});

test("regression: a failed estimate leaves a readable report and a terminal line, and the plan as it was", async () => {
	const sim = world({ post: { plan: { route: "hacking", hold: false, time: START } }, overrides: { singularity: { getOwnedAugmentations: () => { throw new Error("boom: no Singularity"); } } } });
	await sim.etaRuns(eta, 1);
	assert.match(report(sim), /^.*route estimate failed: .*boom: no Singularity/);
	assert.ok(sim.ns.terminal.some((row) => /^\[bladeburner\] route estimate failed: Error: boom/.test(row)), sim.ns.terminal.join("|"));
	assert.deepEqual(port(sim).plan, { route: "hacking", hold: false, time: START }, "bb-manage.js keeps following the last plan");
});

test("off home: the history is fetched from home first and the report and history go back to it; on home nothing is copied", async () => {
	const away = world({ route: { hostname: "pserv-3" }, files: { "data/node-eta-history.json": "[]" } });
	await away.etaRuns(eta, 1);
	assert.deepEqual(away.etaFiles[0], { files: "data/node-eta-history.json", to: "pserv-3", from: "home" });
	assert.deepEqual(away.etaFiles.at(-1), { files: ["data/node-eta.txt", "data/node-eta-history.json"], to: "home", from: undefined });
	const home = world();
	await home.etaRuns(eta, 1);
	assert.deepEqual(home.etaFiles, []);
});

test("regression: the augmentation price step in the model uses Source-File 11, and queued augmentations are priced back to none queued", async () => {
	const plain = world();
	await plain.etaRuns(eta, 1);
	assert.match(report(plain), /each aug bought in a run costs x1\.9 more/);
	const sf11 = world({ route: { ownedSF: new Map([[4, 3], [11, 3]]) } });
	await sf11.etaRuns(eta, 1);
	assert.match(report(sf11), /each aug bought in a run costs x1\.767 more/);
});

test("persistence.routeRepResets false keeps the old model: faction rep carried across installs", async () => {
	const on = world();
	await on.etaRuns(eta, 1);
	assert.match(report(on), /faction rep restarts at 0 at every install/);
	const off = world({ config: { persistence: { routeRepResets: false } } });
	await off.etaRuns(eta, 1);
	assert.match(report(off), /faction rep kept across installs \(persistence\.routeRepResets off\)/);
});

// ---- what the model is fed
test("the augmentation pool: hacking and combat augs of every faction, once each; installed ones, NeuroFlux, The Red Pill and stat-less augs are left out", async () => {
	const all = world();
	await all.etaRuns(eta, 1);
	assert.match(report(all), /pool of 5 hacking\/combat augs/);
	const owned = world({ route: { owned: ["NeuroFlux Governor", "BitWire"] } });
	await owned.etaRuns(eta, 1);
	assert.match(report(owned), /pool of 4 hacking\/combat augs/, "an installed aug cannot be bought again");
	const plain = world({ route: { catalog: { CyberSec: ["BitWire", "Plain Aug"], Aevum: ["BitWire"] } } });
	await plain.etaRuns(eta, 1);
	assert.match(report(plain), /pool of 1 hacking\/combat augs/, "no stats to use, and one faction's duplicate is the same aug");
});

test("the Bladeburner rate is measured over the rank samples: not before 15 minutes, 'not yet reliable' before 30, applied after, and not from samples that stopped", async () => {
	const sim = world({ post: {} });
	await sim.passes(play, 20); // 10 minutes
	await sim.etaRuns(eta, 3, 2 * MIN);
	assert.match(report(sim), /measured \? rank\/h/, "under 15 minutes of samples");
	await sim.passes(play, 30); // 25 minutes of samples
	await sim.etaRuns(eta, 3, 2 * MIN);
	assert.match(report(sim), /measured \d+\.\d rank\/h \(window under 30 min: not yet reliable\) => duty 50% assumed/);
	await sim.passes(play, 30); // 40 minutes
	await sim.etaRuns(eta, 3, 2 * MIN);
	assert.match(report(sim), /measured \d+\.\d rank\/h => duty \d+% applied/);
	sim.advance(15 * MIN); // bb-pass.js stopped (held, training): its last sample is over 10 minutes old
	await sim.etaRuns(eta, 1);
	assert.match(report(sim), /measured \? rank\/h/);
});
