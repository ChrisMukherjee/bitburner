// Design: docs/bladeburner.md
// @ts-check
// Pure choices for bb-manage.js (which skill to buy) and bb-pass.js (which city to play in). No ns calls, 0GB.
// Both work from the live readings bb-pass.js posts on port 36 (`actions`: per action the chance, rank gain and seconds,
// the player's skills `lv`, and every city's estimated population and chaos), so nothing here is a per-player table:
// the numbers are the game's own (bitburner-src v3.0.0, Bladeburner/Skill data and Action.getSuccessChance).
import { ACTIONS } from "/bladeburner/route-model.js";

// Success chance = min(1, competence / difficulty). Competence is multiplied by the skill multipliers, by the city's
// population factor (pop / 1e9) ^ 0.7, and the difficulty by a chaos factor sqrt(1 + chaos - 50) above chaos 50.
const POP_BASE = 1e9;
const POP_EXPONENT = 0.7;
const CHAOS_START = 50;
const TOP_ROWS = 3;              // the actions that are being played or will be next: the best few by rank per second
const EXP_TO_CHANCE = 0.25;      // rough: a share of the extra exp ends up as combat levels, and so as chance
const REST_DEFAULT = 0.5;        // share of passes spent resting, until bb-pass.js has measured it
const SWITCH_FLOOR = 0.05;       // on top of the estimate noise, the smallest gain that is worth switching city for

// [skill, % per level, which actions it applies to] (Skill data, game source)
const STEALTH = new Set(["Tracking", "Undercover Operation", "Investigation", "Sting Operation", "Stealth Retirement Operation", "Assassination"]);
const KILL = new Set(["Bounty Hunter", "Retirement", "Raid", "Stealth Retirement Operation", "Assassination"]);
const CHANCE_SKILLS = {
	"Blade's Intuition": { pct: 3, applies: () => true },
	"Digital Observer": { pct: 4, applies: (row) => row.type === "Operations" },
	"Tracer": { pct: 4, applies: (row) => row.type === "Contracts" },
	"Cloak": { pct: 5.5, applies: (row) => STEALTH.has(row.name) },
	"Short-Circuit": { pct: 5.5, applies: (row) => KILL.has(row.name) },
};
// Effective combat stats for Bladeburner actions (indexes in the model's STATS: strength 1, defense 2, dexterity 3, agility 4)
const STAT_SKILLS = { "Reaper": { pct: 2, stats: [1, 2, 3, 4] }, "Evasive System": { pct: 4, stats: [3, 4] } };
const STAT_KEYS = ["hacking", "strength", "defense", "dexterity", "agility", "charisma", "intelligence"];

