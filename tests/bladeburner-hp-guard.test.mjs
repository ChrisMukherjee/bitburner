// bladeburner/hp-guard.js (the pure pricing of a failure's damage) and bb-pass.js's use of it on the simulated division
// (tests/support/fake-bladeburner.mjs models the game's damage on a failure, the hospital reset and the chamber's healing).
import { test } from "node:test";
import assert from "node:assert/strict";
import { actionDamage, blackOpDamage, blackOpHealth, guardRows, healSeconds, hospitalBill } from "/bladeburner/hp-guard.js";
import { blackOpStakes } from "/bladeburner/team.js";
import { blackOpDifficulty } from "/bladeburner/picks.js";
import { bladeburnerSim } from "./support/fake-bladeburner.mjs";
import { main as play } from "/bladeburner/bb-pass.js";

const CHAMBER = "Hyperbolic Regeneration Chamber";
const row = (name, extra = {}) => {
	const base = { name, type: "Operations", low: 0.9, high: 0.9, middle: 0.9, gain: 10, seconds: 10, level: 1, count: 100, ...extra };
	return { ...base, score: (base.middle * base.gain) / Math.max(1, base.seconds), ...extra };
};
const names = (sim) => sim.started.map((entry) => entry.name);

test("game: a failure's worst damage is hpLoss x (difficulty ^ 0.28 + difficulty / 650), 10 % high, rounded up, and grows with the level", () => {
	const factor = (difficulty) => Math.pow(difficulty, 0.28) + difficulty / 650;
	assert.equal(actionDamage("Raid"), Math.ceil(50 * factor(800) * 1.1), "Raid: hpLoss 50, difficulty 800");
	assert.equal(actionDamage("Tracking", 11), Math.ceil(0.5 * factor(125 * Math.pow(1.02, 10)) * 1.1), "difficulty is base x factor ^ (level - 1)");
	assert.equal(actionDamage("Investigation"), 0, "Investigation never hurts");
	assert.equal(actionDamage("no such action"), 0);
	const stakes = blackOpStakes("Operation Typhoon");
	assert.equal(blackOpDamage("Operation Typhoon"), Math.ceil(stakes.hpLoss * factor(blackOpDifficulty("Operation Typhoon")) * 1.1), "Black Ops use the base difficulty");
});

test("game: the hospital bill is (HP missing after the damage) x $100k, at most 10 % of the cash, and only when the damage reaches the HP", () => {
	assert.equal(hospitalBill(50, { current: 100, max: 100 }, 1e12), 0, "survives: nothing to pay");
	assert.equal(hospitalBill(100, { current: 100, max: 100 }, 1e12), 100 * 1e5, "damage equal to HP counts (HP 0 hospitalises); missing HP = max - (current - damage)");
	assert.equal(hospitalBill(500, { current: 100, max: 100 }, 1e12), 500 * 1e5, "missing HP after the damage");
	assert.equal(hospitalBill(500, { current: 100, max: 100 }, 1e6), 1e5, "capped at 10 % of the cash");
	assert.equal(hospitalBill(500, undefined, 1e9), 0, "unknown HP: no bill");
});

test("healSeconds: enough chamber completions (2 HP each, 60 s) to end with more HP than the damage", () => {
	assert.equal(healSeconds(10, { current: 20, max: 100 }), 0, "already safe");
	assert.equal(healSeconds(10, { current: 10, max: 100 }), 60, "needs 1 HP: one completion");
	assert.equal(healSeconds(30, { current: 10, max: 100 }, 30), Math.ceil(21 / 2) * 30, "the chamber's own action time is used");
});

test("guardRows: rows that can't reach the current HP are returned untouched", () => {
	const rows = [row("Tracking"), row("Raid", { gain: 55, seconds: 66 })];
	const safe = guardRows(rows, { hp: { current: 5000, max: 5000 }, money: 1e9, income: 100 });
	assert.equal(safe, rows, "no row is lethal: the same array, nothing re-sorted or repriced");
	assert.equal(guardRows(rows, { hp: undefined, money: 1e9, income: 100 }), rows, "unknown HP: nothing to guard");
});

test("guardRows: a row one failure can kill, that a full-HP player survives, heals first when the bill can't be priced", () => {
	const raid = actionDamage("Raid");
	const hp = { current: raid - 1, max: raid + 100 };
	const guarded = guardRows([row("Raid", { gain: 55, seconds: 66 })], { hp, money: 1e9, income: 0 });
	assert.equal(guarded[0].hp.mode, "rest", "no income reading: the hospital bill can't be priced, so heal");
	assert.equal(guarded[0].hp.damage, raid);
	assert.ok(guarded[0].score > 0 && guarded[0].score < 0.9 * 55 / 66, "the time spent healing lowers its rate");
});

test("guardRows: damage that exceeds even full HP and can't be priced (no income) takes the row out; a certain success is not guarded against", () => {
	const raid = actionDamage("Raid");
	const hp = { current: 100, max: Math.min(100, raid - 1) };
	const [sure] = guardRows([row("Raid", { gain: 55, seconds: 66, middle: 1, low: 1, high: 1 })], { hp: { current: 100, max: 100 }, money: 1e9, income: 0 });
	assert.ok(sure.score > 0, "it can't fail, so no failure's damage matters");
	const [out] = guardRows([row("Raid", { gain: 55, seconds: 66 })], { hp, money: 1e9, income: 0 });
	assert.equal(out.score, -Infinity, "resting can't protect against it and the bill is unknown: not played");
});

