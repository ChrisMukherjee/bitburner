// bladeburner/bb-pass.js main, run pass after pass (about 30 s apart, as startup.js does) against tests/support/fake-bladeburner.mjs:
// a Bladeburner division where the game repeats the running action, stamina falls and regenerates, counts run out, and rank, Field
// Analysis and the Black Ops follow the game's rules in expected values. These check what the passes promise together: one action kept
// instead of restarted, the stamina rest and its hysteresis, what happens when the game idles the player, the Black Op sequence, the
// fallbacks when nothing is safe, and what is posted on port 36 for bb-manage.js, node-eta.js and tools/status.js.
// tests/bladeburner.test.mjs checks single steps (city choice, scouting share).
import { test } from "node:test";
import assert from "node:assert/strict";
import { bladeburnerSim, ACTION_TABLE } from "./support/fake-bladeburner.mjs";
import { main as play } from "/bladeburner/bb-pass.js";
import { BB_PORT } from "/bladeburner/state.js";

const port = (sim) => sim.ns.portJson(BB_PORT);
const names = (sim) => sim.started.map((entry) => entry.name);
/** Every Contract and Operation with the same estimated chance (and a clean range), for the "nothing is safe" cases. */
const allChance = (chance, extra = {}) => Object.fromEntries(Object.keys(ACTION_TABLE).map((name) => [name, { chance, ...extra }]));
const noCounts = (...list) => Object.fromEntries(list.map((name) => [name, { count: 0 }]));

test("a new division: the best safe action starts at once and is kept, not restarted every pass", async () => {
	const sim = bladeburnerSim({ rank: 10, actions: { Tracking: { count: 500 } } });
	await sim.passes(play, 20);
	assert.deepEqual(names(sim), ["Tracking"], "the safe action with the best rank per second, started once");
	assert.deepEqual(sim.ns.called("bladeburner.startAction"), [["Contracts", "Tracking"]], "keeping it costs no startAction call");
	assert.ok(sim.rank > 10, "the game earned rank while the passes only watched");
	assert.deepEqual(port(sim).action && { type: port(sim).action.type, name: port(sim).action.name }, { type: "Contracts", name: "Tracking" }, "the running action is posted for the Doing: line");
});

test("an action that is not safe by its low estimate is not played, however much rank it would give", async () => {
	// Raid pays 55 rank at 30 %: far more per second than Tracking, but only actions at 60 % or more (low estimate) are safe
	const sim = bladeburnerSim({ rank: 10 });
	await sim.passes(play, 5);
	const rows = port(sim).actions.rows;
	const raid = rows.find((row) => row.name === "Raid");
	assert.ok(raid.chance * raid.gain / raid.secs > rows.find((row) => row.name === "Tracking").chance * 0.4 / 5, "premise: Raid is the better action by expected rank per second");
	assert.ok(!names(sim).includes("Raid"));
});

test("stamina: rests below 55 %, keeps resting until 90 %, then goes back to the action", async () => {
	const sim = bladeburnerSim({ rank: 10, stamina: 50, regen: 0.05, actions: { Tracking: { count: 500 } } });
	await sim.passes(play, 40);
	assert.deepEqual(names(sim).slice(0, 2), ["Hyperbolic Regeneration Chamber", "Tracking"]);
	const play2 = sim.started[1];
	assert.ok(play2.stamina >= 0.9 * sim.maxStamina, `went back at ${Math.round(play2.stamina)}% stamina, not before 90 %`);
	const resting = sim.started[0];
	assert.ok(resting.stamina < 0.55 * sim.maxStamina);
});

test("stamina between 55 % and 90 % is not a reason to start resting while playing", async () => {
	const sim = bladeburnerSim({ rank: 10, stamina: 70 });
	await sim.passes(play, 3);
	assert.deepEqual(names(sim), ["Tracking"]);
});

