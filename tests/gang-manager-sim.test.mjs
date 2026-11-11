// gang/gang-manager.js main loop, run for simulated hours against tests/support/fake-gang.mjs: a gang whose respect,
// wanted level, experience, power and land follow the game's rules. These check what the loop promises over time
// (creating the gang, recruiting, the plan and buy cadence, wanted-level cooling, territory clashes, deaths, the summary
// and the metric log), not the numbers of one decision (tests/gang.test.mjs and tests/gang-sim.test.mjs do that).
import { test } from "node:test";
import assert from "node:assert/strict";
import { gangSim } from "./support/fake-gang.mjs";
import { fakeNs } from "./support/fake-ns.mjs";
import { loadConfig } from "/utils/config.js";
import { clashOutlook } from "/gang/formulas.js";
import { main, LOG_FILE } from "/gang/gang-manager.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const settings = loadConfig(fakeNs()).gang;
/** A full gang of trained members (combat experience in every combat stat), with plenty of respect. */
const fullGang = (options = {}) => gangSim({ members: 12, exp: 2e5, respect: 1e8, money: 1e9, updateCycles: 25, ...options });
/** Times (seconds) at which something happened, once each. */
const distinctTimes = (events) => [...new Set(events.map((event) => event.time))];
const minGap = (times) => Math.min(...times.slice(1).map((time, index) => time - times[index]));
/** Our share of the land that would change hands, as the game's clash rules give it, at one history point. */
const outlookAt = (point) => clashOutlook({ power: point.power, territory: point.territory }, point.others);