/** A Black Op is attempted only when its low estimate reaches this (a failure costs rank, health and a long action). */
export const BLACKOP_CHANCE = 0.8;
// The Black Ops (game source, BlackOperations data): [name, base difficulty, stat weights in STAT_KEYS order, stealth, kill].
// Their stat decays are the same for all (hacking 0.6, combat 0.8, intelligence 0.75), they ignore the city's population and
// chaos, and the Operation skills (Digital Observer) and the team size apply to them like to Operations.
const BLACK_OP_DECAYS = [0.6, 0.8, 0.8, 0.8, 0.8, 0, 0.75];
const BLACK_OPS = [
	["Operation Typhoon", 2000, [0.1, 0.2, 0.2, 0.2, 0.2, 0, 0.1], 0, 1],
	["Operation Zero", 2500, [0.2, 0.15, 0.15, 0.2, 0.2, 0, 0.1], 1, 0],
	["Operation X", 3000, [0.1, 0.2, 0.2, 0.2, 0.2, 0, 0.1], 0, 1],
	["Operation Titan", 4000, [0.1, 0.2, 0.2, 0.2, 0.2, 0, 0.1], 0, 1],
	["Operation Ares", 5000, [0, 0.25, 0.25, 0.25, 0.25, 0, 0], 0, 1],
	["Operation Archangel", 7500, [0, 0.2, 0.2, 0.3, 0.3, 0, 0], 0, 1],
	["Operation Juggernaut", 10e3, [0, 0.25, 0.25, 0.25, 0.25, 0, 0], 0, 1],
	["Operation Red Dragon", 12.5e3, [0.05, 0.2, 0.2, 0.25, 0.25, 0, 0.05], 0, 1],
	["Operation K", 15e3, [0.05, 0.2, 0.2, 0.25, 0.25, 0, 0.05], 0, 1],
	["Operation Deckard", 20e3, [0, 0.24, 0.24, 0.24, 0.24, 0, 0.04], 0, 1],
	["Operation Tyrell", 25e3, [0.1, 0.2, 0.2, 0.2, 0.2, 0, 0.1], 0, 1],
	["Operation Wallace", 30e3, [0, 0.24, 0.24, 0.24, 0.24, 0, 0.04], 0, 1],
	["Operation Shoulder of Orion", 35e3, [0.1, 0.2, 0.2, 0.2, 0.2, 0, 0.1], 1, 0],
	["Operation Hyron", 40e3, [0.1, 0.2, 0.2, 0.2, 0.2, 0, 0.1], 0, 1],
	["Operation Morpheus", 45e3, [0.05, 0.15, 0.15, 0.3, 0.3, 0, 0.05], 1, 0],
	["Operation Ion Storm", 50e3, [0, 0.24, 0.24, 0.24, 0.24, 0, 0.04], 0, 1],
	["Operation Annihilus", 55e3, [0, 0.24, 0.24, 0.24, 0.24, 0, 0.04], 0, 1],
	["Operation Ultron", 60e3, [0.1, 0.2, 0.2, 0.2, 0.2, 0, 0.1], 0, 1],
	["Operation Centurion", 70e3, [0.1, 0.2, 0.2, 0.2, 0.2, 0, 0.1], 0, 0],
	["Operation Vindictus", 75e3, [0.1, 0.2, 0.2, 0.2, 0.2, 0, 0.1], 0, 0],
	["Operation Daedalus", 80e3, [0.1, 0.2, 0.2, 0.2, 0.2, 0, 0.1], 0, 0],
].map(([name, base, w, stealth, lethal]) => ({ name, base, w, dc: BLACK_OP_DECAYS, stealth: !!stealth, lethal: !!lethal }));

/** Every skill the adaptive order can buy. Hands of Midas (money) and Datamancer (estimate accuracy) never help rank. */
export const SKILL_NAMES = [...Object.keys(CHANCE_SKILLS), ...Object.keys(STAT_SKILLS), "Overclock", "Cyber's Edge", "Hyperdrive"];

/**
 * How much the rank rate grows when the chance is multiplied by (1 + boost): the chance is capped at 1, so a boost is
 * worth nothing to an action that already succeeds every time.
 */
export function chanceGain(chance, boost) {
	if (!(boost > 0)) return 0;
	if (!(chance > 0)) return boost;
	return Math.min(1, chance * (1 + boost)) / chance - 1;
}

/** The few actions that matter: the best by chance x rank gain / seconds. */
export function topRows(actions, count = TOP_ROWS) {
	const rows = Array.isArray(actions?.rows) ? actions.rows : [];
	return rows.filter((row) => row && Number.isFinite(row.chance) && Number.isFinite(row.gain) && Number.isFinite(row.secs))
		.map((row) => ({ row, score: (row.chance * row.gain) / Math.max(1, row.secs) }))
		.sort((first, second) => second.score - first.score)
		.slice(0, count).map((entry) => entry.row);
}

/** Share of the competence of an action that `stats` carry, weighed by how each term grows (weight x level^decay x decay). */
function statShare(row, lv, stats) {
	const action = ACTIONS.find((candidate) => candidate.name === row.name) ?? BLACK_OPS.find((candidate) => candidate.name === row.name);
	if (!action || !lv) return 0;
	let total = 0;
	let part = 0;
	for (let index = 0; index < STAT_KEYS.length; index++) {
		const term = action.w[index] * Math.pow(Math.max(1, lv[STAT_KEYS[index]] ?? 1), action.dc[index]);
		total += term;
		if (stats.includes(index)) part += term * action.dc[index];
	}
	return total > 0 ? part / total : 0;
}

