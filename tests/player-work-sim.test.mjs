// singularity/player-work.js main loop, run pass after pass (--once, one simulated minute apart, as startup.js runs it)
// against tests/support/fake-player.mjs. These check what the passes promise together: the order of the work, one
// city group and never a rival, no restarting work every pass, what survives between passes and what an install
// clears, retrying when there's no room for a helper, and the done gate. tests/player-work.test.mjs checks single steps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { playerSim } from "./support/fake-player.mjs";
import { main } from "/singularity/player-work.js";
import { DEFAULTS } from "/config.js";

const STUDY_LEVEL = DEFAULTS.studying.hackLevel;
const GROUPS = DEFAULTS.cities.groups;
const groupOf = (faction) => GROUPS.findIndex((group) => group.includes(faction));
const NEEDS = { "Sector-12": ["CashRoot Starter Kit"], "Aevum": ["PCMatrix"], "Chongqing": ["Neuregen Gene Modification"] };
const NO_COMPANY = { companyWork: { companies: [] } };
const PER_PASS_REP = 2000; // fake-player.mjs faction work: rep per simulated minute

test("a new run, pass by pass: study, Tian Di Hui, one city group, then faction work in order, each stopping at its goal", async () => {
	const goals = { "Tian Di Hui": 20_000, "Sector-12": 10_000, "Aevum": 6_000 };
	const sim = playerSim({ income: 30_000, goals, cityNeeds: NEEDS, config: NO_COMPANY });
	await sim.passes(main, 60);

	// Study comes first, once: the free class, then the paid one when the cash covers it, never restarted every pass
	const classes = sim.started.filter((entry) => entry.kind === "class");
	assert.ok(classes.length >= 1 && classes.length <= 2, `classes started: ${JSON.stringify(classes)}`);
	const work = sim.started.filter((entry) => entry.kind === "faction");
	assert.ok(work.length > 0 && work.every((entry) => entry.hacking >= STUDY_LEVEL), "no faction work before the study target");

	// Tian Di Hui, then the first group that sells something wanted; never a rival of a joined city faction
	const joined = sim.joins.map((entry) => entry.faction);
	assert.deepEqual(joined, ["Tian Di Hui", "Sector-12", "Aevum"]);
	assert.equal(new Set(joined.filter((faction) => groupOf(faction) >= 0).map(groupOf)).size, 1, "one city group per run");

	// Flights: each paid for, and no back and forth (Chongqing for Tian Di Hui, then the group's cities)
	assert.ok(sim.flights.every((flight) => flight.money >= 200e3));
	assert.deepEqual(sim.flights.map((flight) => flight.to), ["Chongqing", "Sector-12", "Aevum"]);

	// Faction work in factionWork.order, each started once and left once its goal is met (within a pass of rep)
	const order = DEFAULTS.factionWork.order;
	assert.deepEqual(work.map((entry) => entry.name), Object.keys(goals).sort((a, b) => order.indexOf(a) - order.indexOf(b)));
	for (const [faction, goal] of Object.entries(goals)) {
		assert.ok(sim.rep[faction] >= goal && sim.rep[faction] <= goal + PER_PASS_REP, `${faction}: ${sim.rep[faction]} rep for a ${goal} goal`);
	}
	// The done gate only once the last goal is met
	const last = work.at(-1);
	assert.ok(sim.gateAt === null || sim.gateAt >= last.time + goals[last.name] / PER_PASS_REP - 1, `done gate at minute ${sim.gateAt}`);
	// Every pass says what each part did
	assert.ok(sim.lines.every((lines) => lines.some((line) => /^\[(tdh|city)\]/.test(line)) && lines.some((line) => /^\[(study|faction-work|company-work|idle)\]/.test(line))));
});

test("a class the player stopped by hand is left alone on later passes (the pass state survives on its port)", async () => {
	const sim = playerSim({ income: 0, cityNeeds: NEEDS, config: NO_COMPANY });
	await sim.passes(main, 3);
	assert.equal(sim.work?.type, "CLASS");
	sim.work = null; // the player stops it
	await sim.passes(main, 5);
	assert.equal(sim.work, null);
	assert.equal(sim.started.filter((entry) => entry.kind === "class").length, 1);
	assert.match(sim.lines.at(-1).join("\n"), /the class was stopped; leaving your work alone/);
});

