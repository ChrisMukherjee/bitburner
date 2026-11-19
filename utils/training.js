// Design: docs/combat-training.md
// @ts-check
// Which way raises the combat stats fastest: the gym (one stat at a time), a crime (several stats, at its success chance) or
// Bladeburner's Training (all four). Pure functions over the game's own numbers (v3.0.0 source), 0GB.

/** @typedef {"strength" | "defense" | "dexterity" | "agility"} CombatStat */
/** @typedef {Partial<Record<CombatStat, number>>} StatRates  exp per second, per stat */

/** @type {CombatStat[]} */
export const COMBAT = ["strength", "defense", "dexterity", "agility"];

/**
 * Every crime that gives combat exp: [name, time in ms, exp per success] (v3.0.0 src/Crime/Crimes.ts). The game multiplies the exp
 * by the player's exp multipliers and the BitNode's CrimeExpGain (calculateCrimeWorkStats), and a failure gives a quarter
 * (CrimeWork.commit). Kept here so the scripts don't pay 5GB for getCrimeStats; only the chance is asked of the game.
 * @type {[string, number, StatRates][]}
 */
export const COMBAT_CRIMES = [
	["Shoplift", 2e3, { dexterity: 2, agility: 2 }],
	["Rob Store", 60e3, { dexterity: 45, agility: 45 }],
	["Mug", 4e3, { strength: 3, defense: 3, dexterity: 3, agility: 3 }],
	["Larceny", 90e3, { dexterity: 60, agility: 60 }],
	["Deal Drugs", 10e3, { dexterity: 5, agility: 5 }],
	["Bond Forgery", 300e3, { dexterity: 150 }],
	["Traffick Arms", 40e3, { strength: 20, defense: 20, dexterity: 20, agility: 20 }],
	["Homicide", 3e3, { strength: 2, defense: 2, dexterity: 2, agility: 2 }],
	["Grand Theft Auto", 80e3, { strength: 20, defense: 20, dexterity: 20, agility: 80 }],
	["Kidnap", 120e3, { strength: 80, defense: 80, dexterity: 80, agility: 80 }],
	["Assassination", 300e3, { strength: 300, defense: 300, dexterity: 300, agility: 300 }],
	["Heist", 600e3, { strength: 450, defense: 450, dexterity: 450, agility: 450 }],
];
/** CrimeWork.commit: a failed crime gives this share of the exp. */
export const CRIME_FAIL_SHARE = 0.25;
/** CONSTANTS.BaseFocusBonus: crimes done unfocused without the Neuroreceptor Management Implant. Gym classes don't have the penalty. */
export const UNFOCUSED = 0.8;
/**
 * Bladeburner's General > Training (Bladeburner.completeAction): 30 exp to each combat stat every 30 s, already times the stat's
 * exp multiplier, and Player.gainStats multiplies by it again, so the rate is the multiplier squared per second.
 */
export const BB_TRAINING = { seconds: 30, exp: 30 };
/** Bladeburner bonus time runs actions up to 5x as fast (getBonusTime); it is spent at 4 extra seconds per second. */
export const BB_BONUS_SPEED = 5;

/** @param {any} mults  player.mults (strength_exp ...); missing = 1 */
const expMult = (mults, stat) => {
	const value = mults?.[`${stat}_exp`];
	return typeof value === "number" && Number.isFinite(value) ? value : 1;
};

/**
 * Exp per second the gym gives each stat if it trains that one (calculateClassEarnings: the gym's expMult, the hash upgrade's
 * training multiplier and the stat's exp multiplier; no focus penalty and no BitNode multiplier).
 * @param {any} mults @param {number} gymExpMult @param {number} [hashMult]
 * @returns {Record<CombatStat, number>}
 */
export function gymRates(mults, gymExpMult, hashMult = 1) {
	return /** @type {Record<CombatStat, number>} */ (Object.fromEntries(COMBAT.map((stat) => [stat, gymExpMult * hashMult * expMult(mults, stat)])));
}

