// utils/training.js (which way raises the combat stats fastest), player-work.js trainStep / trainingChoice that act on it, and
// bb-manage.js trainingChosen (the Training player-work picked is left running). docs/combat-training.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import {
	COMBAT_CRIMES, CRIME_FAIL_SHARE, UNFOCUSED, BB_BONUS_SPEED, gymRates, crimeRates, bladeburnerTrainingRates, bonusSpeed, trainingScore, pickTraining,
} from "/utils/training.js";
import { GYMS, GYM_CASH_SECONDS } from "/utils/gyms.js";
import { trainStep, trainingChoice } from "/singularity/player-work.js";
import { trainingChosen } from "/bladeburner/bb-manage.js";
import { DEFAULTS } from "/config.js";

const BB_PORT = 36;
const POWERHOUSE = GYMS["Sector-12"][0];
const IRON = GYMS["Sector-12"][1];
const mults = (exp = 1) => ({ strength_exp: exp, defense_exp: exp, dexterity_exp: exp, agility_exp: exp });
const crime = (name) => COMBAT_CRIMES.find(([crimeName]) => crimeName === name);

// --- The game's rates ---

test("game: the gym gives its expMult x the stat's exp multiplier x the hash bonus per second, to the one stat trained", () => {
	const rates = gymRates({ ...mults(1), strength_exp: 2 }, POWERHOUSE[2], 1.5);
	assert.equal(POWERHOUSE[2], 10, "Powerhouse Gym is the x10 gym (LocationsMetadata.ts expMult)");
	assert.equal(rates.strength, 10 * 2 * 1.5);
	assert.equal(rates.defense, 10 * 1.5);
});

test("game: a crime's exp is per success, a failure gives a quarter, and unfocused work without the implant gives 80 %", () => {
	const [, time, exp] = crime("Mug");
	assert.deepEqual(exp, { strength: 3, defense: 3, dexterity: 3, agility: 3 }, "Crimes.ts: Mug gives 3 exp to each combat stat");
	assert.equal(time, 4000);
	const sure = crimeRates(exp, time, 1, mults(1));
	assert.equal(sure.strength, 3 / 4);
	const half = crimeRates(exp, time, 0.5, mults(1));
	assert.equal(half.strength, (3 / 4) * (0.5 + 0.5 * CRIME_FAIL_SHARE));
	assert.equal(crimeRates(exp, time, 1, mults(1), 1, UNFOCUSED).strength, (3 / 4) * 0.8);
	assert.equal(crimeRates(exp, time, 1, mults(2), 0.5).strength, (3 / 4) * 2 * 0.5, "times the exp multiplier and the BitNode's CrimeExpGain");
	assert.equal(crimeRates(crime("Shoplift")[2], 2000, 1, mults(1)).strength, undefined, "Shoplift gives no strength");
});

test("game: Bladeburner's Training applies the exp multiplier twice (completeAction, then gainStats), so it gives mult^2 a second", () => {
	assert.deepEqual(bladeburnerTrainingRates(mults(1)), { strength: 1, defense: 1, dexterity: 1, agility: 1 });
	assert.equal(bladeburnerTrainingRates(mults(3)).agility, 9);
	assert.equal(bladeburnerTrainingRates(mults(1), 5).strength, 5, "bonus time runs it faster");
});

test("game: bonus time speeds Bladeburner up to 5x, spending 4 extra seconds a second", () => {
	assert.equal(bonusSpeed(0, 120_000), 1);
	assert.equal(bonusSpeed(120_000, 120_000), 2, "a horizon's worth of bonus adds one x over that horizon");
	assert.equal(bonusSpeed(1e9, 120_000), BB_BONUS_SPEED);
	assert.equal(bonusSpeed(1e9, 0), 1, "no horizon: no speed-up claimed");
});

// --- The choice ---

test("the gym scores 1, and exp to a stat already at the floor counts nothing", () => {
	const gym = gymRates(mults(1), 10);
	assert.equal(trainingScore({ strength: 10 }, gym, ["strength"]), 1);
	assert.equal(trainingScore({ strength: 10, defense: 10 }, gym, ["strength"]), 1, "defense isn't short");
	assert.equal(pickTraining({ need: ["strength"], gym }).method, "gym");
});

test("three stats short at Powerhouse: the gym beats every crime even at 100 % chance (one stat at 10/s vs about 1/s each)", () => {
	const need = ["strength", "dexterity", "agility"];
	const gym = gymRates(mults(1), POWERHOUSE[2]);
	const crimes = COMBAT_CRIMES.map(([name, time, exp]) => ({ name, rates: crimeRates(exp, time, 1, mults(1)) }));
	const pick = pickTraining({ need, gym, crimes });
	assert.equal(pick.method, "gym");
	const best = Math.max(...crimes.map((entry) => trainingScore(entry.rates, gym, need)));
	assert.ok(best < 1, `best crime ${best.toFixed(2)}x the gym`);
});

