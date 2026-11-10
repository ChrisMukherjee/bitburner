// Design: docs/bladeburner.md
// @ts-check
// The team and the Black Op gate, for bb-pass.js (when to attempt the next Black Op, when to recruit) and bb-manage.js
// (how many members go on it). Pure functions, no ns calls, 0GB. The numbers are the game's own (bitburner-src v3.0.0:
// Actions/Operation.ts operationTeamSuccessBonus, Actions/TeamCasualties.ts, data/BlackOperations.ts, data/GeneralActions.ts
// Recruitment, Hospital/Hospital.ts).
//
// Everything is priced in seconds of the player's rank flow (the rank per second the best action earns), so a failure's rank
// loss, the members it kills, the hospital bill and the time itself can be added up and compared:
//   time         an attempt's seconds, times the share of the player's time that would otherwise earn rank (timeValue: when
//                the counts of every safe action are used up, that time earns nothing, so it is nearly free)
//   members      each one lost costs the seconds needed to recruit a replacement (seconds / recruit chance), at the same time value
//   rank loss    a failure's fixed rank loss / rank per second
//   hospital     a failure's damage hospitalises the player when it reaches the current HP; the bill / income per second
import { blackOpDifficulty } from "/bladeburner/picks.js";

const TEAM_EXPONENT = 0.05;            // Operations and Black Ops: competence x (team + 1) ^ 0.05
const MIN_BLACK_OP_LOSSES = 1;         // a Black Op with a team kills at least one member, win or lose (Operations: 0)
const LOW_CASUALTIES = 0.5;            // a win kills up to ceil(team x 0.5)
const HIGH_CASUALTIES = 1;             // a loss kills up to floor(team x 1)
const DIFF_EXPONENT = 0.28;            // damage = hpLoss x (difficulty ^ 0.28 + difficulty / 650)
const DIFF_LINEAR = 650;
const HOSPITAL_COST_PER_HP = 100e3;    // CONSTANTS.HospitalCostPerHp
const HOSPITAL_CASH_SHARE = 0.1;       // the bill is never more than 10 % of the cash
const MAX_TEAM_SEARCH = 5000;          // members tried when choosing the team (charisma keeps real teams far below this)
const TREND_EVERY_MS = 5 * 60_000;     // one chance sample per 5 minutes...
const TREND_WINDOW_MS = 2 * 3600_000;  // ...over the last 2 hours
const TREND_MIN_SPAN_MS = 30 * 60_000; // the growth of the chance is known once the samples span half an hour...
const TREND_MIN_SAMPLES = 4;           // ...and there are at least this many

// [name, required rank, rank lost on a failure, hpLoss] (data/BlackOperations.ts), in the order they must be done.
/** @type {[string, number, number, number][]} */
const STAKES_TABLE = [
	["Operation Typhoon", 2.5e3, 10, 100], ["Operation Zero", 5e3, 15, 50], ["Operation X", 7.5e3, 15, 100],
	["Operation Titan", 10e3, 20, 100], ["Operation Ares", 12.5e3, 20, 200], ["Operation Archangel", 15e3, 20, 25],
	["Operation Juggernaut", 20e3, 40, 300], ["Operation Red Dragon", 25e3, 50, 500], ["Operation K", 30e3, 60, 1000],
	["Operation Deckard", 40e3, 75, 200], ["Operation Tyrell", 50e3, 100, 500], ["Operation Wallace", 75e3, 150, 1500],
	["Operation Shoulder of Orion", 100e3, 500, 1500], ["Operation Hyron", 125e3, 1e3, 500], ["Operation Morpheus", 150e3, 1e3, 100],
	["Operation Ion Storm", 175e3, 1e3, 5000], ["Operation Annihilus", 200e3, 1e3, 10e3], ["Operation Ultron", 250e3, 2e3, 10e3],
	["Operation Centurion", 300e3, 5e3, 10e3], ["Operation Vindictus", 350e3, 20e3, 20e3], ["Operation Daedalus", 400e3, 10e3, 100e3],
];
const BLACK_OP_STAKES = STAKES_TABLE.map(([name, rank, rankLoss, hpLoss]) => ({ name, rank, rankLoss, hpLoss }));

