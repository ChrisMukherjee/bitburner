// Design: docs/gang.md
// @ts-check

/**
 * The game's own gang formulas (Bitburner v3.0.0, src/Gang/formulas/formulas.ts and GangMember.ts), as plain
 * functions so gang/gang-manager.js needs neither Formulas.exe nor a trial assignment. 0GB. All rates are
 * per second (the game works per 200ms cycle, so times CYCLES_PER_SECOND). `task` is what ns.gang.getTaskStats
 * returns; `stats` is { hack, str, def, dex, agi, cha }; `gang` is { respect, wanted, territory, softcap? }.
 */

export const CYCLES_PER_SECOND = 5;
export const STAT_NAMES = ["hack", "str", "def", "dex", "agi", "cha"];

/** Each rate subtracts a different multiple of the task difficulty from the weighted stats. */
const DIFFICULTY_FACTOR = { respect: 4, wanted: 3.5, money: 3.2 };

/** Weighted stat sum of a task (percent weights), minus factor x difficulty. 0 or less: the task pays nothing. */
export function taskWeight(task, stats, kind) {
	const sum = (task.hackWeight * (stats["hack"] ?? 0) + task.strWeight * (stats.str ?? 0) + task.defWeight * (stats.def ?? 0) +
		task.dexWeight * (stats.dex ?? 0) + task.agiWeight * (stats.agi ?? 0) + task.chaWeight * (stats.cha ?? 0)) / 100;
	return sum - DIFFICULTY_FACTOR[kind] * task.difficulty;
}

/**
 * Territory scaling of a task's payout: (territory x 100)^exponent / 100, at least 0.5%. EVERY task scales
 * with land: the exponent defaults to 1 (a gang holding 1/7 of the land earns 1/7 of the full rate), and
 * is 1.1 to 2 on the "heavy" tasks. Owning all land is worth 7x on a default task and 18x on Human Trafficking.
 */
export function territoryMult(task, field, territory) {
	return Math.max(0.005, Math.pow(territory * 100, task.territory?.[field] ?? 1) / 100);
}

/** Money and respect gains are raised to this power: owning all land removes the 20% cut. */
export function territoryPenalty(gang) {
	return (0.2 * gang.territory + 0.8) * (gang.softcap ?? 1);
}

/** Share of respect and money that survives the wanted level (1 = no penalty). */
export function wantedFactor(gang) {
	return gang.respect / (gang.respect + gang.wanted);
}

/** Respect per second. */
export function respectRate(task, stats, gang) {
	if (!task.baseRespect) return 0;
	const weight = taskWeight(task, stats, "respect");
	if (weight <= 0) return 0;
	const land = territoryMult(task, "respect", gang.territory);
	return Math.pow(11 * task.baseRespect * weight * land * wantedFactor(gang), territoryPenalty(gang)) * CYCLES_PER_SECOND;
}

/** Money per second. */
export function moneyRate(task, stats, gang) {
	if (!task.baseMoney) return 0;
	const weight = taskWeight(task, stats, "money");
	if (weight <= 0) return 0;
	const land = territoryMult(task, "money", gang.territory);
	return Math.pow(5 * task.baseMoney * weight * land * wantedFactor(gang), territoryPenalty(gang)) * CYCLES_PER_SECOND;
}

/**
 * Wanted level per second (negative for the tasks that lower it). Tasks that raise it get cheaper per
 * point of skill: stronger members raise the level LESS on the same task.
 */
export function wantedRate(task, stats, gang) {
	if (!task.baseWanted) return 0;
	const weight = taskWeight(task, stats, "wanted");
	if (weight <= 0) return 0;
	const land = territoryMult(task, "wanted", gang.territory);
	if (task.baseWanted < 0) return 0.4 * task.baseWanted * weight * land * CYCLES_PER_SECOND;
	return Math.min(100, (7 * task.baseWanted) / Math.pow(3 * weight * land, 0.8)) * CYCLES_PER_SECOND;
}

/** A stat level from its experience and total multiplier (equipment x ascension). */
export function skillLevel(exp, mult) {
	return Math.max(Math.floor(mult * (32 * Math.log(exp + 534.5) - 200)), 1);
}

/** Experience at which the un-multiplied level (mult 1) reaches `level`: the inverse of skillLevel. */
export function expForLevel(level) {
	return Math.max(0, Math.exp((level + 200) / 32) - 534.5);
}

/** Ascension points a stat's experience turns into (the first 1000 exp are lost). */
export function ascensionPoints(exp) {
	return Math.max(exp - 1000, 0);
}

/** Ascension multiplier from the points a stat has banked. */
export function ascensionMult(points) {
	return Math.max(Math.sqrt(points / 2000), 1);
}

/**
 * Experience per second a member gains in one stat on a task. `expMult` is the member's equipment/augment
 * multiplier for the stat (its _mult), `ascMult` its ascension multiplier (its _asc_mult).
 */
export function expRate(task, stat, expMult, ascMult) {
	const weight = task[`${stat}Weight`] ?? 0;
	if (!weight) return 0;
	return (weight / 1500) * Math.pow(task.difficulty, 0.9) * ((expMult - 1) / 4 + 1) * ascMult * CYCLES_PER_SECOND;
}

/** Power one member adds per Territory Warfare update. */
export function memberPower(stats) {
	return STAT_NAMES.reduce((sum, stat) => sum + (stats[stat] ?? 0), 0) / 95;
}

/**
 * Territory a clash moves (mean of the game's random factor 0.5..1.5 is 1): the stronger side takes more.
 * `winner`/`loser` are { power, territory }.
 */
export function clashGain(winner, loser) {
	const bonus = Math.max(1, 1 + Math.log(winner.power / loser.power) / Math.log(50));
	return Math.min(loser.territory, bonus * 0.0001);
}

/**
 * Expected result of clashing with each gang that still holds land (the game picks the opponent at random
 * among them): our share of the territory that changes hands, 0..1. 0.5 = an even exchange. Replaces
 * "win chance against the worst opponent": one far stronger gang no longer blocks clashes against weak ones
 * when the land we would take outweighs the land we would lose.
 * @param {{ power: number, territory: number }} us
 * @param {{ power: number, territory: number }[]} others
 */
export function clashOutlook(us, others) {
	let won = 0;
	let lost = 0;
	for (const other of others) {
		const chance = us.power / Math.max(1e-9, us.power + other.power);
		won += chance * clashGain(us, other);
		lost += (1 - chance) * clashGain(other, us);
	}
	return won + lost > 0 ? won / (won + lost) : 0;
}