test("only Iron Gym affordable: a crime that trains the short stats together is faster", () => {
	const need = ["strength", "dexterity", "agility"];
	const gym = gymRates(mults(1), IRON[2]);
	const crimes = COMBAT_CRIMES.map(([name, time, exp]) => ({ name, rates: crimeRates(exp, time, 0.9, mults(1)) }));
	const pick = pickTraining({ need, gym, crimes });
	assert.equal(pick.method, "crime");
	assert.ok(pick.score > 1);
});

test("Bladeburner's Training wins once the exp multiplier beats the gym's expMult / the number of short stats", () => {
	const need = ["strength", "dexterity", "agility"];
	const cut = POWERHOUSE[2] / need.length; // Training gives mult^2 to each, the gym mult x 10 to one: 3 mult^2 > 10 mult
	const at = (mult) => pickTraining({ need, gym: gymRates(mults(mult), POWERHOUSE[2]), bladeburner: bladeburnerTrainingRates(mults(mult)) }).method;
	assert.equal(at(cut * 0.95), "gym");
	assert.equal(at(cut * 1.05), "bladeburner");
	assert.equal(pickTraining({ need: ["strength"], gym: gymRates(mults(cut * 1.05), 10), bladeburner: bladeburnerTrainingRates(mults(cut * 1.05)) }).method, "gym",
		"with one stat short, Training needs the multiplier above the gym's whole expMult");
});

test("no gym in reach: anything that trains wins", () => {
	const pick = pickTraining({ need: ["strength"], gym: gymRates(mults(1), 10), gymReachable: false, crimes: [{ name: "Mug", rates: { strength: 0.1 } }] });
	assert.equal(pick.method, "crime");
	assert.equal(pick.gymScore, 0);
});

// --- player-work ---

const player = (changes = {}) => ({
	city: "Sector-12", money: POWERHOUSE[1] * GYM_CASH_SECONDS, factions: [], jobs: {}, mults: mults(1),
	skills: { hacking: 500, strength: 3, defense: 419, dexterity: 3, agility: 3 }, ...changes,
});
const passState = (changes = {}) => ({ config: JSON.parse(JSON.stringify(DEFAULTS)), focus: true, holdCity: false, ...changes });
const sureChances = () => ({ time: Date.now(), gymMult: 1, chances: Object.fromEntries(COMBAT_CRIMES.map(([name]) => [name, 1])) });
function world({ ports = {}, simulacrum = false, started = [] } = {}) {
	return fakeNs({
		ports,
		overrides: {
			getResetInfo: () => ({ currentNode: 10, ownedSF: new Map(), ownedAugs: new Map(simulacrum ? [["The Blade's Simulacrum", 1]] : []), lastAugReset: 0 }),
			getScriptRam: () => 1, getHostname: () => "home", scan: () => [], hasRootAccess: () => true,
			getServerMaxRam: () => 128, getServerUsedRam: () => 0, scp: () => true, fileExists: () => false,
			exec: (script, host, threads, ...args) => { started.push([script, ...args]); return 7; },
			singularity: { gymWorkout: () => true, travelToCity: () => true, commitCrime: () => 4000 },
		},
	});
}
const member = (state = "train", extra = {}) => ({ [BB_PORT]: { member: true, state, stateTime: Date.now(), bonusMs: 0, ...extra } });

test("the case that prompted this: defense done, the other three at 3, Powerhouse affordable: the gym, lowest stat", () => {
	const ns = world();
	const line = trainStep(ns, passState({ trainInfo: sureChances() }), player(), null, 850, "[covenant]");
	assert.match(line, /training strength at Powerhouse Gym/);
	assert.equal(ns.called("singularity.commitCrime").length, 0);
});

test("waiting in a city with no gym for an invite: a crime trains meanwhile instead of nothing", () => {
	const ns = world();
	const line = trainStep(ns, passState({ holdCity: true, trainInfo: sureChances() }), player({ city: "Chongqing" }), null, 850, "[covenant]");
	assert.match(line, /no gym in reach/);
	assert.equal(ns.called("singularity.commitCrime").length, 1);
	assert.equal(ns.called("singularity.gymWorkout").length, 0);
});

