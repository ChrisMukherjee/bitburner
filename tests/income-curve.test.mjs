// utils/income-curve.js: the income forecast the reset rule and the rep goals use.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordIncomeSample, buildIncomeModel, incomeMultAt, earnedOver, timeToEarn } from "/utils/income-curve.js";
import { DEFAULTS } from "/config.js";

const CURVE = DEFAULTS.augments.resetRule.incomeCurve;
const MINUTE = 60_000;

/** A history of this run: income doubling every hour, one sample every 10 minutes for `hours`. */
function doublingRun(hours, start = 1e6) {
	let history = null;
	for (let minutes = 0; minutes <= hours * 60; minutes += 10) {
		history = recordIncomeSample(history, 0, minutes * MINUTE, start * 2 ** (minutes / 60), CURVE);
	}
	return history;
}

test("flat income: earned is rate x time, and timeToEarn is its inverse", () => {
	const flat = buildIncomeModel(null, 0, CURVE);
	assert.equal(flat.growth, 0);
	assert.equal(earnedOver(100, flat, 3600), 360_000);
	assert.equal(timeToEarn(100, flat, 360_000), 3600);
	assert.equal(timeToEarn(0, flat, 1), Infinity);
	assert.equal(timeToEarn(100, flat, 0), 0);
});

test("growth is fitted from this run's samples (ln 2 per hour for doubling)", () => {
	const model = buildIncomeModel(doublingRun(2), 2 * 3600_000, CURVE);
	assert.equal(model.source, "this run");
	assert.ok(Math.abs(model.growth - Math.LN2) < 0.01, `growth ${model.growth}`);
});

test("too few samples: flat; falling income: flat, never negative", () => {
	assert.equal(buildIncomeModel(doublingRun(0.1), 6 * MINUTE, CURVE).growth, 0);
	let falling = null;
	for (let minutes = 0; minutes <= 120; minutes += 10) falling = recordIncomeSample(falling, 0, minutes * MINUTE, 1e9 / (1 + minutes), CURVE);
	assert.equal(buildIncomeModel(falling, 120 * MINUTE, CURVE).growth, 0);
});

test("the forecast levels off and never passes maxMult", () => {
	const model = { growth: CURVE.maxGrowthPerHour, dampHours: CURVE.dampHours, maxMult: CURVE.maxMult };
	assert.equal(incomeMultAt(model, 0), 1);
	assert.ok(incomeMultAt(model, 1) > 1);
	assert.ok(incomeMultAt(model, 1000) <= CURVE.maxMult);
});

test("earnedOver and timeToEarn agree on a growing curve", () => {
	const model = { growth: 0.5, dampHours: 1.5, maxMult: 4 };
	const earned = earnedOver(1e6, model, 2 * 3600);
	assert.ok(earned > 1e6 * 2 * 3600, "growing income earns more than flat");
	const seconds = timeToEarn(1e6, model, earned);
	assert.ok(Math.abs(seconds - 7200) < 60, `timeToEarn ${seconds}s, expected about 7200`);
});

test("a new run keeps the last run's samples as `previous`", () => {
	const old = doublingRun(1);
	const next = recordIncomeSample(old, 999 * MINUTE, 1000 * MINUTE, 5e6, CURVE);
	assert.equal(next.lastReset, 999 * MINUTE);
	assert.deepEqual(next.previous, old.samples);
	assert.equal(next.samples.length, 1);
});

test("samples closer than sampleMinutes and $0 samples are dropped", () => {
	let history = recordIncomeSample(null, 0, 10 * MINUTE, 100, CURVE);
	history = recordIncomeSample(history, 0, (10 + CURVE.sampleMinutes / 2) * MINUTE, 200, CURVE);
	history = recordIncomeSample(history, 0, 60 * MINUTE, 0, CURVE);
	assert.equal(history.samples.length, 1);
});