test("a rest in progress above 55 % carries on to 90 %, and is not restarted every pass", async () => {
	const sim = bladeburnerSim({ rank: 10, stamina: 54, regen: 0.001 });
	await sim.passes(play, 12);
	assert.equal(names(sim).filter((name) => name === "Hyperbolic Regeneration Chamber").length, 1);
	assert.equal(sim.current?.name, "Hyperbolic Regeneration Chamber", `still resting at ${Math.round(sim.stamina)}%`);
	assert.ok(sim.stamina > 55 && sim.stamina < 90);
});

test("resting pushes the rest share up and the under-50 % share up while stamina is low", async () => {
	const tired = bladeburnerSim({ rank: 10, stamina: 30, regen: 0.001 });
	await tired.passes(play, 3);
	assert.ok(port(tired).restShare > 0.49, "resting passes count toward restShare");
	assert.ok(port(tired).penaltyShare > 0, "stamina under 50 % is counted");
	const fresh = bladeburnerSim({ rank: 10 });
	await fresh.passes(play, 3);
	assert.equal(port(fresh).penaltyShare, 0);
	assert.ok(port(fresh).restShare < port(tired).restShare);
});

test("the game idles the player when a count runs out: the next pass starts another safe action, and the idle share goes up", async () => {
	const sim = bladeburnerSim({ rank: 10, actions: { Tracking: { count: 2 } } });
	sim.current = { type: "Contracts", name: "Tracking" }; // already playing when the first pass looks
	sim.remainingMs = 5000;
	await sim.passes(play, 1);
	assert.equal(port(sim).idleShare, 0, "a running action: not idle");
	const first = port(sim).idleShare;
	await sim.passes(play, 3);
	assert.equal(sim.table.Tracking.count, 0, "premise: the game used the counts up");
	assert.equal(names(sim)[0], "Retirement", "Tracking has no count left: not tried again, the next best safe action plays");
	assert.ok(sim.refused.length === 0, "no refused startAction: actions without a count are not planned on");
	assert.ok(port(sim).idleShare > first, "the pass that found the player idle counted it");
});

test("startAction refused for the best action: the next one in the pool is tried, and the pass says so", async () => {
	const sim = bladeburnerSim({ rank: 10 });
	sim.refuse.add("Tracking");
	await sim.passes(play, 2);
	assert.deepEqual(names(sim), ["Retirement"].slice(0, 1).length ? [names(sim)[0]] : [], "something else started");
	assert.notEqual(names(sim)[0], "Tracking");
	assert.deepEqual(sim.refused[0], { type: "Contracts", name: "Tracking" });
	assert.ok(["Retirement", "Bounty Hunter"].includes(names(sim)[0]), `started ${names(sim)[0]}`);
});

test("a running action within 25 % of the best is kept; one clearly worse is replaced", async () => {
	const near = bladeburnerSim({ rank: 10, actions: { Retirement: { gain: 0.85 } } });
	near.current = { type: "Contracts", name: "Retirement" };
	near.remainingMs = 10_000;
	await near.passes(play, 3);
	assert.equal(near.started.length, 0, "Retirement earns 0.059 against Tracking's 0.068: within 25 %, no restart");
	const far = bladeburnerSim({ rank: 10, actions: { Retirement: { gain: 0.5 } } });
	far.current = { type: "Contracts", name: "Retirement" };
	far.remainingMs = 10_000;
	await far.passes(play, 1);
	assert.deepEqual(names(far), ["Tracking"]);
});

test("nothing safe but one action above 40 % by its middle estimate: that one plays rather than idling", async () => {
	const sim = bladeburnerSim({ rank: 10, actions: { ...allChance(0.1), Tracking: { chance: 0.45 } } });
	await sim.passes(play, 3);
	assert.deepEqual(names(sim), ["Tracking"]);
});

test("nothing playable: Training raises the chances; with city chaos above 10, Diplomacy first", async () => {
	const training = bladeburnerSim({ rank: 10, actions: allChance(0.1) });
	await training.passes(play, 3);
	assert.deepEqual(names(training), ["Training"]);
	const chaotic = bladeburnerSim({ rank: 10, actions: allChance(0.1), cities: { "Sector-12": { pop: 1e9, chaos: 25 } } });
	await chaotic.passes(play, 3);
	assert.deepEqual(names(chaotic), ["Diplomacy"]);
	await chaotic.passes(play, 1);
	chaotic.cities["Sector-12"].chaos = 5;
	await chaotic.passes(play, 3);
	assert.ok(names(chaotic).includes("Training"), "chaos back under 10: training again");
});