/**
 * Expected exp per second a crime gives each combat stat at this success chance.
 * @param {StatRates} baseExp  exp per success (COMBAT_CRIMES)
 * @param {number} timeMs @param {number} chance @param {any} mults
 * @param {number} [crimeExpGain]  the BitNode's CrimeExpGain
 * @param {number} [focusMult]     1 focused (or with the implant), UNFOCUSED otherwise
 * @returns {StatRates}
 */
export function crimeRates(baseExp, timeMs, chance, mults, crimeExpGain = 1, focusMult = 1) {
	const p = Math.max(0, Math.min(1, Number(chance) || 0));
	const perTry = (p + (1 - p) * CRIME_FAIL_SHARE) * crimeExpGain * focusMult / (timeMs / 1000);
	return Object.fromEntries(COMBAT.filter((stat) => baseExp[stat]).map((stat) => [stat, (baseExp[stat] ?? 0) * expMult(mults, stat) * perTry]));
}

/**
 * How much faster than normal Bladeburner runs over the next `horizonMs` with `bonusMs` of bonus time: up to BB_BONUS_SPEED,
 * the bonus being spent at (BB_BONUS_SPEED - 1) seconds per second.
 */
export function bonusSpeed(bonusMs, horizonMs) {
	const extra = BB_BONUS_SPEED - 1;
	if (!(bonusMs > 0) || !(horizonMs > 0)) return 1;
	return 1 + Math.min(extra, bonusMs / horizonMs);
}

/**
 * Exp per second Bladeburner's Training gives each combat stat.
 * @param {any} mults @param {number} [speed]  bonusSpeed
 * @returns {Record<CombatStat, number>}
 */
export function bladeburnerTrainingRates(mults, speed = 1) {
	return /** @type {Record<CombatStat, number>} */ (Object.fromEntries(COMBAT.map((stat) => {
		const mult = expMult(mults, stat);
		return [stat, BB_TRAINING.exp * mult * mult * speed / BB_TRAINING.seconds];
	})));
}

/**
 * A method's worth in gym-seconds per second: every exp it adds to a stat still below the floor saves 1 / gymRate of a second in
 * the gym, so the gym itself is worth 1 and anything above 1 gets the stats there sooner. Exp to a stat already at the floor
 * counts nothing.
 * @param {StatRates} rates @param {Record<CombatStat, number>} gym @param {CombatStat[]} need
 */
export function trainingScore(rates, gym, need) {
	return need.reduce((sum, stat) => sum + (gym[stat] > 0 ? (rates[stat] ?? 0) / gym[stat] : 0), 0);
}

/**
 * The fastest way to bring every stat in `need` up: { method: "gym" | "crime" | "bladeburner", name, score }. The gym wins ties
 * (it is what the scripts did before), and a gym out of reach this pass (`gymReachable` false) scores 0.
 * @param {{ need: CombatStat[], gym: Record<CombatStat, number>, gymReachable?: boolean,
 *   crimes?: { name: string, rates: StatRates }[], bladeburner?: StatRates | null }} options
 * @returns {{ method: "gym" | "crime" | "bladeburner", name: string, score: number, gymScore: number }}
 */
export function pickTraining({ need, gym, gymReachable = true, crimes = [], bladeburner = null }) {
	const gymScore = gymReachable && need.length > 0 ? 1 : 0;
	/** @type {{ method: "gym" | "crime" | "bladeburner", name: string, score: number, gymScore: number }} */
	let best = { method: "gym", name: "", score: gymScore, gymScore };
	for (const crime of crimes) {
		const score = trainingScore(crime.rates, gym, need);
		if (score > best.score) best = { method: "crime", name: crime.name, score, gymScore };
	}
	if (bladeburner) {
		const score = trainingScore(bladeburner, gym, need);
		if (score > best.score) best = { method: "bladeburner", name: "Training", score, gymScore };
	}
	return best;
}
