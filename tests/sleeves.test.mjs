// sleeves/: the planner's decisions (sleeves/plan.js) as pure functions, then the manager and the shop run against
// tests/support/fake-sleeves.mjs (a sleeve world with the real one-shot workers).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { sleeveWorld } from "./support/fake-sleeves.mjs";
import { DEFAULTS } from "/config.js";
import { loadConfig } from "/utils/config.js";
import { sleevesApiFromInfo, sleevesBuyableFromInfo } from "/utils/sleeves.js";
import { GYMS, GYM_CASH_SECONDS } from "/utils/gyms.js";
import { sleevesReady } from "/sleeves/ready.js";
import {
	planSleeves, crimeChance, pickCashCrime, needsRecovery, needsSync, trainingFor, combatTarget, pickStage, budgetFor, nextPurchase, sameTask, family,
} from "/sleeves/plan.js";
import { main as manage, CONFIG as MANAGER_CONFIG } from "/sleeves/sleeve-manager.js";
import { main as shop } from "/sleeves/sleeve-shop.js";

const config = loadConfig(fakeNs());
const rule = config.sleeves;
const ALL_TRAINED = { hacking: 500, strength: 200, defense: 200, dexterity: 200, agility: 200, charisma: 50 };
/** A sleeve with no shock, full sync, trained skills and no task. */
const sleeve = (index, extra = {}) => ({ index, shock: 0, sync: 100, memory: 50, city: "Sector-12", skills: { ...ALL_TRAINED }, mults: { crime_success: 1 }, task: null, ...extra });
/** Planner input with nothing going on. */
const state = (sleeves, extra = {}) => ({
	sleeves, cash: 1e9, goals: null, playerFaction: "", joined: [], jobs: {}, invite: null, bb: { state: "off", trainFloor: 100 }, crimes: null, ...extra,
});
const planOf = (input, settings = config) => planSleeves(input, settings);

test("default config: sleeves are on, with a kill switch and spending stages that ascend from income 0", () => {
	assert.equal(DEFAULTS.sleeves.enabled, true);
	assert.equal(DEFAULTS.sleeves.buying[0].minIncome, 0);
	assert.deepEqual(DEFAULTS.sleeves.buying.map((stage) => stage.minIncome), [...DEFAULTS.sleeves.buying.map((stage) => stage.minIncome)].sort((a, b) => a - b));
});

test("capability: the Sleeve API is BitNode 10 or Source-File 10; buying only in BitNode 10", () => {
	const info = (node, owned = []) => ({ currentNode: node, ownedSF: new Map(owned) });
	assert.equal(sleevesApiFromInfo(info(10)), true);
	assert.equal(sleevesApiFromInfo(info(1, [[10, 1]])), true);
	assert.equal(sleevesApiFromInfo(info(1)), false);
	assert.equal(sleevesBuyableFromInfo(info(10)), true);
	assert.equal(sleevesBuyableFromInfo(info(1, [[10, 3]])), false, "Source-File 10 hands out sleeves but sells none");
	assert.equal(sleevesReady(fakeNs({ overrides: { getResetInfo: () => info(1) } }), config), false);
	assert.equal(sleevesReady(fakeNs({ overrides: { getResetInfo: () => info(1, [[10, 1]]) } }), config), true);
	assert.equal(sleevesReady(fakeNs({ overrides: { getResetInfo: () => info(10) } }), config), true, "BitNode 10 with no sleeve yet: the shop buys the first");
	assert.equal(sleevesReady(fakeNs({ overrides: { getResetInfo: () => info(10) } }), { sleeves: { enabled: false } }), false, "kill switch");
});

test("shock recovery starts at `enter`, keeps going until `exit`, and comes before synchronizing", () => {
	assert.equal(needsRecovery(sleeve(0, { shock: rule.shock.enter }), rule.shock), true);
	assert.equal(needsRecovery(sleeve(0, { shock: rule.shock.enter - 1 }), rule.shock), false);
	const recovering = (shock) => sleeve(0, { shock, task: { type: "RECOVERY" } });
	assert.equal(needsRecovery(recovering(rule.shock.exit + 1), rule.shock), true, "a recovering sleeve is not pulled off at the first dip");
	assert.equal(needsRecovery(recovering(rule.shock.exit), rule.shock), false);
	const [entry] = planOf(state([sleeve(0, { shock: 80, sync: 10 })]));
	assert.equal(entry.role, "recover");
});

