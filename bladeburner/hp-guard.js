// Design: docs/bladeburner.md
// @ts-check
// The HP guard for bb-pass.js: a failed Contract, Operation or Black Op does damage, and damage that reaches the current HP
// hospitalises the player (HP back to full, for (HP missing) x $100k, at most 10 % of the cash). The game repeats the running action
// without looking at HP, so a pass that picks an action which can kill the player by one failure makes the same trip to the
// hospital again and again. Pure functions, no ns calls, 0GB. The numbers are the game's own (bitburner-src v3.0.0:
// Bladeburner.ts completeAction, data/Contracts.ts, data/Operations.ts, data/Constants.ts HrcHpGain, Hospital/Hospital.ts):
//   damage        hpLoss x (difficulty ^ 0.28 + difficulty / 650), at most 10 % more, rounded up, taken on a FAILURE only
//                 (difficulty = base x factor ^ (level - 1) for Contracts and Operations, the base for Black Ops)
//   hospital      when HP - damage <= 0: HP is restored in full and the bill is min(10 % of cash, (max - (HP - damage)) x $100k)
//   chamber       Hyperbolic Regeneration Chamber heals 2 HP per completion (60 s), and no other action heals
// A row is "lethal" when its worst-case damage reaches the current HP. A lethal row is priced instead of ignored, two ways, and
// the better one wins (both in the units of rank per second the rest of bb-pass.js uses, the hospital bill in seconds of income):
//   risk   play it anyway: the failure chance times the bill (in seconds of income) times what a second of play earns in rank
//   rest   heal first in the chamber: possible only when one failure can't kill a full-HP player (damage < max HP); the time to
//          heal what a failure takes, times the failure chance, is added to the action's seconds
// With no income reading the bill can't be priced, so only resting (or an action that can't fail) is left.
import { blackOpStakes } from "/bladeburner/team.js";
import { blackOpDifficulty } from "/bladeburner/picks.js";

const DAMAGE_EXPONENT = 0.28;
const DAMAGE_LINEAR = 650;
const DAMAGE_OFFSET = 0.1;              // the game varies the damage by up to 10 %: plan for the high end
const HOSPITAL_COST_PER_HP = 100e3;     // CONSTANTS.HospitalCostPerHp
const HOSPITAL_CASH_SHARE = 0.1;        // the bill is never more than 10 % of the cash
const CHAMBER_HP = 2;                   // BladeburnerConstants.HrcHpGain, per completion
const CHAMBER_SECS = 60;                // Hyperbolic Regeneration Chamber's action time

// [base difficulty, difficulty factor per level, hpLoss] (data/Contracts.ts, data/Operations.ts). Investigation never hurts.
/** @type {Record<string, { base: number, fac: number, hpLoss: number }>} */
const ACTIONS = {
	"Tracking": { base: 125, fac: 1.02, hpLoss: 0.5 },
	"Bounty Hunter": { base: 250, fac: 1.04, hpLoss: 1 },
	"Retirement": { base: 200, fac: 1.03, hpLoss: 1 },
	"Investigation": { base: 400, fac: 1.03, hpLoss: 0 },
	"Undercover Operation": { base: 500, fac: 1.04, hpLoss: 2 },
	"Sting Operation": { base: 650, fac: 1.04, hpLoss: 2.5 },
	"Raid": { base: 800, fac: 1.045, hpLoss: 50 },
	"Stealth Retirement Operation": { base: 1000, fac: 1.05, hpLoss: 10 },
	"Assassination": { base: 1500, fac: 1.06, hpLoss: 5 },
};

/**
 * The damage multiplier of a difficulty: difficulty ^ 0.28 + difficulty / 650.
 * @param {number} difficulty
 */
function damageFactor(difficulty) {
	return Math.pow(difficulty, DAMAGE_EXPONENT) + difficulty / DAMAGE_LINEAR;
}

/**
 * The most damage one failure of a Contract or Operation at this level does (10 % above the average, rounded up, as the game's
 * variation allows). 0 for an action that never hurts or an unknown name.
 * @param {string} name
 * @param {number} [level]
 */
export function actionDamage(name, level = 1) {
	const entry = ACTIONS[name];
	if (!entry || !(entry.hpLoss > 0)) return 0;
	const difficulty = entry.base * Math.pow(entry.fac, Math.max(1, Number(level) || 1) - 1);
	return Math.ceil(entry.hpLoss * damageFactor(difficulty) * (1 + DAMAGE_OFFSET));
}

/** The most damage one failure of a Black Op does (the same rule, difficulty without levels). 0 for an unknown name. */
export function blackOpDamage(name) {
	const stakes = blackOpStakes(name);
	const difficulty = blackOpDifficulty(name);
	if (!stakes || !Number.isFinite(difficulty)) return 0;
	return Math.ceil(stakes.hpLoss * damageFactor(difficulty) * (1 + DAMAGE_OFFSET));
}

/**
 * What the hospital charges when this damage takes the player to 0 HP or below: (HP missing afterwards) x $100k, at most 10 % of
 * the cash. 0 when the player survives, or when HP or cash are unknown.
 * @param {number} damage
 * @param {{ current: number, max: number } | undefined} hp
 * @param {number | undefined} money
 */