/** A Black Op's stakes (required rank, rank lost and hpLoss on a failure, its index in the chain), or null for an unknown name. */
export function blackOpStakes(name) {
	const index = BLACK_OP_STAKES.findIndex((entry) => entry.name === name);
	return index < 0 ? null : { ...BLACK_OP_STAKES[index], index };
}

/** The rank the Black Op after this one needs, or null when this is the last (or unknown). */
export function followingRank(name) {
	const stakes = blackOpStakes(name);
	return stakes && stakes.index + 1 < BLACK_OP_STAKES.length ? BLACK_OP_STAKES[stakes.index + 1].rank : null;
}

/** The chance multiplier of a team on an Operation or Black Op: (members + 1) ^ 0.05 (20 members: x1.16, 100: x1.26). */
export function teamBonus(members) {
	return Math.pow(Math.max(0, Math.floor(members || 0)) + 1, TEAM_EXPONENT);
}

/**
 * Members a Black Op is expected to kill: a whole number drawn evenly between 1 and ceil(team / 2) on a win, 1 and the whole
 * team on a loss. 0 without a team.
 */
export function expectedLosses(members, success) {
	const team = Math.max(0, Math.floor(members || 0));
	if (team <= 0) return 0;
	const most = success ? Math.ceil(team * LOW_CASUALTIES) : Math.floor(team * HIGH_CASUALTIES);
	return MIN_BLACK_OP_LOSSES <= most ? (MIN_BLACK_OP_LOSSES + most) / 2 : MIN_BLACK_OP_LOSSES;
}

/**
 * The hospital bill a failed Black Op leaves: its damage (hpLoss x (difficulty ^ 0.28 + difficulty / 650)) hospitalises the
 * player when it reaches the current HP, and the bill is (HP missing) x $100k, at most 10 % of the cash. 0 when the
 * player survives, or when HP or cash are unknown.
 * @param {string} name
 * @param {{ current: number, max: number } | undefined} hp
 * @param {number | undefined} money
 */
export function failureBill(name, hp, money) {
	const stakes = blackOpStakes(name);
	const difficulty = blackOpDifficulty(name);
	if (!stakes || !Number.isFinite(difficulty) || !hp || !Number.isFinite(hp.current) || !Number.isFinite(hp.max) || !(money > 0)) return 0;
	const damage = stakes.hpLoss * (Math.pow(difficulty, DIFF_EXPONENT) + difficulty / DIFF_LINEAR);
	if (damage < hp.current) return 0;
	return Math.max(0, Math.min(money * HOSPITAL_CASH_SHARE, (hp.max - (hp.current - damage)) * HOSPITAL_COST_PER_HP));
}

/**
 * @typedef {object} Pricing  what an attempt costs, all in seconds of the player's rank flow
 * @property {number} chance0      the Black Op's chance with no team (low estimate)
 * @property {number} secs         seconds per attempt
 * @property {number} timeValue    share of the player's time that would otherwise earn rank (0..1)
 * @property {number} memberSecs   seconds to recruit one replacement member, at that time value (Infinity: none can be recruited)
 * @property {number} failSecs     a failure's rank loss and hospital bill, in seconds
 */

/** One attempt's cost on a win and on a loss, and the chance, with `members` on the Black Op. */
function attemptCosts(pricing, members) {
	const chance = Math.min(1, pricing.chance0 * teamBonus(members));
	const memberCost = (losses) => (losses > 0 ? losses * pricing.memberSecs : 0); // 0 x Infinity = no team, no cost
	const time = pricing.secs * pricing.timeValue;
	return {
		chance,
		win: time + memberCost(expectedLosses(members, true)),
		loss: time + memberCost(expectedLosses(members, false)) + pricing.failSecs,
	};
}

/**
 * Expected cost of getting the Black Op done with `members` on it, attempting until it succeeds: the win's cost plus the
 * expected (1 - p) / p failures before it. Infinity at chance 0.
 * @param {Pricing} pricing
 * @param {number} members
 */
export function completionCost(pricing, members) {
	const { chance, win, loss } = attemptCosts(pricing, members);
	if (!(chance > 0)) return Infinity;
	return win + (loss * (1 - chance)) / chance;
}