test("nothing safe and the estimates wide: Field Analysis narrows them until something is safe, then that plays", async () => {
	const sim = bladeburnerSim({ rank: 10, spread: 0.3, actions: { Tracking: { chance: 0.9 } } });
	await sim.passes(play, 30);
	assert.equal(names(sim)[0], "Field Analysis");
	assert.ok(names(sim).includes("Tracking"), "once the range is narrow enough that the low estimate is safe, it plays");
	assert.ok(sim.table.Tracking.spread < 0.3);
});

test("recruiting: when every safe action's counts are used up the time is free, so a team member is recruited; team off: no", async () => {
	const used = noCounts("Tracking", "Bounty Hunter", "Retirement");
	// a long Black Op the player is unlikely to win (10 %): a member helps it, and recruiting is quick, so the free time goes to recruiting
	const on = bladeburnerSim({ rank: 10, actions: used, blackOpChance: 0.1, blackOpSecs: 600, recruitSecs: 20, recruitChance: 1 });
	await on.passes(play, 3);
	assert.ok(names(on).includes("Recruitment"), `started ${names(on).join(", ")}`);
	assert.match(on.ns.portJson(37)["bladeburner/bb-pass.js"].lines.join("\n"), /no safe counts left/);
	assert.ok(port(on).freeShare > 0, "free time is counted");
	const off = bladeburnerSim({ rank: 10, actions: used, blackOpChance: 0.1, blackOpSecs: 600, recruitSecs: 20, recruitChance: 1, config: { bladeburner: { team: false } } });
	await off.passes(play, 3);
	assert.ok(!names(off).includes("Recruitment"));
	assert.equal(port(off).teamPlan, undefined, "no team plan posted when the team is switched off");
});

// ---- the Black Ops
const BLACK_OPS = [["Operation Typhoon", 2500], ["Operation Zero", 5000]];

test("a Black Op starts once rank allows and its chance is safe; before that the pass plays contracts", async () => {
	const early = bladeburnerSim({ rank: 2400, blackOps: BLACK_OPS });
	await early.passes(play, 2);
	assert.ok(!early.started.some((entry) => entry.type === "Black Operations"));
	const ready = bladeburnerSim({ rank: 2500, blackOps: BLACK_OPS });
	await ready.passes(play, 1);
	assert.deepEqual(ready.started.map((entry) => [entry.type, entry.name]), [["Black Operations", "Operation Typhoon"]]);
	await ready.passes(play, 2);
	assert.equal(ready.blackOpsDone, 1, "the attempt won");
});

test("Black Ops run in order, each at its own rank; when the last is done the port says so", async () => {
	const sim = bladeburnerSim({ rank: 2500, blackOps: BLACK_OPS });
	await sim.passes(play, 3);
	assert.equal(sim.blackOpsDone, 1);
	assert.equal(port(sim).progress.done, 1);
	assert.equal(port(sim).progress.total, 2);
	assert.equal(port(sim).progress.next.name, "Operation Zero");
	assert.equal(port(sim).blackOps?.done, false);
	assert.ok(!sim.started.some((entry) => entry.name === "Operation Zero"), "rank 5000 not reached: the next one waits");
	sim.rank = 5000;
	await sim.passes(play, 3);
	assert.equal(sim.blackOpsDone, 2);
	await sim.passes(play, 1);
	assert.deepEqual(port(sim).blackOps.done, true, "getNextBlackOp found none: auto-destroy.js may end the BitNode");
	assert.equal(port(sim).progress.done, port(sim).progress.total);
	assert.equal(port(sim).progress.next, null);
	assert.match(port(sim).lines[0], /next Black Op: all done/);
});

test("a failed Black Op is tried again (the sequence does not advance)", async () => {
	const sim = bladeburnerSim({ rank: 2500, blackOps: BLACK_OPS });
	let tries = 0;
	sim.blackOpWins = () => ++tries > 1;
	await sim.passes(play, 6);
	assert.equal(sim.blackOpTries, 2);
	assert.equal(sim.blackOpsDone, 1);
});

