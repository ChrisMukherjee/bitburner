// @ts-check
// Gym tables shared by singularity/player-work.js and singularity/workers/start-gang.js. Plain data, 0GB.

// [skill, the GymType the API wants, the class name the game reports for the current work]
export const GYM_STATS = [["strength", "str", "GYMSTRENGTH"], ["defense", "def", "GYMDEFENSE"], ["dexterity", "dex", "GYMDEXTERITY"], ["agility", "agi", "GYMAGILITY"]];
// Gyms by city, best first: [name, cost per second, exp multiplier] (v3.0.0 LocationsMetadata.ts: $120/s x costMult,
// and expMult: one exp a second x expMult to the stat trained). The better one only with cash for GYM_CASH_SECONDS.
export const GYMS = {
	"Sector-12": [["Powerhouse Gym", 2400, 10], ["Iron Gym", 120, 1]],
	"Aevum": [["Snap Fitness Gym", 1200, 5], ["Crush Fitness Gym", 360, 2]],
	"Volhaven": [["Millenium Fitness Gym", 840, 4]],
};
export const GYM_CITY = "Sector-12"; // where to fly when the current city has no gym
export const GYM_CASH_SECONDS = 600;