test("an install starts the pass state fresh: the class is started again in the new run", async () => {
	const sim = playerSim({ income: 0, cityNeeds: NEEDS, config: NO_COMPANY });
	await sim.passes(main, 2);
	sim.work = null;
	sim.resetAt = sim.now; // augmentations installed
	await sim.passes(main, 1);
	assert.equal(sim.work?.type, "CLASS");
	assert.equal(sim.started.filter((entry) => entry.kind === "class").length, 2);
});

test("with a city faction already joined, its group is kept even when a rival sells something wanted", async () => {
	const sim = playerSim({
		hacking: 100, money: 1e9, income: 30_000, factions: ["Tian Di Hui", "Sector-12"],
		cityNeeds: { "Chongqing": ["Neuregen Gene Modification"] }, config: NO_COMPANY,
	});
	await sim.passes(main, 10);
	assert.deepEqual(sim.joins, []);
	assert.deepEqual(sim.flights, []);
	assert.match(sim.lines.at(-1).join("\n"), /\[city\] joined everything wanted in Sector-12 \+ Aevum; .*later run goes for Chongqing/);
});

test("no room for the goals helper: no faction work, says so each pass, and starts once room appears", async () => {
	let goalsRam = 10_000;
	const sim = playerSim({
		hacking: 100, money: 1e9, factions: ["Tian Di Hui", "CyberSec"], goals: { CyberSec: 50_000 }, config: NO_COMPANY,
		scriptRam: (script) => (script === "singularity/workers/faction-goals.js" ? goalsRam : 2),
	});
	await sim.passes(main, 3);
	assert.equal(sim.started.filter((entry) => entry.kind === "faction").length, 0);
	assert.ok(sim.lines.every((lines) => lines.some((line) => /no room yet for singularity\/workers\/faction-goals\.js/.test(line))));
	assert.equal(sim.gateAt, null, "rep goals unknown: not done");
	goalsRam = 2;
	await sim.passes(main, 1);
	assert.deepEqual(sim.started.filter((entry) => entry.kind === "faction").map((entry) => entry.name), ["CyberSec"]);
});

test("everything done (studied, joined, every goal met, no company or gang left): the done gate is posted for startup.js", async () => {
	const sim = playerSim({
		hacking: 100, money: 1e9, factions: ["Tian Di Hui", "CyberSec"], goals: { CyberSec: 4_000 }, config: NO_COMPANY,
	});
	await sim.passes(main, 5);
	const gates = JSON.parse(sim.ns.peek(33));
	assert.equal(gates["player-work"]?.done, true);
	assert.ok(sim.ns.toasts.some((line) => /worked everything it can; done/.test(line)));
	assert.ok(sim.rep.CyberSec >= 4_000);
	assert.ok(sim.gateAt >= 2, `not before CyberSec's goal (gate at minute ${sim.gateAt})`);
	// Where Bladeburner is possible it is never done: bb-manage.js may want the player later
	const bladeburner = playerSim({ node: 6, hacking: 100, money: 1e9, factions: ["Tian Di Hui", "CyberSec"], goals: { CyberSec: 4_000 }, config: NO_COMPANY });
	await bladeburner.passes(main, 5);
	assert.equal(bladeburner.gateAt, null);
});

test("focus: work is focused while unfocused work is penalised, unfocused once the goals helper says the implant is in; playerFocus wins", async () => {
	const firstFocus = async (options) => {
		const sim = playerSim({ hacking: 100, money: 1e9, factions: ["Tian Di Hui", "CyberSec"], goals: { CyberSec: 50_000 }, config: NO_COMPANY, ...options });
		await sim.passes(main, 1);
		return sim.started.find((entry) => entry.kind === "faction")?.focus;
	};
	assert.equal(await firstFocus({ focusPenalty: true }), true);
	assert.equal(await firstFocus({ focusPenalty: false }), false);
	assert.equal(await firstFocus({ focusPenalty: false, config: { ...NO_COMPANY, playerFocus: true } }), true);
	assert.equal(await firstFocus({ focusPenalty: true, config: { ...NO_COMPANY, playerFocus: false } }), false);
});