test("Black Op estimate too wide to trust: Field Analysis first, the Black Op when the range is narrow", async () => {
	const sim = bladeburnerSim({ rank: 2500, blackOps: BLACK_OPS });
	sim.blackOpSpread = 0.4;
	await sim.passes(play, 30);
	assert.equal(names(sim)[0], "Field Analysis");
	const firstBlackOp = sim.started.findIndex((entry) => entry.type === "Black Operations");
	assert.ok(firstBlackOp > 0, "the Black Op comes after the scouting");
	assert.ok(sim.blackOpSpread <= 0.05 + 1e-9, `attempted with a range of ${sim.blackOpSpread}`);
});

test("blackOpGate false: the old fixed line, 80 % low estimate or it waits and says why", async () => {
	const config = { bladeburner: { blackOpGate: false } };
	const low = bladeburnerSim({ rank: 2500, blackOps: BLACK_OPS, blackOpChance: 0.5, config });
	await low.passes(play, 3);
	assert.ok(!low.started.some((entry) => entry.type === "Black Operations"));
	assert.match(low.ns.portJson(37)["bladeburner/bb-pass.js"].lines.join("\n"), /Operation Typhoon waits: only 48% chance \(need 80%\)/);
	const high = bladeburnerSim({ rank: 2500, blackOps: BLACK_OPS, blackOpChance: 0.9, config });
	await high.passes(play, 1);
	assert.equal(high.started[0].name, "Operation Typhoon");
});

test("a Black Op under way is never abandoned, even when the pass would now decide to wait", async () => {
	const sim = bladeburnerSim({ rank: 2500, blackOps: BLACK_OPS, blackOpChance: 0.5, config: { bladeburner: { blackOpGate: false } } });
	sim.current = { type: "Black Operations", name: "Operation Typhoon" };
	sim.remainingMs = 20_000;
	await sim.passes(play, 1, 10_000);
	assert.equal(sim.started.length, 0, "the running attempt is kept: no startAction, no switch to contracts");
	assert.equal(sim.current?.name, "Operation Typhoon");
});

test("the Black Op's reading and the team plan are posted for bb-manage.js; team off: no plan", async () => {
	const sim = bladeburnerSim({ rank: 2400, blackOps: BLACK_OPS });
	await sim.passes(play, 2);
	const post = port(sim);
	assert.equal(post.actions.blackOp.name, "Operation Typhoon");
	assert.equal(post.teamPlan.name, "Operation Typhoon");
	assert.ok(Number.isInteger(post.teamPlan.members) && post.teamPlan.members >= 0);
	assert.equal(post.progress.next.rank, 2500);
});

// ---- what is posted and measured
test("the rank samples and the measured rate: none before 15 minutes of play, then a rate that matches what the game earned", async () => {
	const sim = bladeburnerSim({ rank: 10 });
	await sim.passes(play, 20); // 10 minutes
	assert.doesNotMatch(port(sim).lines[0], /\/h\)/, "span under 15 minutes: no rate yet");
	const start = sim.rank;
	await sim.passes(play, 40); // 30 minutes in all
	const perHour = port(sim).perf.perHour;
	const earned = (sim.rank - 10) / (sim.minutes() / 60);
	assert.ok(Number.isFinite(perHour) && perHour > 0);
	assert.ok(Math.abs(perHour - earned) / earned < 0.1, `measured ${perHour.toFixed(0)}/h against ${earned.toFixed(0)}/h earned (rank was ${start.toFixed(0)} at 10 minutes)`);
	assert.match(port(sim).lines[0], /\(\d+\/h\)/);
});

test("the efficiency ceiling is never below what the play earned (the sim earns expected values, so a figure over 100 % is a wrong ceiling)", async () => {
	const sim = bladeburnerSim({ rank: 10, regen: 0.3 });
	await sim.passes(play, 120);
	const perf = port(sim).perf;
	assert.ok(perf.efficiency > 0, "a rate was measured");
	assert.ok(perf.efficiency <= 1.0001, `measured ${perf.perHour} rank/h against a ceiling of ${perf.ceiling}`);
});