/**
 * The team size (0..size) that gets the Black Op done cheapest: each member adds chance (x (n + 1) ^ 0.05) but the Black Op
 * kills at least one of them per attempt, more on a failure. When members are free to replace (spare time), the whole team
 * goes; when every member costs minutes of rank, a small chance gain doesn't pay for them. Ties go to the smaller team.
 * @param {Pricing} pricing
 * @param {number} size  members available
 * @returns {{ members: number, cost: number }}
 */
export function bestTeam(pricing, size) {
	const top = Math.min(MAX_TEAM_SEARCH, Math.max(0, Math.floor(size || 0)));
	let best = { members: 0, cost: completionCost(pricing, 0) };
	for (let members = 1; members <= top; members++) {
		const cost = completionCost(pricing, members);
		if (cost < best.cost - 1e-9) best = { members, cost };
	}
	return best;
}

/**
 * How much one more member would lower the Black Op's cost (seconds of rank flow, never below 0): what a recruit is worth now.
 * @param {Pricing} pricing
 * @param {number} size
 */
export function memberValue(pricing, size) {
	const now = bestTeam(pricing, size).cost;
	const more = bestTeam(pricing, size + 1).cost;
	return Number.isFinite(now) && Number.isFinite(more) ? Math.max(0, now - more) : 0;
}

/**
 * Seconds of recruiting per member: the action's seconds over its success chance (Recruitment succeeds with
 * charisma ^ 0.45 / (team + 1), so the next member gets dearer as the team grows). Infinity when it can't succeed.
 */
export function recruitSeconds(seconds, chance) {
	return chance > 0 && seconds > 0 ? seconds / Math.min(1, chance) : Infinity;
}

/**
 * The trend of the next Black Op's chance (without the team), one sample per 5 minutes over the last 2 hours. Starts over
 * when the Black Op changes.
 * @param {{ name?: string, samples?: { t: number, p: number }[] } | undefined} previous
 * @param {string} name
 * @param {number} chance0
 * @param {number} now
 */
export function nextTrend(previous, name, chance0, now) {
	const samples = previous?.name === name && Array.isArray(previous.samples)
		? previous.samples.filter((sample) => now - sample.t < TREND_WINDOW_MS) : [];
	if (Number.isFinite(chance0) && (samples.length === 0 || now - samples[samples.length - 1].t >= TREND_EVERY_MS)) samples.push({ t: now, p: chance0 });
	return { name, samples };
}

/** Growth of the chance per second (least squares over the trend), or NaN until the samples span half an hour. */
export function chanceGrowth(trend) {
	const samples = Array.isArray(trend?.samples) ? trend.samples : [];
	if (samples.length < TREND_MIN_SAMPLES || samples[samples.length - 1].t - samples[0].t < TREND_MIN_SPAN_MS) return NaN;
	const meanT = samples.reduce((sum, sample) => sum + sample.t, 0) / samples.length;
	const meanP = samples.reduce((sum, sample) => sum + sample.p, 0) / samples.length;
	let top = 0;
	let bottom = 0;
	for (const sample of samples) {
		top += (sample.t - meanT) * (sample.p - meanP);
		bottom += (sample.t - meanT) ** 2;
	}
	return bottom > 0 ? (top / bottom) * 1000 : NaN; // per millisecond -> per second
}