test("guardRows: with an income reading a cheap bill beats healing, an expensive one doesn't", () => {
	const raid = actionDamage("Raid");
	const hp = { current: 100, max: Math.min(100, raid - 1) }; // never coverable: only the risk option exists
	const rich = guardRows([row("Raid", { gain: 55, seconds: 66 })], { hp, money: 1e7, income: 1e6 })[0];
	assert.equal(rich.hp.mode, "risk");
	assert.ok(rich.score > 0, "a bill worth a few seconds of income is worth paying for 55 rank");
	const poor = guardRows([row("Raid", { gain: 55, seconds: 66 })], { hp, money: 1e12, income: 1 })[0];
	assert.ok(!(poor.score > 0), "a bill of 10 % of the cash against 1 $/s costs more rank than the action earns");
});

test("guardRows: a lethal row is demoted below a safe one that earns a little less, so the safer action plays", () => {
	const raid = actionDamage("Raid");
	const hp = { current: raid - 1, max: raid + 100 };
	const [first] = guardRows([row("Raid", { gain: 55, seconds: 66, count: 100 }), row("Tracking", { gain: 0.6, seconds: 5 })], { hp, money: 1e9, income: 0 });
	assert.equal(first.name, "Tracking", "healing for the Raid first makes it slower than the Contract");
});

test("blackOpHealth: heals first when one failure would hospitalise now, a full-HP player survives it, and the bill can't be priced or costs more", () => {
	const damage = blackOpDamage("Operation Typhoon");
	const hp = { current: damage - 1, max: damage + 200 };
	assert.equal(blackOpHealth("Operation Typhoon", 0.9, { current: damage + 1, max: damage + 200 }, 1e9, 0).lethal, false, "enough HP now");
	assert.equal(blackOpHealth("Operation Typhoon", 0.9, hp, 1e9, 0).rest, true, "no income reading: heal");
	assert.equal(blackOpHealth("Operation Typhoon", 0.9, hp, 1e9, 1e9).rest, false, "a bill worth less than the healing time: pay it");
	assert.equal(blackOpHealth("Operation Typhoon", 0.9, { current: 50, max: damage - 1 }, 1e9, 0).rest, false, "resting can't protect a player whose full HP the damage still reaches");
	assert.equal(blackOpHealth("Operation Typhoon", 1, hp, 1e9, 1).rest, false, "a sure success has no failure to heal for");
});

// ---- bb-pass.js on the simulated division

/** A division where Undercover Operation is by far the best rank per second but can do 15 damage on a failure to a player with 60 HP. */
const risky = (extra = {}) => bladeburnerSim({
	rank: 10, hp: { current: 60, max: 60 }, regen: 1,
	actions: { "Undercover Operation": { chance: 0.7, gain: 20, secs: 10, count: 100000 }, "Tracking": { count: 100000 } }, ...extra,
});

test("regression: a division whose best action can kill the player no longer sends them to the hospital over and over", async () => {
	const unguarded = risky({ config: { bladeburner: { hpGuard: false } } });
	await unguarded.passes(play, 120);
	assert.ok(unguarded.hospital >= 3, `premise: without the guard the repeating action hospitalises the player (${unguarded.hospital} visits)`);
	const guarded = risky();
	await guarded.passes(play, 120);
	assert.equal(guarded.hospital, 0, "the guard heals before the damage can reach the HP, so the hospital is never needed");
	assert.ok(names(guarded).includes(CHAMBER), "the player healed in the chamber");
	assert.ok(names(guarded).includes("Undercover Operation"), "and still played the action once healed");
});

test("the guard rests only when the action's worst damage reaches the HP, and goes back to it once HP is above it", async () => {
	const sim = risky({ hp: { current: 14, max: 60 } });
	await sim.passes(play, 1);
	assert.equal(sim.current?.name, CHAMBER, "HP 14 against a worst case of 15");
	const damage = actionDamage("Undercover Operation");
	await sim.passes(play, 60);
	const back = sim.started.find((entry, index) => index > 0 && entry.name === "Undercover Operation");
	assert.ok(back, "the action starts again");
	assert.ok(sim.started[0].name === CHAMBER && damage === 15, "premise: the rest was for a 15-damage worst case");
	assert.equal(sim.hospital, 0);
});

test("a full-HP player on the same division is not slowed down: no rest while the damage stays below the HP", async () => {
	const sim = risky({ hp: { current: 60, max: 60 } });
	await sim.passes(play, 2);
	assert.equal(sim.started[0].name, "Undercover Operation", "the best action starts at once");
	assert.ok(!names(sim).slice(0, 1).includes(CHAMBER));
});

test("hpGuard false keeps the old behaviour: the best action plays whatever the HP", async () => {
	const sim = risky({ hp: { current: 14, max: 60 }, config: { bladeburner: { hpGuard: false } } });
	await sim.passes(play, 1);
	assert.equal(sim.current?.name, "Undercover Operation");
});

test("an action that can't be survived at full HP and has no priced bill is not played; the safe Contract is", async () => {
	// Raid does 426 damage at worst: more than a 100-HP player has. At 90 % it is the best rank per second, and with no income reading
	// the hospital bill can't be priced.
	const sim = bladeburnerSim({ rank: 10, actions: { "Raid": { chance: 0.9, gain: 55, secs: 66, count: 100000 }, "Tracking": { count: 100000 } } });
	await sim.passes(play, 10);
	assert.ok(!names(sim).includes("Raid"));
	assert.equal(names(sim)[0], "Tracking");
});

test("the Black Op heals first when its failure would hospitalise the player and the bill can't be priced", async () => {
	const damage = blackOpDamage("Operation Typhoon");
	const sim = bladeburnerSim({ rank: 2500, blackOpChance: 0.9, hp: { current: damage - 5, max: damage + 200 }, regen: 1 });
	await sim.passes(play, 1);
	assert.equal(sim.current?.name, CHAMBER, "healing first, not the attempt");
	assert.ok(!names(sim).includes("Operation Typhoon"));
});