test("synchronization starts below `enter`, keeps going until `exit`", () => {
	assert.equal(needsSync(sleeve(0, { sync: rule.sync.enter - 1 }), rule.sync), true);
	assert.equal(needsSync(sleeve(0, { sync: rule.sync.enter }), rule.sync), false);
	assert.equal(needsSync(sleeve(0, { sync: rule.sync.exit - 1, task: { type: "SYNCHRO" } }), rule.sync), true);
	assert.equal(needsSync(sleeve(0, { sync: rule.sync.exit, task: { type: "SYNCHRO" } }), rule.sync), false);
	assert.equal(planOf(state([sleeve(0, { sync: 20 })]))[0].role, "sync");
});

test("game: a crime's success chance is the weighted skills over 975, over its difficulty, times the crime success multiplier", () => {
	const stats = { difficulty: 2, weights: { strength: 2, defense: 2, dexterity: 0.5, agility: 0.5 } };
	const skills = { strength: 100, defense: 100, dexterity: 100, agility: 100 };
	const expected = (2 * 100 + 2 * 100 + 0.5 * 100 + 0.5 * 100) / 975 / 2;
	assert.equal(crimeChance(skills, { crime_success: 1 }, stats), expected);
	assert.equal(crimeChance(skills, { crime_success: 1.5 }, stats), expected * 1.5);
	assert.equal(crimeChance({ strength: 1e9 }, undefined, stats), 1, "a chance never passes 1");
});

test("cash crime with the game's crime stats: the most money per second among crimes that succeed often enough, else the likeliest", () => {
	const crimes = {
		Easy: { difficulty: 0.05, time: 2000, money: 15e3, weights: { dexterity: 1, agility: 1 } },
		Hard: { difficulty: 8, time: 80_000, money: 1.6e6, weights: { dexterity: 4, agility: 2 } },
	};
	const strong = sleeve(0, { skills: { dexterity: 500, agility: 500 } });
	const rate = (name, person) => crimeChance(person.skills, person.mults, crimes[name]) * crimes[name].money / (crimes[name].time / 1000);
	const best = pickCashCrime(strong, crimes, rule.crimeLadder, rule.minCrimeChance);
	const likely = Object.keys(crimes).filter((name) => crimeChance(strong.skills, strong.mults, crimes[name]) >= rule.minCrimeChance);
	assert.equal(best.crime, likely.sort((a, b) => rate(b, strong) - rate(a, strong))[0], "the best rate among the crimes that succeed often enough");
	assert.ok(best.chance >= rule.minCrimeChance);
	const weak = sleeve(0, { skills: { dexterity: 1, agility: 1 } });
	const likeliest = pickCashCrime(weak, crimes, rule.crimeLadder, 0.99);
	assert.equal(likeliest.crime, "Easy", "nothing reaches the minimum chance: the likeliest crime");
});

test("cash crime without the crime stats: the last ladder rung the average combat level reaches", () => {
	const at = (level) => pickCashCrime(sleeve(0, { skills: { strength: level, defense: level, dexterity: level, agility: level } }), null, rule.crimeLadder, 0.5).crime;
	for (const [crime, from] of rule.crimeLadder) assert.equal(at(from), rule.crimeLadder.filter(([, level]) => level <= from).pop()[0], `${crime} from ${from}`);
	assert.equal(at(0), rule.crimeLadder[0][0]);
});