/**
 * Whether to attempt the next Black Op now, and the team it should have. Its rank is already reached (the caller checks).
 *   safe          the chance is at the safe line (`safeChance`, the old fixed gate): go, as before.
 *   pays          the expected cost of getting it done is below the rank it gives: it is a better use of the time than the
 *                 Contracts and Operations (nearly always true while the counts are used up and time is free).
 *   chain         the rank is not what holds the BitNode back any more (the rank the Black Op after this one needs is reached
 *                 sooner than this one would get done, or this is the last): every second of waiting delays the end. Waiting
 *                 only pays while the chance grows fast enough that a failed attempt costs more than the time it saves:
 *                 attempt once p >= sqrt(failure cost x growth per second) (the minimum of w + cost(p + g w)). Until the
 *                 growth is measured (half an hour of samples) it waits, unless it is safe or pays.
 *   wait          otherwise: the rank for the next Black Op is still the limit, so the time goes to rank and the chance grows.
 * @param {object} input
 * @param {string} input.name
 * @param {number} input.chance      low estimate as read (with the members now assigned to it)
 * @param {number} input.assigned    members assigned to it now
 * @param {number} input.size        members in the team
 * @param {number} input.gain        rank on success
 * @param {number} input.secs        seconds per attempt
 * @param {number} input.rank        rank now
 * @param {number} input.rankRate    rank per second of the player's play (measured, or the best action's); NaN when unknown
 * @param {number} input.recruitSecs seconds of recruiting per member (Infinity when none can be recruited)
 * @param {number} input.timeValue   share of the player's time that earns rank (0..1)
 * @param {number} input.bill        hospital bill of a failure ($)
 * @param {number} input.income      income, $ per second
 * @param {number} input.growth      growth of the no-team chance per second (NaN = not measured yet)
 * @param {number} input.safeChance  the chance at which it always goes
 */
export function blackOpDecision(input) {
	const rate = input.rankRate > 0 ? input.rankRate : NaN;
	const stakes = blackOpStakes(input.name);
	const assigned = Math.max(0, Math.min(input.assigned || 0, input.size || 0));
	const chance0 = Math.max(0, input.chance) / teamBonus(assigned);
	const timeValue = Math.min(1, Math.max(0, Number.isFinite(input.timeValue) ? input.timeValue : 1));
	const failSecs = (Number.isFinite(rate) ? (stakes?.rankLoss ?? 0) / rate : 0) + (input.income > 0 ? (input.bill || 0) / input.income : 0);
	/** @type {Pricing} */
	const pricing = {
		chance0, secs: input.secs, timeValue, failSecs,
		memberSecs: Number.isFinite(input.recruitSecs) ? input.recruitSecs * timeValue : Infinity,
	};
	const team = bestTeam(pricing, input.size || 0);
	const chance = Math.min(1, chance0 * teamBonus(assigned));
	const cost = completionCost(pricing, assigned);
	const reward = Number.isFinite(rate) ? input.gain / rate : NaN;
	const nextRank = followingRank(input.name);
	// Seconds until the rank the Black Op after this one needs is reached (this one's reward counted); 0 for the last one
	const slack = nextRank === null ? 0 : Number.isFinite(rate) ? Math.max(0, nextRank - input.rank - input.gain) / rate : Infinity;
	const wall = chance > 0 ? input.secs / chance : Infinity; // seconds of attempts until it is done
	const base = { team: team.members, all: team.members >= (input.size || 0) && team.members > 0, chance0, chance, cost, reward, slack, growth: input.growth, pricing };
	const pct = (value) => `${Math.round(value * 100)}%`;
	if (chance >= input.safeChance) return { ...base, attempt: true, reason: "safe", why: `${pct(chance)} chance` };
	if (Number.isFinite(reward) && cost <= reward) {
		return { ...base, attempt: true, reason: "pays", why: `${pct(chance)} chance; costs about ${Math.round(cost)} s of rank, gives ${Math.round(reward)} s` };
	}
	if (slack <= wall) {
		const full = attemptCosts({ ...pricing, timeValue: 1, memberSecs: Number.isFinite(input.recruitSecs) ? input.recruitSecs : Infinity }, assigned).loss;
		if (!Number.isFinite(input.growth)) {
			return { ...base, attempt: false, reason: "measuring", why: `${pct(chance)} chance; measuring how fast it grows before risking it` };
		}
		const line = input.growth > 0 ? Math.sqrt(full * input.growth) : 0;
		if (chance >= line) return { ...base, attempt: true, reason: "chain", why: `${pct(chance)} chance; it now holds the BitNode back and waiting would cost more than a failure` };
		return { ...base, attempt: false, reason: "growing", why: `${pct(chance)} chance, growing ${(input.growth * 3600 * 100).toFixed(1)} points an hour: worth waiting until ${pct(line)}` };
	}
	const hours = slack / 3600;
	return {
		...base, attempt: false, reason: "rank",
		why: `${pct(chance)} chance; rank for the next Black Op is still the limit (~${hours < 10 ? hours.toFixed(1) : Math.round(hours)} h), so the time goes to rank`,
	};
}