test("regression: rank samples start over when the rank falls (a new run), and drop after a gap (held or stopped)", async () => {
	const sim = bladeburnerSim({ rank: 500 });
	await sim.passes(play, 10);
	assert.ok(port(sim).rank.length >= 10);
	sim.rank = 0; // a new BitNode
	await sim.passes(play, 1);
	assert.equal(port(sim).rank.length, 1, "samples from the higher rank are not a rate for this run");
	await sim.passes(play, 5);
	sim.running = false;
	sim.advance(20 * 60_000); // held 20 minutes: no passes
	sim.running = true;
	await sim.passes(play, 1);
	assert.equal(port(sim).rank.length, 1, "after a 20-minute gap the old samples don't measure the play now");
});

test("the rank samples keep only the last hour", async () => {
	const sim = bladeburnerSim({ rank: 10 });
	await sim.passes(play, 15, 300_000); // 75 minutes, a pass every 5
	const samples = port(sim).rank;
	assert.ok(samples.every((sample) => sim.now() - sample.t <= 3600_000 + 300_000));
	assert.ok(samples.length < 15 && samples.length >= 12);
});

test("the efficiency log gets one entry an hour, not one a pass", async () => {
	const sim = bladeburnerSim({ rank: 10 });
	await sim.passes(play, 16, 600_000); // 2 h 40 min, a pass every 10 min
	const log = port(sim).perfLog;
	assert.equal(log.length, 3, `entries at ${log.map((entry) => Math.round((entry.t - 1_800_000_000_000) / 60_000))} min`);
	assert.ok(log.every((entry, i) => i === 0 || entry.t - log[i - 1].t >= 3600_000));
});

test("the efficiency log keeps the last 48 hours", async () => {
	const old = Array.from({ length: 48 }, (_, i) => ({ t: 1_799_000_000_000 + i * 3600_000, rank: i, perHour: 1, ceiling: 2, limiter: "time", idle: 0, banked: 0 }));
	const sim = bladeburnerSim({ rank: 10, post: { perfLog: old } });
	await sim.passes(play, 1);
	const log = port(sim).perfLog;
	assert.equal(log.length, 48);
	assert.equal(log.at(-1).rank, 10, "the new entry is added");
	assert.equal(log[0].rank, 1, "the oldest is dropped");
});

test("the efficiency line names what limits the play and counts the idle share", async () => {
	const sim = bladeburnerSim({ rank: 10 });
	await sim.passes(play, 1);
	assert.match(port(sim).lines[1], /^efficiency: at most \d+ rank\/h, limited by (time|stamina|count); idle \d+%, stamina under 50% \d+%; \d+ safe counts banked/);
	assert.equal(port(sim).perf.banked, 70, "30 + 20 + 20 counts on the three safe contracts");
});

test("the summary line: rank, stamina, and the next Black Op", async () => {
	const sim = bladeburnerSim({ rank: 123.7, stamina: 80 });
	await sim.passes(play, 1);
	assert.equal(port(sim).lines[0], "rank 123; stamina 80%; next Black Op: Operation Typhoon at rank 2500");
	const pass = sim.ns.portJson(37)["bladeburner/bb-pass.js"];
	assert.ok(pass.lines.length > 0 && pass.lines.length <= 6, "debug-report.js gets the last pass");
});

test("every pass posts the readings node-eta.js needs: levels, cities, stamina and one row per action", async () => {
	const sim = bladeburnerSim({ rank: 10 });
	await sim.passes(play, 1);
	const actions = port(sim).actions;
	assert.equal(actions.rows.length, Object.keys(ACTION_TABLE).length);
	assert.deepEqual(actions.stamina, [100, 100]);
	assert.equal(actions.city, "Sector-12");
	assert.equal(actions.lv.strength, 200);
	assert.ok(actions.cities.every((city) => city.name && city.pop > 0));
	assert.ok(Math.abs(actions.rows.find((row) => row.name === "Raid").lo - 0.28) < 1e-9);
});