test("combat target follows the run: Bladeburner's floor while it is the route, the gang invite's gym level, a number in the config wins", () => {
	assert.equal(combatTarget(state([]), rule.train), 0, "nothing needs combat");
	assert.equal(combatTarget(state([], { bb: { state: "run", trainFloor: 120 } }), rule.train), 120);
	assert.equal(combatTarget(state([], { bb: { state: "hold", trainFloor: 120 } }), rule.train), 0, "a held Bladeburner needs no combat");
	assert.equal(combatTarget(state([], { invite: { applies: true, crime: "Homicide", gym: 45 } }), rule.train), 45);
	assert.equal(combatTarget(state([], { bb: { state: "run", trainFloor: 120 } }), { ...rule.train, combat: 60 }), 60);
});

test("training: the lowest combat stat goes to the best gym the cash allows; a city without a gym means a flight, but only with the cash for it", () => {
	const input = state([], { bb: { state: "train", trainFloor: 100 } });
	const low = sleeve(0, { skills: { ...ALL_TRAINED, strength: 90, defense: 40, dexterity: 80, agility: 70 } });
	const [best, cheap] = [GYMS["Sector-12"][0], GYMS["Sector-12"].at(-1)];
	const rich = trainingFor(low, { ...input, cash: best[1] * GYM_CASH_SECONDS }, config);
	assert.deepEqual([rich.kind, rich.stat, rich.gym, rich.travel], ["gym", "def", best[0], null]);
	assert.equal(trainingFor(low, { ...input, cash: best[1] * GYM_CASH_SECONDS - 1 }, config).gym, cheap[0], "the better gym needs cash for its running cost");
	const abroad = sleeve(0, { city: "Chongqing", skills: low.skills });
	assert.equal(trainingFor(abroad, { ...input, cash: 1e5 }, config), null, "no cash for the flight");
	assert.equal(trainingFor(abroad, { ...input, cash: 1e8 }, config).travel, "Sector-12");
	assert.equal(trainingFor(sleeve(0), input, config), null, "trained enough");
});

test("training: hacking below the study target studies at the configured university", () => {
	const weak = sleeve(0, { skills: { ...ALL_TRAINED, hacking: 1 } });
	const entry = trainingFor(weak, state([weak]), config);
	assert.equal(entry.kind, "class");
	assert.equal(entry.university, config.studying.university);
	assert.equal(trainingFor(sleeve(0, { skills: { ...ALL_TRAINED, hacking: config.studying.hackLevel } }), state([]), config), null);
	const never = { ...config, sleeves: { ...rule, train: { ...rule.train, hacking: 0 } } };
	assert.equal(trainingFor(weak, state([weak]), never), null, "0 = never train hacking");
});

test("the summary says why a sleeve trains: which stat, or hacking", () => {
	const gym = planOf(state([sleeve(0, { skills: { ...ALL_TRAINED, strength: 1 } })], { bb: { state: "run", trainFloor: 100 } }));
	assert.match(gym[0].why, /^str below 100$/);
	const study = planOf(state([sleeve(0, { skills: { ...ALL_TRAINED, hacking: 1 } })]));
	assert.match(study[0].why, new RegExp(`^hacking below ${config.studying.hackLevel}$`));
});

test("jobs: the gang invite's karma goes to every free sleeve as Homicide", () => {
	const plan = planOf(state([sleeve(0), sleeve(1)], { invite: { applies: true, crime: "Homicide", gain: "karma", gym: 0 } }));
	assert.deepEqual(plan.map((entry) => [entry.role, entry.candidates[0].crime]), [["karma", "Homicide"], ["karma", "Homicide"]]);
	const combat = planOf(state([sleeve(0)], { invite: { applies: true, crime: "Homicide", gain: "combat exp", gym: 0 } }));
	assert.equal(combat[0].role, "cash", "only a karma gap makes the sleeves grind karma");
});

test("jobs: Bladeburner contracts only while the division is played (state run), in the configured order", () => {
	const run = planOf(state([sleeve(0)], { bb: { state: "run", trainFloor: 100 } }));
	assert.equal(run[0].role, "bladeburner");
	assert.deepEqual(run[0].candidates.map((candidate) => candidate.contract), rule.bladeburner.contracts);
	assert.equal(planOf(state([sleeve(0)], { bb: { state: "hold", trainFloor: 100 } }))[0].role, "cash");
});

