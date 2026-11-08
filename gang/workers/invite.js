// @ts-check
import { gangAccess } from "/utils/gang.js";
// Port singularity/player-work.js reads the answer from.
const INVITE_PORT = 30;
const COMBAT_SKILLS = ["strength", "defense", "dexterity", "agility"];
// A failed crime still gives a quarter of its karma and stat exp (but no money): v3.0.0 src/Work/CrimeWork.ts.
const FAIL_SHARE = 0.25;

/**
 * One-shot for singularity/player-work.js: what should the player do for the gang? Kept apart so
 * player-work.js doesn't pay for these Singularity calls in every BitNode. Posts JSON on port 30, then exits:
 *   { time, applies: false }       no gang to work towards (no Gang API, already in a gang, or the gang
 *                                  faction joined and the karma is low enough)
 *   { time, applies: true, faction, missing, crime, rate, chance, gain, gym, slow }
 *     missing  unmet needs as text
 *     crime    what to commit, or null if crimes can't help (only money missing, or the invite is on its way)
 *     rate     the crime's expected gain per minute at its current chance; gain says of what ("karma" or "combat exp")
 *     chance   its success chance now
 *     gym      the level to train every combat stat to in the gym instead of the crime (0 = no gym)
 *     slow     the karma grind outside BitNode 2 (karma -54,000 to create the gang), which player-work.js
 *              does only when nothing else needs the player
 * In BitNode 2 the invite is all a gang needs (Slum Snakes: karma -9, combat 30, $1m); elsewhere (Source-File 2)
 * the gang also needs karma -54,000.
 *
 * Which crime: the most expected gain per minute at the current success chance, failures included:
 *     per minute = (chance + 0.25 x (1 - chance)) x gain / minutes
 * gain is the karma a success lowers it by while karma is missing, else the exp of the combat stats still below
 * the invite's need. Asked again every 2 minutes, so the pick follows the stats as they grow. With v3.0.0's
 * numbers Homicide wins on karma at any chance: 3 karma in 3 seconds, so even failing every time it gives 0.25
 * a second, more than any other crime that always succeeds.
 *
 * Combat stats go to the gym once karma is done (gym = true): a gym gives several times the exp of any crime,
 * and the crimes that give str/def exp need str/def to succeed. Crimes train them with gym = false, or while
 * player-work.js waits for a faction invite in a city without a gym.
 *
 *   args: JSON {"factions": [...], "crimes": [...] or null (every ns.enums.CrimeType), "gym": true}
 *   (gang.factions, gang.inviteCrimes and gang.inviteGym in the config)
 */
/** @param {NS} ns */
export async function main(ns) {
	const { factions, crimes, gym } = JSON.parse(String(ns.args[0]));
	const post = (data) => {
		ns.clearPort(INVITE_PORT);
		ns.writePort(INVITE_PORT, JSON.stringify({ time: Date.now(), ...data }));
	};
	const player = ns.getPlayer();
	const access = gangAccess(ns);
	const gangFactionJoined = factions.some((faction) => player.factions.includes(faction));
	const karmaGrind = access.karmaNeeded < 0 && player.karma > access.karmaNeeded;
	if (!access.available || access.inGang || (gangFactionJoined && !karmaGrind)) {
		post({ applies: false });
		return;
	}

	const faction = factions[0];
	const missing = [];
	let needKarma = false;
	const combat = {}; // combat skill -> level the invite needs, for those below it
	if (!gangFactionJoined) {
		for (const need of ns.singularity.getFactionInviteRequirements(faction)) {
			if (need.type === "karma") {
				if (player.karma > need.karma) {
					missing.push(`karma ${ns.format.number(player.karma)} / ${need.karma}`);
					needKarma = true;
				}
			} else if (need.type === "money") {
				if (player.money < need.money) missing.push(`$${ns.format.number(need.money)}`);
			} else if (need.type === "skills") {
				for (const [skill, level] of Object.entries(need.skills)) {
					if (player.skills[skill] >= level) continue;
					missing.push(`${skill} ${player.skills[skill]} / ${level}`);
					if (COMBAT_SKILLS.includes(skill)) combat[skill] = level;
				}
			} else {
				// city, employer, backdoor...: listed, not checked (the invite itself decides).
				missing.push(`"${need.type}" (see the faction's requirements)`);
			}
		}
	}
	if (karmaGrind) {
		missing.push(`karma ${ns.format.number(player.karma)} / ${access.karmaNeeded} to create the gang`);
		needKarma = true;
	}

	const skills = Object.keys(combat);
	const gymLevel = gym && !needKarma && skills.length > 0 ? Math.max(...skills.map((skill) => combat[skill])) : 0;
	// With gym the crime is still worked out: player-work.js commits it while it waits for an invite in a city without a gym.
	const best = needKarma || skills.length > 0 ? bestCrime(ns, crimeList(ns, crimes), needKarma, skills) : null;
	post({
		applies: true, faction, missing, slow: access.karmaNeeded < 0, gym: gymLevel,
		crime: best?.name ?? null, rate: best?.rate ?? 0, chance: best?.chance ?? 0,
		gain: needKarma ? "karma" : "combat exp",
	});
}

/** The crimes to choose from: the config's list (names the game doesn't know are skipped), or every crime. */
function crimeList(ns, crimes) {
	const known = Object.values(ns.enums.CrimeType);
	if (!Array.isArray(crimes) || crimes.length === 0) return known;
	const unknown = crimes.filter((name) => !known.includes(name));
	if (unknown.length) ns.print(`gang.inviteCrimes: skipping ${unknown.join(", ")} (not a crime; names: ${known.join(", ")})`);
	const list = crimes.filter((name) => known.includes(name));
	return list.length ? list : known;
}

/** The crime with the most expected karma (or missing combat exp) per minute, failures included. */
function bestCrime(ns, crimes, needKarma, skills) {
	let best = null;
	for (const name of crimes) {
		const stats = ns.singularity.getCrimeStats(name);
		const chance = ns.singularity.getCrimeChance(name);
		const gain = needKarma ? stats.karma : skills.reduce((sum, skill) => sum + (stats[`${skill}_exp`] ?? 0), 0);
		const rate = (chance + FAIL_SHARE * (1 - chance)) * gain / (stats.time / 60_000);
		if (!best || rate > best.rate) best = { name, chance, rate };
	}
	return best && best.rate > 0 ? best : null;
}