test("no Gang API in this run (BitNode 1, no Source-File 2): the reason and one advice line, nothing else", async () => {
	const sim = gangSim({ inGang: false, node: 1 });
	await sim.run(main, 10 * MIN);
	assert.equal(sim.ns.terminal.length, 2);
	assert.match(sim.ns.terminal[0], /isn't available/);
	assert.match(sim.ns.terminal[1], /Gang API.*destroy BitNode 2/);
	assert.deepEqual(sim.ns.calls.filter((call) => call.name.startsWith("gang.") && call.name !== "gang.inGang"), []);
});

test("no gang yet: waits with one log line, then creates it with the first gang.factions entry the player has joined", async () => {
	const sim = gangSim({ inGang: false, factions: [], money: 1e7, updateCycles: 25 });
	const [first, second] = settings.factions;
	sim.at(5 * MIN, (s) => s.player.factions.push(second)); // the second listed faction invites first
	sim.at(5 * MIN, (s) => s.player.factions.push(first));  // ...and the first in the same minute
	await sim.run(main, 20 * MIN);
	assert.equal(sim.ns.logs.filter((line) => /no gang yet/.test(line)).length, 1, "the waiting line is printed once, not every 30 seconds");
	assert.equal(sim.gang.faction, first, "gang.factions order decides, not the order the invites came in");
	assert.ok(sim.ns.toasts.some((line) => line.includes(`created a gang with ${first}`)));
	assert.ok(sim.recruits.length >= 3, "the three free members are recruited at once");
});

test("outside BitNode 2 the gang waits for karma -54,000, then is created", async () => {
	const sim = gangSim({ inGang: false, node: 1, sourceFiles: [[2, 1]], factions: ["Slum Snakes"], karma: -1000 });
	sim.at(10 * MIN, (s) => { s.player.karma = -54_000; });
	await sim.run(main, 15 * MIN);
	assert.equal(sim.ns.logs.filter((line) => /couldn't create a gang with Slum Snakes/.test(line)).length, 1, "the retry line is printed once");
	assert.ok(sim.gang, "created once karma allows");
});

test("a new gang (BitNode 2) for six hours: recruits whenever respect allows, plans and buys on their own clocks, and logs", async () => {
	const sim = gangSim({ members: 0, money: 1e7, updateCycles: 25 });
	await sim.run(main, 6 * HOUR);
	// Recruiting: member-1..12 in order, and no update ever started with a recruit affordable and not taken
	assert.deepEqual(sim.recruits.map((entry) => entry.name), Array.from({ length: 12 }, (_, index) => `member-${index + 1}`));
	assert.equal(sim.missedRecruits, 0);
	// Plans every planMs, the equipment pass every buyMs (each only on its clock, not every update)
	assert.ok(minGap(distinctTimes(sim.taskSets)) >= settings.planMs / 1000, "tasks change only when the plan runs");
	assert.ok(sim.purchases.length > 0 && minGap(distinctTimes(sim.purchases)) >= settings.buyMs / 1000, "equipment is bought only on the buy clock");
	assert.equal(sim.ns.called("exec").filter(([script]) => script === "gang/workers/equipment.js").length, 1, "the equipment list is fetched once");
	assert.ok(sim.ascensions.length > 0, "members ascend");
	// growth.minEarnShare: once full (everyone can earn something), at least that share earns, fights or cools, never all training
	const minEarners = Math.ceil(12 * settings.growth.minEarnShare);
	const planUpdates = Math.ceil(settings.planMs / 1000 / 5) + 1;
	const fullAt = sim.history.findIndex((point) => point.members === 12);
	for (const point of sim.history.slice(fullAt + planUpdates)) {
		const training = Object.entries(point.tasks).filter(([task]) => task.startsWith("Train ")).reduce((sum, [, count]) => sum + count, 0);
		assert.ok(point.members - training >= minEarners, `${training} of ${point.members} training at ${point.time}s`);
	}
	const planLines = sim.ns.logs.filter((line) => /^\[gang\] \d+ members, focus/.test(line));
	assert.ok(planLines.every((line, index) => index === 0 || line !== planLines[index - 1]), "a plan line is printed only when it changes");
	// Focus "auto": respect while the gang can still grow, money once it is full
	for (const line of sim.ns.logs.filter((entry) => /members, focus/.test(entry))) {
		const [, count, focus] = line.match(/(\d+) members, focus (\w+)/);
		assert.equal(focus, Number(count) < 12 ? "respect" : "money", line);
	}
	// The status summary (port 28) and the metric log (data/gang-log.json)
	const summary = sim.summary();
	assert.equal(summary.title, "Gang");
	assert.ok(sim.now - summary.time <= 5000, "posted every update (the run ends inside the last update)");
	assert.match(summary.lines[0], /12 \(full\) members/);
	const log = JSON.parse(sim.ns.files[LOG_FILE]);
	const times = log.samples.map((sample) => sample.t);
	assert.ok(minGap(times) >= settings.logMs, "a sample every logMs");
	assert.equal(log.samples.length, Math.floor((6 * HOUR) / settings.logMs), "one per logMs from the start");
	const filled = sim.recruits.at(-1).time;
	assert.ok(Math.abs(log.milestones.full - filled) <= 5, `full at ${log.milestones.full}s, the 12th member came at ${filled}s`);
});

test("a high wanted level is cooled: the weakest earners switch to Vigilante Justice until the penalty is back under okWantedPenalty", async () => {
	const sim = fullGang({ respect: 1e6, wanted: 2e5 }); // penalty about 17%
	await sim.run(main, 2 * HOUR);
	const cooling = (point) => point.tasks["Vigilante Justice"] ?? 0;
	assert.ok(sim.history.slice(0, 2).some((point) => cooling(point) > 0), "cooling starts at the first plan");
	const recovered = sim.history.findIndex((point) => point.penalty <= settings.okWantedPenalty);
	assert.ok(recovered >= 0, "the penalty comes back down under okWantedPenalty");
	// Hysteresis: once recovered, nobody cools again unless the penalty first goes back over maxWantedPenalty
	const planUpdates = Math.ceil(settings.planMs / 1000 / 5) + 1;
	for (let index = recovered + planUpdates; index < sim.history.length; index++) {
		if (cooling(sim.history[index]) === 0) continue;
		const lately = sim.history.slice(Math.max(0, index - planUpdates), index + 1);
		assert.ok(lately.some((point) => point.penalty > settings.maxWantedPenalty), `cooling at ${sim.history[index].time}s with the penalty under maxWantedPenalty`);
	}
	assert.ok(sim.history.at(-1).tasks["Human Trafficking"] > 0, "earning again");
});

test("territory: with land left and weaker rivals, a share of the earners builds power, clashes go on at engageAt and land is won", async () => {
	const others = { "Tetrads": { power: 20, territory: 0.4 }, "The Syndicate": { power: 20, territory: 0.4 } };
	const sim = fullGang({ territory: 0.2, power: 1, others, npcGrowth: false });
	await sim.run(main, 3 * HOUR);
	const warriors = sim.history.map((point) => point.tasks["Territory Warfare"] ?? 0);
	assert.ok(Math.max(...warriors) > 0, "some members build power");
	assert.ok(Math.max(...warriors) <= Math.round(12 * settings.warfareShare), "at most warfareShare of the earners");
	const on = sim.warfare.find((change) => change.engaged);
	assert.ok(on, "clashes go on once power is up");
	const before = sim.history.filter((point) => point.time <= on.time).at(-1);
	assert.ok(outlookAt(before) >= settings.engageAt, `engaged at an outlook of ${outlookAt(before)}`);
	assert.ok(sim.history.at(-1).territory > 0.2, "land is won");
	const log = JSON.parse(sim.ns.files[LOG_FILE]);
	assert.ok(Math.abs(log.milestones.firstClash - on.time) <= 5, `first clash noted at ${log.milestones.firstClash}s, engaged at ${on.time}s`);
});

test("all the land is ours: nobody does Territory Warfare and clashes go off (no gang left to clash with)", async () => {
	const others = { "Tetrads": { power: 50, territory: 0 }, "The Syndicate": { power: 50, territory: 0 } };
	const sim = fullGang({ territory: 1, power: 100, engaged: true, others, npcGrowth: false });
	await sim.run(main, 30 * MIN);
	assert.deepEqual(sim.warfare.map((change) => change.engaged), [false]);
	assert.ok(sim.warfare[0].time <= 5, "off at the first update");
	assert.ok(sim.history.every((point) => !point.tasks["Territory Warfare"]));
});

test("--no-war: nobody does Territory Warfare and clashes stay off, even against weak rivals", async () => {
	const others = { "Tetrads": { power: 0.1, territory: 0.4 }, "The Syndicate": { power: 0.1, territory: 0.4 } };
	const sim = fullGang({ territory: 0.2, power: 1e3, others, npcGrowth: false, args: ["--no-war"] });
	await sim.run(main, HOUR);
	assert.ok(sim.history.every((point) => !point.tasks["Territory Warfare"]));
	assert.deepEqual(sim.warfare, []);
});

test("clashes go off again when the rivals pull ahead (outlook under disengageAt)", async () => {
	const others = { "Tetrads": { power: 1, territory: 0.4 }, "The Syndicate": { power: 1, territory: 0.4 } };
	const sim = fullGang({ territory: 0.2, power: 100, others, npcGrowth: false });
	sim.at(30 * MIN, (s) => { for (const rival of Object.values(s.rivals)) rival.power = 1e6; });
	await sim.run(main, HOUR);
	assert.deepEqual(sim.warfare.map((change) => change.engaged), [true, false]);
	const off = sim.warfare[1].time;
	assert.ok(off >= 30 * 60 && off <= 30 * 60 + 10, "off at the first update after the rivals' jump");
	const before = sim.history.filter((point) => point.time <= off).at(-1);
	assert.ok(outlookAt(before) < settings.disengageAt, `outlook ${outlookAt(before)}`);
});

test("regression: a member killed in a clash is reported and counted even when respect lets recruit() fill the place before the next plan", async () => {
	const sim = fullGang();
	sim.at(10 * MIN, (s) => s.kill("member-5"));
	await sim.run(main, 15 * MIN);
	assert.ok(sim.ns.toasts.some((line) => /lost 1 member/.test(line)));
	assert.deepEqual(sim.recruits.map((entry) => entry.name), ["member-5"], "the place is filled at once, under the lowest free name");
	assert.match(sim.summary().lines[2], /1 deaths/);
});

test("equipment: no room for the list helper means nothing is bought (and says so) until it fits; --no-buy never buys", async () => {
	const sim = fullGang();
	sim.helperRoom = false;
	sim.at(10 * MIN, (s) => { s.helperRoom = true; });
	await sim.run(main, 20 * MIN);
	assert.ok(sim.ns.logs.some((line) => /no room yet for gang\/workers\/equipment\.js/.test(line)));
	assert.ok(sim.purchases.length > 0, "bought once the helper ran");
	assert.ok(sim.purchases.every((entry) => entry.time >= 10 * 60), "nothing before the list arrived");

	const roomy = fullGang();
	await roomy.run(main, 5 * MIN);
	assert.ok(!roomy.ns.logs.some((line) => /no room yet/.test(line)), "no complaint when the helper fits");

	const noBuy = fullGang({ args: ["--no-buy"] });
	await noBuy.run(main, 20 * MIN);
	assert.deepEqual(noBuy.purchases, []);
	assert.equal(noBuy.ns.called("exec").length, 0, "the list helper is never needed");
});