test("jobs: factions with a rep goal get one sleeve each, never the faction the player works, up to factionShare", () => {
	const [first, second, third] = config.factionWork.order;
	const goals = Object.fromEntries([first, second, third].map((faction) => [faction, { rep: 1000 }]));
	const sleeves = [sleeve(0), sleeve(1), sleeve(2), sleeve(3)];
	const plan = planOf(state(sleeves, { goals, joined: [first, second, third], playerFaction: first }));
	const factions = plan.filter((entry) => entry.role === "faction").map((entry) => entry.candidates[0].faction);
	assert.deepEqual(factions, [second, third], "the player's own faction is left to player-work.js");
	assert.ok(factions.length <= Math.ceil(sleeves.length * rule.factionShare));
	assert.deepEqual(plan.filter((entry) => entry.role === "cash").length, sleeves.length - factions.length);
	const none = planOf(state(sleeves, { goals: { [first]: { rep: 0 } }, joined: [first] }));
	assert.ok(none.every((entry) => entry.role === "cash"), "a goal of 0 rep is not worth a sleeve");
	const notJoined = planOf(state(sleeves, { goals, joined: [] }));
	assert.ok(notJoined.every((entry) => entry.role === "cash"), "an unjoined faction can't be worked for");
});

test("jobs: company work only where the player holds a job, at most companyShare of the sleeves", () => {
	const company = config.companyWork.companies[0].company;
	const sleeves = [0, 1, 2, 3].map((index) => sleeve(index));
	const plan = planOf(state(sleeves, { jobs: { [company]: "Software Engineer" } }));
	assert.equal(plan.filter((entry) => entry.role === "company").length, Math.min(1, Math.floor(sleeves.length * rule.companyShare)));
	assert.ok(planOf(state(sleeves)).every((entry) => entry.role === "cash"), "no job, no company work");
});

test("a sleeve already doing a job keeps it (the job goes to it, not to the lowest-numbered sleeve)", () => {
	const [first] = config.factionWork.order;
	const goals = { [first]: { rep: 1000 } };
	const working = sleeve(1, { task: { type: "FACTION", factionName: first, factionWorkType: config.factionWork.workType } });
	const plan = planOf(state([sleeve(0), working], { goals, joined: [first] }));
	assert.equal(plan[1].role, "faction");
	assert.equal(plan[1].keep, true, "nothing is sent for a sleeve that already does it");
	assert.equal(plan[0].role, "cash");
});

test("every candidate belongs to a worker family, and sameTask recognises what a worker started", () => {
	assert.deepEqual(["recover", "sync", "crime", "gym", "class", "faction", "company", "bb"].map((kind) => family({ kind })), ["recover", "recover", "crime", "train", "train", "work", "work", "blade"]);
	assert.equal(sameTask({ type: "CRIME", crimeType: "Mug" }, { kind: "crime", crime: "Mug" }), true);
	assert.equal(sameTask({ type: "CRIME", crimeType: "Mug" }, { kind: "crime", crime: "Homicide" }), false);
	assert.equal(sameTask({ type: "CLASS", classType: "GYMSTRENGTH" }, { kind: "gym", stat: "str" }), true);
	assert.equal(sameTask({ type: "CLASS", classType: "GYMSTRENGTH" }, { kind: "gym", stat: "def" }), false);
	assert.equal(sameTask(null, { kind: "recover" }), false);
	assert.equal(sameTask({ type: "CLASS", classType: "STUDYCOMPUTERSCIENCE" }, { kind: "class" }), true);
	assert.equal(sameTask({ type: "CLASS", classType: "GYMSTRENGTH" }, { kind: "class" }), false, "a gym class is not a university course");
	const faction = { type: "FACTION", factionName: "CyberSec", factionWorkType: "hacking" };
	assert.equal(sameTask(faction, { kind: "faction", faction: "CyberSec", work: "hacking" }), true);
	assert.equal(sameTask(faction, { kind: "faction", faction: "NiteSec", work: "hacking" }), false);
	assert.equal(sameTask(faction, { kind: "faction", faction: "CyberSec", work: "field" }), false);
	assert.equal(sameTask({ type: "COMPANY", companyName: "ECorp" }, { kind: "company", company: "ECorp" }), true);
	assert.equal(sameTask({ type: "COMPANY", companyName: "ECorp" }, { kind: "company", company: "NWO" }), false);
	assert.equal(sameTask({ type: "FACTION", factionName: "ECorp" }, { kind: "company", company: "ECorp" }), false);
	assert.equal(sameTask({ type: "BLADEBURNER", actionName: "Tracking" }, { kind: "bb", contract: "Tracking" }), true);
	assert.equal(sameTask({ type: "BLADEBURNER", actionName: "Tracking" }, { kind: "bb", contract: "Retirement" }), false);
	assert.equal(sameTask({ type: "CRIME", crimeType: "Mug" }, { kind: "bb", contract: "Tracking" }), false);
});