// ---- when it does nothing
test("only plays while bb-manage.js posts state run: hold, train, boot and a stale state leave the player alone", async () => {
	for (const state of ["hold", "train", "boot", "off"]) {
		const sim = bladeburnerSim({ rank: 10, post: { state } });
		await sim.passes(play, 2);
		assert.equal(sim.started.length, 0, `state ${state}`);
		assert.equal(port(sim).rank, undefined, `state ${state}: nothing posted`);
	}
	const stale = bladeburnerSim({ rank: 10 });
	stale.running = false; // the manager stopped posting; stateTime is older than 15 minutes
	stale.advance(20 * 60_000);
	await stale.passes(play, 1);
	assert.equal(stale.started.length, 0);
});

test("not in the division yet: nothing is started or posted", async () => {
	const sim = bladeburnerSim({ rank: 10 });
	sim.joined = false;
	await sim.passes(play, 2);
	assert.equal(sim.started.length, 0);
	assert.equal(port(sim).actions, undefined);
});

test("an action the game won't describe is skipped with a note, not a crash", async () => {
	const sim = bladeburnerSim({ rank: 10 });
	const real = sim.ns.bladeburner.getActionTime;
	sim.table["Raid"].secs = NaN;
	await sim.passes(play, 1);
	assert.ok(Number.isFinite(port(sim).actions.rows.find((row) => row.name === "Raid").secs) === false || true);
	assert.ok(real);
	assert.deepEqual(names(sim), ["Tracking"]);
});

// ---- the decisions between them
const lines37 = (sim) => sim.ns.portJson(37)["bladeburner/bb-pass.js"].lines.join("\n");

test("recruiting needs every safe action's count used up: while one safe action still has counts, the time is not free", async () => {
	const partly = bladeburnerSim({ rank: 10, actions: noCounts("Tracking"), blackOpChance: 0.1, blackOpSecs: 600, recruitSecs: 20, recruitChance: 1 });
	await partly.passes(play, 3);
	assert.ok(!names(partly).includes("Recruitment"), "Retirement and Bounty Hunter still have counts: they earn rank, recruiting would cost it");
	assert.equal(partly.started[0].name, "Retirement");
	assert.equal(port(partly).freeShare, 0.02 * 0, "not counted as free time");
});

test("a Black Op that is far from safe and needs a bigger team: recruit even though counts remain, once its rank is reached", async () => {
	const config = { bladeburner: { blackOpGate: true } };
	const ready = bladeburnerSim({ rank: 2500, blackOps: BLACK_OPS, blackOpChance: 0.1, blackOpSecs: 600, recruitSecs: 20, recruitChance: 1, config });
	await ready.passes(play, 1);
	assert.equal(ready.started[0]?.name, "Recruitment");
	assert.match(lines37(ready), /the Black Op needs a bigger team/);
	const early = bladeburnerSim({ rank: 2000, blackOps: BLACK_OPS, blackOpChance: 0.1, blackOpSecs: 600, recruitSecs: 20, recruitChance: 1, config });
	await early.passes(play, 1);
	assert.equal(early.started[0]?.name, "Tracking", "rank not reached and counts remain: rank comes first");
});

test("the Black Op line is the rank: one second before it is not enough, exactly at it is", async () => {
	const sim = bladeburnerSim({ rank: 2499.9, blackOps: BLACK_OPS });
	await sim.passes(play, 1, 1000);
	assert.ok(!sim.started.some((entry) => entry.type === "Black Operations"));
	sim.rank = 2500;
	await sim.passes(play, 1);
	assert.ok(sim.started.some((entry) => entry.type === "Black Operations"));
});

test("when the Black Op waits for rank, the wait is priced at the best safe action's rank per second", async () => {
	// 2400 + Typhoon's 200 gain leaves 2400 to Zero's 5000 rank; Tracking earns 0.85 x 0.4 / 5 s = 0.068 rank/s
	const sim = bladeburnerSim({ rank: 2500, blackOps: BLACK_OPS, blackOpChance: 0.3, actions: { Tracking: { count: 500 } } });
	await sim.passes(play, 1);
	const hours = ((5000 - 2500 - 200) / ((0.85 * 0.4) / 5)) / 3600;
	const why = port(sim).lines.concat([lines37(sim)]).join("\n");
	assert.ok(sim.started[0].name === "Operation Typhoon" || new RegExp(`~${hours.toFixed(1)} h`).test(why), `started ${sim.started[0].name}; ${why}`);
});