/**
 * Rank-rate gain of the NEXT level of each skill, from the live readings. Each skill's multiplier is additive per level
 * (1 + pct x level), so the next level is worth pct / (1 + pct x level) of the current rate, and only counts where the
 * chance is not already capped:
 *   chance skills       the gain over the best few actions they apply to
 *   Reaper, Evasive     the same, through the combat stats the actions weigh
 *   Overclock           shorter actions help only while the player isn't resting for stamina (1 - restShare)
 *   Cyber's Edge        more stamina helps only while the player is resting for it (restShare)
 *   Hyperdrive          exp raises the stats and so the chance, where there is chance left to gain
 * Black Ops: when the next one is short of the safe chance, its chance (not the city's) steers the points too, see blackOpWeight.
 * @param {any} actions  the `actions` object bb-pass.js posts (rows, lv, and rank + blackOp for the next Black Op)
 * @param {Record<string, number>} levels  current level of each skill
 * @param {number} [restShare]  share of passes spent resting for stamina (0..1)
 * @returns {Record<string, number>} skill name -> gain per level
 */
export function skillValues(actions, levels = {}, restShare = REST_DEFAULT) {
	const rows = topRows(actions);
	const rest = Math.min(1, Math.max(0, Number.isFinite(restShare) ? restShare : REST_DEFAULT));
	const next = (pct, name, sign = 1) => (pct / 100) / Math.max(0.05, 1 + sign * (pct / 100) * (levels[name] ?? 0));
	const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);
	/** @type {Record<string, number>} */
	const out = {};
	for (const [name, skill] of Object.entries(CHANCE_SKILLS)) {
		out[name] = mean(rows.map((row) => (skill.applies(row) ? chanceGain(row.chance, next(skill.pct, name)) : 0)));
	}
	for (const [name, skill] of Object.entries(STAT_SKILLS)) {
		out[name] = mean(rows.map((row) => chanceGain(row.chance, next(skill.pct, name) * statShare(row, actions?.lv, skill.stats))));
	}
	const best = rows.length ? rows[0].chance : 0.5;
	out["Overclock"] = next(1, "Overclock", -1) * (1 - rest);
	out["Cyber's Edge"] = next(2, "Cyber's Edge") * rest;
	out["Hyperdrive"] = next(10, "Hyperdrive") * EXP_TO_CHANCE * (1 - best);
	const weight = blackOpWeight(actions?.blackOp, actions?.rank);
	if (weight <= 0) return out;
	const gate = blackOpValues(actions.blackOp, actions?.lv, levels, next);
	for (const name of Object.keys(out)) out[name] = (1 - weight) * out[name] + weight * (gate[name] ?? 0);
	return out;
}

/**
 * How much the next Black Op's chance should steer the skill points (0..1). The contracts and operations being played rarely
 * need more chance, but the Black Ops (difficulty 2,000 up to 80,000, all of them required to end the BitNode) sit far
 * below it: the last ones are only reachable with many levels of the chance skills. The weight grows with the rank already
 * held toward the Black Op's rank requirement and is 1 once the rank is there and the chance is what is missing; it is 0
 * when the Black Op is already safe to attempt or nothing is known about it.
 * @param {{ chance?: number, rank?: number } | undefined} blackOp  the reading bb-pass.js posts (low estimate, required rank)
 * @param {number | undefined} rank  the player's Bladeburner rank
 */
export function blackOpWeight(blackOp, rank) {
	if (!blackOp || !Number.isFinite(blackOp.chance) || blackOp.chance >= BLACKOP_CHANCE) return 0;
	const needed = Number(blackOp.rank);
	if (!(needed > 0) || !Number.isFinite(rank)) return 1;
	return Math.min(1, Math.max(0, rank / needed));
}

/** Gain of the next level of each skill for the next Black Op's chance (which city factors do not touch). */
function blackOpValues(blackOp, lv, levels, next) {
	const info = BLACK_OPS.find((candidate) => candidate.name === blackOp.name);
	const chance = Math.max(0, Number(blackOp.chance) || 0);
	const row = { name: blackOp.name };
	/** @type {Record<string, number>} */
	const out = {};
	const applies = { "Blade's Intuition": true, "Digital Observer": true, "Tracer": false, "Cloak": !!info?.stealth, "Short-Circuit": !!info?.lethal };
	for (const [name, skill] of Object.entries(CHANCE_SKILLS)) out[name] = applies[name] ? chanceGain(chance, next(skill.pct, name)) : 0;
	for (const [name, skill] of Object.entries(STAT_SKILLS)) out[name] = chanceGain(chance, next(skill.pct, name) * statShare(row, lv, skill.stats));
	out["Hyperdrive"] = next(10, "Hyperdrive") * EXP_TO_CHANCE * (1 - chance);
	out["Overclock"] = 0;
	out["Cyber's Edge"] = 0;
	return out;
}