test("training: studying abroad needs a flight, which needs cash; in the university's city there is none", () => {
	const weak = (city) => sleeve(0, { city, skills: { ...ALL_TRAINED, hacking: 1 } });
	const home = trainingFor(weak(config.studying.city), state([], { cash: 0 }), config);
	assert.equal(home.travel, null);
	assert.equal(trainingFor(weak("Volhaven"), state([], { cash: 1e5 }), config), null);
	assert.equal(trainingFor(weak("Volhaven"), state([], { cash: 1e8 }), config).travel, config.studying.city);
});

test("cash crime with the game's crime stats picks the best of several, not the first or last listed", () => {
	const person = sleeve(0, { skills: { dexterity: 1000, agility: 1000, strength: 1000, defense: 1000, hacking: 1000, charisma: 1000 } });
	const weights = { dexterity: 1 };
	const crimes = {
		Slow: { difficulty: 1, time: 100_000, money: 1e5, weights },
		Fast: { difficulty: 1, time: 1000, money: 1e5, weights },
		Slower: { difficulty: 1, time: 500_000, money: 1e5, weights },
	};
	assert.equal(pickCashCrime(person, crimes, rule.crimeLadder, 0.5).crime, "Fast");
	const unlikely = { A: { difficulty: 1e4, time: 1000, money: 1, weights }, B: { difficulty: 5e3, time: 1000, money: 1, weights }, C: { difficulty: 8e3, time: 1000, money: 1, weights } };
	assert.equal(pickCashCrime(person, unlikely, rule.crimeLadder, 0.5).crime, "B", "none reaches the minimum chance: the likeliest, wherever it is listed");
});

test("spending: the stage follows income, and the budget is the smaller of the share of cash and the cash above the reserve", () => {
	const stages = rule.buying;
	assert.equal(pickStage(stages, 0), stages[0]);
	assert.equal(pickStage(stages, stages[2].minIncome), stages[2]);
	assert.equal(pickStage(stages, 1e12), stages.at(-1));
	const stage = { reserve: 1e6, maxFraction: 0.1 };
	assert.equal(budgetFor(1e9, stage), 1e8);
	assert.equal(budgetFor(1.05e6, stage), 5e4, "never into the reserve");
	assert.equal(budgetFor(5e5, stage), 0);
});

