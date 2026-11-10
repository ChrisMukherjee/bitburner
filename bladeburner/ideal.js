// Design: docs/bladeburner.md
// @ts-check
// What the best possible play is worth, from the game's own formulas (bitburner-src v3.0.0: Bladeburner Constants, Action,
// LevelableAction and Contract/Operation data). Pure functions, no ns calls, 0GB. bb-pass.js compares the rank per hour it
// measures with this ceiling, so a low figure points at a cause (idle time, unspent counts) instead of just "slow".
//
// Three resources limit the rank per hour:
//   time      one action at a time (the action's seconds)
//   stamina   every Contract/Operation costs 0.285 x (difficulty ^ 0.28 + difficulty / 650); it regenerates by itself, and
//             Hyperbolic Regeneration Chamber (60 s) adds 1 % of the maximum on top, at the price of that minute
//   counts    each Contract/Operation has a count that goes down by one per attempt (win or lose) and grows by a random
//             amount per 480 s (the table's average): in the late game this, not the clock, is what caps the rank rate
// The ceiling is the linear program "maximise sum(chance x gain x rate) subject to those three", solved through its dual.
import { ACTIONS } from "/bladeburner/route-model.js";

const BASE_STAMINA_LOSS = 0.285;     // BladeburnerConstants.BaseStaminaLoss
const DIFF_EXPONENT = 0.28;          // DiffMultExponentialFactor
const DIFF_LINEAR = 650;             // DiffMultLinearFactor
const STAMINA_GAIN = 0.0085;         // StaminaGainPerSecond
const MAX_STAMINA_TO_GAIN = 70000;   // MaxStaminaToGainFactor
const REST_SECONDS = 60;             // Hyperbolic Regeneration Chamber
const REST_SHARE = 0.01;             // ... gives 1 % of the maximum stamina
const COUNT_PERIOD = 480;            // ActionCountGrowthPeriod, seconds
const SEARCH_STEPS = 50;             // each nested search narrows its range by (2/3)^50

/** Stamina one attempt of an action with this difficulty costs. */
export function staminaLoss(difficulty) {
	return BASE_STAMINA_LOSS * (Math.pow(difficulty, DIFF_EXPONENT) + difficulty / DIFF_LINEAR);
}

/**
 * Stamina regenerated per second without resting.
 * @param {number} maxStamina
 * @param {number} effectiveAgility  agility with the Reaper and Evasive System multipliers
 * @param {number} [multiplier]  Cyber's Edge (1 + 0.02 per level) times the player's bladeburner_stamina_gain
 */
export function staminaRegen(maxStamina, effectiveAgility, multiplier = 1) {
	const gain = (STAMINA_GAIN + maxStamina / MAX_STAMINA_TO_GAIN) * Math.pow(Math.max(0, effectiveAgility), 0.17);
	return Math.max(0, gain * multiplier);
}

/** The route model's table row for a Contract or Operation (typed loosely: the table is a mixed array). */
function tableAction(name) {
	return /** @type {{ base: number, dfac: number, growth: number } | undefined} */ (/** @type {any} */ (ACTIONS.find((candidate) => candidate.name === name)));
}

/** Difficulty of a Contract or Operation at a level (base x factor ^ (level - 1)), or NaN for an action the table doesn't know. */
export function difficultyAt(name, level = 1) {
	const action = tableAction(name);
	return action ? action.base * Math.pow(action.dfac, Math.max(1, level) - 1) : NaN;
}

/** Counts a Contract or Operation gains per second on average (its growth per 480 s), or NaN for an unknown action. */
export function countRate(name) {
	const action = tableAction(name);
	return action ? action.growth / COUNT_PERIOD : NaN;
}

/**
 * One item of the program: `value` = expected rank per attempt, `seconds` = its action time, `loss` = stamina per attempt
 * (negative for resting), `rate` = most attempts per second the supply of counts allows.
 * @typedef {{ name: string, value: number, seconds: number, loss: number, rate: number }} Item
 */

/**
 * Optimum of max sum(value x rate) s.t. sum(seconds x rate) <= 1, sum(loss x rate) <= regen, 0 <= rate <= item.rate.
 * Weak duality gives the dual L(lambda, mu) = lambda + mu x regen + sum(max_rate x max(0, value - lambda x seconds - mu x loss));
 * it is convex and piecewise linear, so a nested ternary search finds its minimum, which equals the optimum.
 * @param {Item[]} items
 * @param {number} regen  stamina regenerated per second
 * @returns {number} rank per second (0 for nothing usable)
 */
function optimum(items, regen) {
	const live = items.filter((item) => [item.value, item.seconds, item.loss, item.rate].every(Number.isFinite) && item.seconds > 0 && item.rate > 0);
	if (live.length === 0 || !(regen >= 0)) return 0;
	const dual = (lambda, mu) => lambda + mu * regen + live.reduce((sum, item) => sum + item.rate * Math.max(0, item.value - lambda * item.seconds - mu * item.loss), 0);
	const lambdaMax = Math.max(0, ...live.map((item) => item.value / item.seconds));
	const muMax = Math.max(0, ...live.filter((item) => item.loss > 0).map((item) => item.value / item.loss));
	return minimise((lambda) => minimise((mu) => dual(lambda, mu), 0, muMax).value, 0, lambdaMax).value;
}