test("a member with high exp multipliers trains in Bladeburner (via its worker); combatTraining off keeps the gym", () => {
	const started = [];
	const ns = world({ ports: member(), started });
	const line = trainStep(ns, passState(), player({ mults: mults(4) }), null, 850, "[covenant]");
	assert.match(line, /Bladeburner Training/);
	assert.deepEqual(started.map(([script]) => script), ["bladeburner/workers/train.js"]);
	assert.equal(ns.called("singularity.gymWorkout").length, 0);

	const off = passState();
	off.config.combatTraining.enabled = false;
	const gymOnly = world({ ports: member() });
	assert.match(trainStep(gymOnly, off, player({ mults: mults(4) }), null, 850, "[covenant]"), /Powerhouse Gym/, "kill switch");
});

test("Training is not offered while bb-pass.js plays, nor from a stale or non-member post", () => {
	const need = ["strength", "dexterity", "agility"];
	for (const ports of [member("run"), member("train", { stateTime: Date.now() - 60 * 60_000 }), { [BB_PORT]: { member: false, state: "train", stateTime: Date.now() } }]) {
		assert.equal(trainingChoice(world({ ports }), passState(), player({ mults: mults(4) }), need).method, "gym");
	}
});

test("with The Blade's Simulacrum, Training runs beside the gym instead of replacing it", () => {
	const started = [];
	const ns = world({ ports: member(), simulacrum: true, started });
	const line = trainStep(ns, passState(), player({ mults: mults(4) }), null, 850, "[covenant]");
	assert.match(line, /Powerhouse Gym.*Bladeburner Training/);
	assert.equal(ns.called("singularity.gymWorkout").length, 1);
	assert.deepEqual(started.map(([script]) => script), ["bladeburner/workers/train.js"]);
});

// --- bb-manage ---

test("bb-manage leaves the Training player-work chose, and clears it once the choice is stale or for any other action", () => {
	const now = Date.now();
	const training = { type: "General", name: "Training" };
	assert.equal(trainingChosen(training, { time: now - 60_000 }, now), true);
	assert.equal(trainingChosen(training, { time: now - 60 * 60_000 }, now), false, "player-work moved on");
	assert.equal(trainingChosen(training, undefined, now), false, "a leftover from before a reset");
	assert.equal(trainingChosen({ type: "Contracts", name: "Tracking" }, { time: now }, now), false);
});

test("a crime already running for the training is kept, not restarted", () => {
	const state = passState({ holdCity: true, trainInfo: sureChances() });
	const chongqing = player({ city: "Chongqing" });
	const pick = trainingChoice(world(), state, chongqing, ["strength", "dexterity", "agility"]);
	assert.equal(pick.method, "crime");
	const ns = world();
	trainStep(ns, state, chongqing, { type: "CRIME", crimeType: pick.name }, 850, "[covenant]");
	assert.equal(ns.called("singularity.commitCrime").length, 0);
});

test("no gym in this city: the flight counts as reach only with the cash for it; without, a crime trains (and earns) meanwhile", () => {
	const need = ["strength", "dexterity", "agility"];
	const away = (money) => trainingChoice(world(), passState({ trainInfo: sureChances() }), player({ city: "Chongqing", money }), need);
	assert.equal(away(1e9).method, "gym", "flies to the gym");
	assert.equal(away(1000).method, "crime");
	assert.equal(away(1000).gymScore, 0);
});

test("game: crimes lose a fifth unfocused until the implant is installed; the gym doesn't", () => {
	const need = ["strength", "dexterity", "agility"];
	const score = (changes) => trainingChoice(world(), passState({ holdCity: true, trainInfo: sureChances(), ...changes }), player({ city: "Chongqing" }), need).score;
	const focused = score({ focus: true });
	assert.ok(Math.abs(score({ focus: false, focusAuto: true }) - focused * UNFOCUSED) < 1e-9);
	assert.equal(score({ focus: false, focusAuto: false }), focused, "with the implant (focusAuto false) unfocused is full speed");
});

test("Bladeburner bonus time can tip the choice to Training", () => {
	const need = ["strength", "dexterity", "agility"];
	const pick = (bonusMs) => trainingChoice(world({ ports: member("train", { bonusMs }) }), passState(), player({ mults: mults(2) }), need).method;
	assert.equal(pick(0), "gym", "3 x 2^2 = 12 exp/s of use against the gym's 10 x 2");
	assert.equal(pick(1e9), "bladeburner", "five times as fast with the bonus");
});

test("without the Simulacrum the gym line carries nothing extra", () => {
	assert.doesNotMatch(trainStep(world(), passState(), player(), null, 850, "[covenant]"), /;|null/);
});