test("purchases: a sleeve first, then memory for the lowest-memory sleeve, then the augmentation with the most value per dollar", () => {
	const view = {
		budget: 1e7, canBuy: true, buy: rule.buy, sleeveCost: 5e6,
		memory: [{ index: 0, memory: 60, cost: 1e5 }, { index: 1, memory: 20, cost: 2e5 }],
		augs: [{ index: 0, name: "Cheap", cost: 1e5, value: 1 }, { index: 0, name: "Dense", cost: 1e5, value: 4 }, { index: 1, name: "Dud", cost: 1e3, value: 0 }],
	};
	assert.equal(nextPurchase(view).type, "sleeve");
	assert.deepEqual(nextPurchase({ ...view, sleeveCost: 5e8 }), { type: "memory", index: 1, cost: 2e5 });
	assert.deepEqual(nextPurchase({ ...view, sleeveCost: Infinity, memory: [] }), { type: "aug", index: 0, name: "Dense", cost: 1e5 });
	assert.equal(nextPurchase({ ...view, sleeveCost: Infinity, memory: [], augs: [view.augs[2]] }), null, "an augmentation valued 0 is never bought");
	assert.equal(nextPurchase({ ...view, canBuy: false }).type, "aug", "outside BitNode 10 only augmentations");
	assert.equal(nextPurchase({ ...view, sleeveCost: Infinity, memory: [{ index: 0, memory: 100, cost: 1 }], augs: [] }), null, "memory stops at 100");
	assert.equal(nextPurchase({ ...view, sleeveCost: Infinity, memory: [], augs: [{ index: 0, name: "A", cost: 9e5 }, { index: 0, name: "B", cost: 1e5 }] }).name, "B", "unknown values: cheapest first");
	assert.equal(nextPurchase({ ...view, buy: { sleeves: false, memory: false, augments: false } }), null, "each kind has its own switch");
});

// --- the manager ---

test("manager without the Sleeve API: the advice once, no sleeve calls, nothing posted", async () => {
	const sim = sleeveWorld({ node: 1 });
	await manage(sim.ns);
	assert.equal(sim.ns.terminal.length, 1);
	assert.match(sim.ns.terminal[0], /Sleeve API.*destroy BitNode 10/);
	assert.equal(sim.ns.called("sleeve.getNumSleeves").length, 0);
	assert.equal(sim.ns.portJson(40), null);
});

test("manager kill switch: sleeves.enabled false does nothing at all", async () => {
	const sim = sleeveWorld({ files: { "data/config.json": JSON.stringify({ sleeves: { enabled: false } }) } });
	await manage(sim.ns);
	assert.equal(sim.ns.called("sleeve.getNumSleeves").length, 0);
	assert.equal(sim.ns.terminal.length, 0);
});

test("manager in BitNode 10 with no sleeves yet: says so and waits for the shop", async () => {
	const sim = sleeveWorld({ sleeves: [] });
	await manage(sim.ns);
	assert.match(sim.ns.portJson(40).lines[0], /no sleeves yet/);
});

test("manager: a shocked sleeve recovers, a healthy one commits a crime, the summary says so, and a second pass changes nothing", async () => {
	const sim = sleeveWorld({ sleeves: [{ shock: 90 }, {}] });
	await manage(sim.ns);
	assert.equal(sim.sleeves[0].task.type, "RECOVERY");
	assert.equal(sim.sleeves[1].task.type, "CRIME");
	const summary = sim.ns.portJson(40);
	assert.equal(summary.title, "Sleeves");
	assert.equal(summary.oneShot, true);
	assert.match(summary.lines[0], /^2 sleeves: 1 recover, 1 cash$/);
	assert.equal(summary.lines.length, 3, "a summary line and one per sleeve");
	const workers = sim.ns.called("exec").length;
	await manage(sim.ns);
	assert.equal(sim.ns.called("exec").length, workers, "sleeves already doing their job are left alone: no worker starts");
});

test("manager: a faction the game refuses falls back to cash crime in the same pass", async () => {
	const [first] = config.factionWork.order;
	const sim = sleeveWorld({ sleeves: [{}], refuse: ["faction"], ports: { 23: { time: Date.now(), goals: { [first]: { rep: 5000 } } } } });
	sim.player.factions.push(first);
	await manage(sim.ns);
	assert.equal(sim.calls("setToFactionWork").length, config.factionWork.workType ? 3 : 0, "every work type was tried");
	assert.equal(sim.sleeves[0].task?.type, "CRIME");
	assert.match(sim.ns.portJson(40).lines.join("\n"), /refused/);
});