const RELAXED = 1e6;  // "no limit"
const WORTH_NAMING = 0.01;  // a resource is the limiter when relaxing it alone lifts the optimum by at least this share

/**
 * The best rank per second and what limits it: the resource whose removal would lift the optimum most (time: every action
 * instant; stamina: unlimited regeneration; count: unlimited supply). "count" also when nothing lifts it noticeably.
 * @param {Item[]} items
 * @param {number} regen  stamina regenerated per second
 * @returns {{ perSecond: number, limiter: "time" | "stamina" | "count" | null }}
 */
export function solve(items, regen) {
	const perSecond = optimum(items, regen);
	if (!(perSecond > 0)) return { perSecond: 0, limiter: null };
	const gains = {
		time: optimum(items.map((item) => ({ ...item, seconds: item.seconds / RELAXED })), regen),
		stamina: optimum(items, regen * RELAXED + RELAXED),
		count: optimum(items.map((item) => ({ ...item, rate: item.rate * RELAXED })), regen),
	};
	/** @type {"time" | "stamina" | "count"} */
	let limiter = "count";
	let most = perSecond * (1 + WORTH_NAMING);
	for (const name of /** @type {const} */ (["count", "stamina", "time"])) {
		if (gains[name] > most) { limiter = name; most = gains[name]; }
	}
	return { perSecond, limiter };
}

/** Minimum of a convex function on [low, high] by ternary search. */
function minimise(fn, low, high) {
	for (let step = 0; step < SEARCH_STEPS && high > low; step++) {
		const left = low + (high - low) / 3;
		const right = high - (high - low) / 3;
		if (fn(left) <= fn(right)) high = right;
		else low = left;
	}
	const x = (low + high) / 2;
	return { x, value: fn(x) };
}

/**
 * The most rank per hour any play can earn from these live readings (the Contracts and Operations bb-pass.js posts), with the
 * stamina the player regenerates and rests for. Failures are not subtracted, so it is a ceiling, not a forecast. Black Ops and
 * the 0.1 rank of a Field Analysis are not included.
 * @param {{ name: string, chance: number, gain: number, secs: number, level?: number }[]} rows
 * @param {number} maxStamina
 * @param {number} regen  from staminaRegen
 * @returns {{ perHour: number, limiter: "time" | "stamina" | "count" | null, byAction: { name: string, perHour: number }[] }}
 */
export function idealRankRate(rows, maxStamina, regen) {
	/** @type {Item[]} */
	const items = [];
	/** @type {{ name: string, perHour: number }[]} */
	const byAction = [];
	for (const row of rows) {
		const difficulty = difficultyAt(row.name, row.level);
		const rate = countRate(row.name);
		if (!(difficulty > 0) || !(rate > 0) || !(row.chance >= 0) || !(row.gain > 0) || !(row.secs > 0)) continue;
		const value = row.chance * row.gain;
		items.push({ name: row.name, value, seconds: row.secs, loss: staminaLoss(difficulty), rate });
		byAction.push({ name: row.name, perHour: value * rate * 3600 });
	}
	if (items.length === 0 || !(maxStamina > 0)) return { perHour: 0, limiter: null, byAction };
	items.push({ name: "rest", value: 0, seconds: REST_SECONDS, loss: -REST_SHARE * maxStamina, rate: 1 / REST_SECONDS });
	const best = solve(items, regen);
	byAction.sort((first, second) => second.perHour - first.perHour);
	return { perHour: best.perSecond * 3600, limiter: best.limiter, byAction };
}

/** Rank per hour measured over a window from rank samples [{ t, rank }] (NaN under two minutes of data). */
export function measuredRate(samples) {
	if (!Array.isArray(samples) || samples.length < 2) return NaN;
	const first = samples[0];
	const last = samples[samples.length - 1];
	const span = last.t - first.t;
	return span > 120_000 ? (last.rank - first.rank) / (span / 3600_000) : NaN;
}

/**
 * The rank samples to keep for this pass: the last `windowMs`, none from a higher rank (a new BitNode), and none from before a
 * gap of more than `gapMs` (Bladeburner was held, training or stopped), so the measured rate is the rate while playing. Without
 * the gap rule a hold in the window made the play look several times slower than it is, and the route estimate held it longer.
 */
export function keepRankSamples(samples, rank, now, windowMs = 3600_000, gapMs = 10 * 60_000) {
	const kept = (Array.isArray(samples) ? samples : []).filter((sample) => now - sample.t < windowMs && sample.rank <= rank);
	let start = 0;
	for (let i = 1; i < kept.length; i++) if (kept[i].t - kept[i - 1].t > gapMs) start = i;
	const recent = kept.slice(start);
	return recent.length && now - recent[recent.length - 1].t > gapMs ? [] : recent;
}

/** Hours to go from `rank` to `goal` at `perHour`, or NaN when the rate is not positive. */
export function hoursToRank(rank, goal, perHour) {
	if (!(perHour > 0)) return NaN;
	return Math.max(0, goal - rank) / perHour;
}

/** Moving average of a yes/no signal: `previous` pulled 2 % toward this pass (0 when there is none yet). */
export function nextShare(previous, active) {
	const before = Number.isFinite(previous) ? previous : 0;
	return before + 0.02 * ((active ? 1 : 0) - before);
}