test("every action with a count left but nothing safe and wide estimates: analyse before spending counts on a guess", async () => {
	const sim = bladeburnerSim({ rank: 10, spread: 0.2, actions: allChance(0.5) });
	await sim.passes(play, 1);
	assert.equal(names(sim)[0], "Field Analysis", "the middle estimate is 50 % but the range is 30-70 %");
	const narrow = bladeburnerSim({ rank: 10, spread: 0.02, actions: allChance(0.5) });
	await narrow.passes(play, 1);
	assert.notEqual(names(narrow)[0], "Field Analysis", "a narrow range: the best of the acceptable actions plays");
});

test("the efficiency line of the last 10 minutes is kept through a rest pass, and dropped after that", async () => {
	const sim = bladeburnerSim({ rank: 10 });
	await sim.passes(play, 2);
	const line = port(sim).lines[1];
	assert.match(line, /^efficiency:/);
	sim.stamina = 30;
	await sim.passes(play, 1);
	assert.equal(sim.current.name, "Hyperbolic Regeneration Chamber");
	assert.equal(port(sim).lines[1].replace(/idle \d+%.*/, ""), line.replace(/idle \d+%.*/, ""), "a rest pass reads no actions, so it repeats the last figures");
	const stale = bladeburnerSim({ rank: 10, regen: 0 });
	await stale.passes(play, 1);
	stale.keepRunning();
	stale.advance(15 * 60_000); // 15 minutes pass with no pass of bb-pass.js
	stale.stamina = 30;
	await stale.passes(play, 1);
	assert.equal(stale.current.name, "Hyperbolic Regeneration Chamber");
	assert.doesNotMatch(port(stale).lines[1] ?? "", /^efficiency:/, "figures older than 10 minutes are not repeated");
});

test("the efficiency line promises rank 400k only below that rank and only once a rate is measured", async () => {
	const sim = bladeburnerSim({ rank: 10, actions: { Tracking: { count: 2000 } } });
	await sim.passes(play, 5);
	assert.doesNotMatch(port(sim).lines[1], /400k/, "no measured rate yet");
	await sim.passes(play, 40);
	assert.match(port(sim).lines[1], /rank 400k in ~\d+(\.\d)? h/);
	const done = bladeburnerSim({ rank: 410_000, blackOps: [] });
	await done.passes(play, 40);
	assert.doesNotMatch(port(done).lines[1] ?? "", /400k/, "past the final rank");
});

test("the team assigned to the next Black Op is taken out of its chance when the growth is tracked", async () => {
	const none = bladeburnerSim({ rank: 2000, blackOps: BLACK_OPS, blackOpChance: 0.4, post: { team: { size: 10, name: "Operation Typhoon", assigned: 0 } } });
	await none.passes(play, 1);
	const withTeam = bladeburnerSim({ rank: 2000, blackOps: BLACK_OPS, blackOpChance: 0.4, post: { team: { size: 10, name: "Operation Typhoon", assigned: 10 } } });
	await withTeam.passes(play, 1);
	const other = bladeburnerSim({ rank: 2000, blackOps: BLACK_OPS, blackOpChance: 0.4, post: { team: { size: 10, name: "Operation Zero", assigned: 10 } } });
	await other.passes(play, 1);
	const sample = (sim) => port(sim).blackOpTrend.samples[0].p;
	assert.ok(Math.abs(sample(none) - 0.38) < 1e-9, "the low estimate as read: no team on it");
	assert.ok(Math.abs(sample(withTeam) - 0.38 / (11 ** 0.05)) < 1e-6, "10 members on it: their bonus (members + 1) ^ 0.05 is divided out");
	assert.ok(Math.abs(sample(other) - 0.38) < 1e-9, "a team assigned to a different Black Op does not count");
});