test("manager: with the Singularity API the game's crime stats are read once per run and decide the crime", async () => {
	const sim = sleeveWorld({ node: 10, sourceFiles: [[4, 3]], sleeves: [{ skills: { strength: 300, defense: 300, dexterity: 300, agility: 300 } }] });
	await manage(sim.ns);
	assert.equal(sim.ns.called("singularity.getCrimeStats").length, 2, "one call per crime");
	assert.ok(sim.ns.portJson(43).crimes.Homicide, "posted for the next pass");
	await manage(sim.ns);
	assert.equal(sim.ns.called("singularity.getCrimeStats").length, 2, "not asked for again");
	assert.equal(sim.sleeves[0].task.type, "CRIME");
});

test("manager: without enough RAM for a worker it says so and tries again, rather than failing", async () => {
	const sim = sleeveWorld({ sleeves: [{ shock: 90 }], scriptRam: () => 1e6 });
	await manage(sim.ns);
	assert.equal(sim.sleeves[0].task, null);
	assert.match(sim.ns.portJson(40).lines.join("\n"), /no room for the recover worker/);
});

test("regression guard: every worker the manager starts is in its copy list and exists", () => {
	for (const key of Object.keys(MANAGER_CONFIG).filter((name) => name.endsWith("Helper"))) {
		assert.ok(Array.isArray(MANAGER_CONFIG[key.replace("Helper", "Imports")]), key);
	}
});

// --- the shop ---

test("shop in BitNode 10: buys a sleeve first, then memory, within the budget of the spending stage", async () => {
	const sim = sleeveWorld({ node: 10, sleeves: [{ memory: 10 }], money: 1e9, sleeveCost: 5e6, memoryCost: 1e6 });
	await shop(sim.ns);
	const budget = Math.min(1e9 * rule.buying[0].maxFraction, 1e9 - rule.buying[0].reserve);
	assert.equal(sim.calls("purchaseSleeve").length > 0, true);
	assert.equal(sim.sleeves.length > 1, true);
	const spent = 1e9 - sim.wallet.money;
	assert.ok(spent <= budget, `spent $${spent} of a $${budget} budget`);
	assert.ok(sim.calls("upgradeMemory").length > 0, "what is left goes to memory");
	assert.ok(sim.ns.toasts.some((line) => /bought sleeve #1/.test(line)));
});

test("shop with Source-File 10 outside BitNode 10: no sleeves or memory are bought, only augmentations (cheapest first without stats)", async () => {
	const sim = sleeveWorld({ node: 1, sourceFiles: [[10, 1]], sleeves: [{}], money: 1e9, augs: [{ name: "Big", cost: 5e7 }, { name: "Small", cost: 1e6 }] });
	await shop(sim.ns);
	assert.equal(sim.calls("purchaseSleeve").length + sim.calls("upgradeMemory").length, 0);
	assert.equal(sim.ns.called("sleeve.getSleeveCost").length, 0);
	assert.deepEqual(sim.calls("purchaseSleeveAug").map(([, name]) => name)[0], "Small");
});

test("shop with the Singularity API: the augmentation worth most per dollar is bought, one valued 0 never", async () => {
	const sim = sleeveWorld({
		node: 1, sourceFiles: [[10, 1], [4, 3]], sleeves: [{}], money: 1e9,
		augs: [{ name: "Plain Chip", cost: 1e5 }, { name: "Hack Chip", cost: 2e5 }],
	});
	await shop(sim.ns);
	const bought = sim.calls("purchaseSleeveAug").map(([, name]) => name);
	assert.deepEqual(bought, ["Hack Chip"], "the unvalued chip adds nothing the config wants");
});

test("shop: nothing is bought with no cash above the reserve, and the kill switch skips the pass", async () => {
	const poor = sleeveWorld({ node: 10, sleeves: [{}], money: rule.buying[0].reserve });
	await shop(poor.ns);
	assert.equal(poor.apiLog.filter((entry) => ["purchaseSleeve", "upgradeMemory", "purchaseSleeveAug"].includes(entry.name)).length, 0);
	const off = sleeveWorld({ node: 10, money: 1e9, files: { "data/config.json": JSON.stringify({ sleeves: { enabled: false } }) } });
	await shop(off.ns);
	assert.equal(off.ns.called("sleeve.getNumSleeves").length, 0);
});