test("the helpers run when something changed, not every pass: goals on a join, a goal reached or every 10 minutes; the city plan every 10 minutes; the gang every 2", async () => {
	// Too little cash for a city invite, so the city part waits (a join would ask for the plan again at once)
	const sim = playerSim({ hacking: 100, money: 1e5, income: 0, factions: ["Tian Di Hui", "CyberSec"], goals: { CyberSec: 9_000, "Tian Di Hui": 1e9 },
		cityNeeds: NEEDS, config: NO_COMPANY });
	await sim.passes(main, 21);
	const runs = (script) => sim.helpers.filter((entry) => entry.script === script).map((entry) => entry.time);
	// Minute 0, CyberSec reaches 9,000 rep after 5 passes (asked again at once), then every 10 minutes
	const goals = runs("singularity/workers/faction-goals.js");
	assert.ok(goals.includes(0) && goals.includes(5) && goals.length <= 5, `goals helper at ${goals}`);
	assert.deepEqual(runs("singularity/workers/city-plan.js").filter((time) => time < 20), [0, 10], "the city plan every 10 minutes");
	assert.deepEqual(runs("gang/workers/invite.js"), [0], "no gang to work towards: asked once");
	// A faction joined (here by hand) asks for goals again on the next pass
	sim.player.factions.push("Netburners");
	const before = runs("singularity/workers/faction-goals.js").length;
	await sim.passes(main, 1);
	assert.equal(runs("singularity/workers/faction-goals.js").length, before + 1);
});

test("company work: once no faction needs rep, a job at the first megacorp until its faction joins, then the next; the player's own faction work is left alone", async () => {
	const repNeeded = DEFAULTS.companyWork.repNeeded;
	const config = { companyWork: { companies: [{ company: "ECorp", faction: "ECorp" }, { company: "NWO", faction: "NWO" }] } };
	const sim = playerSim({ hacking: 200, money: 1e9, factions: ["Tian Di Hui"], config,
		autoJoin: { ECorp: (p) => (p.companyRep.ECorp ?? 0) >= repNeeded, NWO: (p) => (p.companyRep.NWO ?? 0) >= repNeeded } });
	const minutes = Math.ceil(repNeeded / 50_000);
	await sim.passes(main, minutes + 3);
	assert.deepEqual(sim.started.filter((entry) => entry.kind === "company").map((entry) => entry.name), ["ECorp", "NWO"]);
	assert.ok(sim.companyRep.ECorp >= repNeeded && sim.companyRep.ECorp < repNeeded + 2 * 50_000, "ECorp work stopped once its faction joined");
	// Faction work the player started by hand stays
	sim.work = { type: "FACTION", factionName: "Tian Di Hui", factionWorkType: "hacking" };
	await sim.passes(main, 2);
	assert.equal(sim.work.type, "FACTION");
	assert.match(sim.lines.at(-1).join("\n"), /working for Tian Di Hui yourself; leaving it alone/);
});

test("gang invite (BitNode 2): the crime the helper picks comes before faction work; once it asks for nothing, the crime stops and faction work takes over", async () => {
	const invite = (player) => (player.karma > -500
		? { applies: true, faction: "Slum Snakes", missing: [`karma ${player.karma} / -9`], crime: "Homicide", rate: 60, chance: 0.5, gain: "karma", gym: 0, slow: false }
		: { applies: false });
	const sim = playerSim({ node: 2, hacking: 100, money: 1e9, factions: ["Tian Di Hui", "CyberSec"], goals: { CyberSec: 1e9 }, config: NO_COMPANY, gang: invite });
	await sim.passes(main, 9);
	const kinds = sim.started.map((entry) => `${entry.kind}:${entry.name}`);
	assert.equal(kinds[0], "crime:Homicide");
	assert.equal(kinds.filter((kind) => kind === "crime:Homicide").length, 1, "the crime isn't restarted every pass");
	assert.ok(kinds.includes("faction:CyberSec"), `then faction work: ${kinds}`);
	assert.ok(sim.started.find((entry) => entry.kind === "faction").time >= 5, "only once the karma is there (gang asked again every 2 minutes)");
	assert.ok(sim.gateAt === null || sim.gateAt >= 5, "not done while the gang still asks for something");
});