/**
 * The skill with the most gain per skill point, or null when nothing is worth buying. The caller buys it when it can be
 * afforded and otherwise waits (points keep coming, and buying a lesser skill would only delay the best one).
 * @param {Record<string, number>} costs  skill name -> cost of the next level (Infinity or 0 = not buyable)
 * @param {Record<string, number>} values  from skillValues
 */
export function pickSkill(costs, values) {
	let best = null;
	for (const name of SKILL_NAMES) {
		const cost = costs[name];
		const value = values[name];
		if (!Number.isFinite(cost) || !(cost > 0) || !(value > 0)) continue;
		const score = value / cost;
		if (!best || score > best.score) best = { name, cost, score };
	}
	return best;
}

/** The chance factor a city gives an action: its population factor over its chaos penalty. 0 for an unknown population. */
export function cityFactor(city) {
	if (!city || !(city.pop > 0)) return 0;
	const chaos = Number.isFinite(city.chaos) ? city.chaos : 0;
	return Math.pow(city.pop / POP_BASE, POP_EXPONENT) / (chaos > CHAOS_START ? Math.sqrt(1 + chaos - CHAOS_START) : 1);
}

/**
 * The city to play in: the one whose population and chaos give the best chance, but only when the gain over the current
 * city (on the actions being played, with the chance cap) beats the noise of the estimates (the width of their ranges)
 * plus a small floor, so estimates that move a little never make the player hop between cities.
 * @param {any} actions  the `actions` object bb-pass.js posts (rows, city, cities)
 * @returns {{ city: string, gain: number, needed: number } | null} null = stay
 */
export function pickCity(actions) {
	const cities = Array.isArray(actions?.cities) ? actions.cities : [];
	const current = cities.find((city) => city.name === actions?.city);
	const rows = topRows(actions);
	if (!current || rows.length === 0 || cityFactor(current) <= 0) return null;
	const noise = rows.reduce((sum, row) => sum + Math.max(0, (row.hi ?? row.chance) - (row.lo ?? row.chance)), 0) / rows.length;
	const needed = noise + SWITCH_FLOOR;
	let best = null;
	for (const city of cities) {
		if (city.name === current.name) continue;
		const ratio = cityFactor(city) / cityFactor(current);
		if (!(ratio > 1)) continue;
		const gain = rows.reduce((sum, row) => sum + chanceGain(row.chance, ratio - 1), 0) / rows.length;
		if (gain > needed && (!best || gain > best.gain)) best = { city: city.name, gain, needed };
	}
	return best;
}

/** Moving average of the share of passes spent resting: `previous` (or the default) pulled toward this pass. */
export function nextRestShare(previous, resting) {
	const before = Number.isFinite(previous) ? previous : REST_DEFAULT;
	return before + 0.02 * ((resting ? 1 : 0) - before);
}

/**
 * The action worth scouting for: a Field Analysis tightens the population estimate of the current city, and with it the
 * chance ranges. Worth doing when an action that isn't safe by its pessimistic chance (`low` under `minChance`) has an
 * expected rank per second above the best safe action's and could still turn out safe (its `high` reaches `minChance`).
 * As the estimate converges the range narrows until the action is either safe or clearly not, so the scouting stops by
 * itself. With no safe action at all the caller already analyses.
 * @param {{ low: number, high: number, middle: number, gain: number, secs?: number, seconds?: number, count?: number }[]} rows
 * @param {number} minChance  the pessimistic chance an action needs to count as safe
 */
export function scoutTarget(rows, minChance) {
	const live = rows.filter((row) => row.count === undefined || row.count >= 1);
	const rate = (row, chance) => (chance * row.gain) / Math.max(1, row.secs ?? row.seconds ?? 1);
	const safe = live.filter((row) => row.low >= minChance);
	if (safe.length === 0) return null;
	const bar = Math.max(...safe.map((row) => rate(row, row.middle)));
	for (const row of live) {
		if (row.low >= minChance) continue;
		if (row.high >= minChance && rate(row, row.middle) > bar) return row;
	}
	return null;
}