export function hospitalBill(damage, hp, money) {
	if (!hp || !Number.isFinite(hp.current) || !Number.isFinite(hp.max) || !(money && money > 0)) return 0;
	if (!(damage >= hp.current)) return 0;
	return Math.max(0, Math.min(money * HOSPITAL_CASH_SHARE, (hp.max - (hp.current - damage)) * HOSPITAL_COST_PER_HP));
}

/**
 * Seconds in the chamber to end with more HP than `damage` (so a worst-case failure leaves the player alive).
 * @param {number} damage
 * @param {{ current: number, max: number }} hp
 * @param {number} [chamberSecs]
 */
export function healSeconds(damage, hp, chamberSecs = CHAMBER_SECS) {
	const need = damage - hp.current + 1;
	return need > 0 ? Math.ceil(need / CHAMBER_HP) * chamberSecs : 0;
}

/**
 * @typedef {object} HpReading  what the guard says about one action
 * @property {number} damage      the most one failure does
 * @property {number} bill        the hospital bill if it hospitalises ($)
 * @property {boolean} coverable  a full-HP player survives it (resting can protect against it)
 * @property {"rest"|"risk"} mode rest in the chamber first, or play it and accept the chance of a hospital visit
 */

/**
 * Prices the failure damage of every Contract and Operation row and re-sorts them by the adjusted rank per second. A row whose
 * worst-case damage stays below the current HP is untouched. A lethal row gets the better of "risk" and "rest" (see the top of the
 * file); `row.hp` says which and `row.score` is the adjusted rate (-Infinity when neither is possible: the caller drops it).
 * @template {{ name: string, level?: number, middle: number, gain: number, seconds: number, score: number, count?: number }} Row
 * @param {Row[]} rows
 * @param {{ hp?: { current: number, max: number }, money?: number, income?: number, rankRate?: number, chamberSecs?: number }} context
 * @returns {Array<Row & { hp?: HpReading }>}
 */
export function guardRows(rows, context) {
	const { hp, money, income = 0, chamberSecs = CHAMBER_SECS } = context;
	if (!hp || !Number.isFinite(hp.current) || !Number.isFinite(hp.max)) return rows;
	const damages = rows.map((row) => actionDamage(row.name, row.level));
	const lethal = damages.map((damage) => damage > 0 && damage >= hp.current);
	if (!lethal.some(Boolean)) return rows;
	// What a second of play earns: the best row that can't kill the player (rows with no count left don't count), else the given
	// measured rate, else the best row there is
	const playable = rows.filter((row, index) => !lethal[index] && (row.count ?? 1) >= 1).map((row) => row.score);
	const rankRate = Math.max(0, ...playable) || Number(context.rankRate) || Math.max(0, ...rows.map((row) => row.score));
	const guarded = rows.map((row, index) => {
		if (!lethal[index]) return row;
		const damage = damages[index];
		const fail = Math.min(1, Math.max(0, 1 - row.middle));
		const bill = hospitalBill(damage, hp, money);
		const billSecs = fail <= 0 ? 0 : income > 0 ? bill / income : Infinity;
		const seconds = Math.max(1, row.seconds);
		const risk = billSecs === Infinity ? -Infinity : (row.middle * row.gain - fail * billSecs * rankRate) / seconds;
		const coverable = damage < hp.max;
		const rest = coverable ? (row.middle * row.gain) / (seconds + fail * Math.ceil(damage / CHAMBER_HP) * chamberSecs) : -Infinity;
		/** @type {HpReading} */
		const reading = { damage, bill, coverable, mode: rest >= risk ? "rest" : "risk" };
		return { ...row, score: Math.max(risk, rest), hp: reading };
	});
	return guarded.sort((first, second) => second.score - first.score);
}

/**
 * Whether the next Black Op should be preceded by healing: one failure would hospitalise the player now, a full-HP player would
 * survive it, and the time to heal costs less than the expected hospital bill (in seconds of income; with no income reading the
 * bill can't be priced and healing is the safe choice).
 * @param {string} name
 * @param {number} chance          the attempt's success chance (low estimate)
 * @param {{ current: number, max: number } | undefined} hp
 * @param {number | undefined} money
 * @param {number} income          $/s
 * @param {number} [chamberSecs]
 * @returns {{ damage: number, lethal: boolean, rest: boolean, healSecs: number }}
 */
export function blackOpHealth(name, chance, hp, money, income, chamberSecs = CHAMBER_SECS) {
	const damage = blackOpDamage(name);
	if (!hp || !Number.isFinite(hp.current) || !Number.isFinite(hp.max) || !(damage > 0) || damage < hp.current) return { damage, lethal: false, rest: false, healSecs: 0 };
	const fail = Math.min(1, Math.max(0, 1 - chance));
	const healSecs = healSeconds(damage, hp, chamberSecs);
	const billSecs = fail <= 0 ? 0 : income > 0 ? hospitalBill(damage, hp, money) / income : Infinity;
	return { damage, lethal: true, rest: damage < hp.max && healSecs < fail * billSecs, healSecs };
}
