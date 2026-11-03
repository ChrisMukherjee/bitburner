import { gangAccess } from "/utils/gang.js";
// Port singularity/player-work.js reads the answer from.
const INVITE_PORT = 30;
const COMBAT_SKILLS = ["strength", "defense", "dexterity", "agility"];

/**
 * One-shot for singularity/player-work.js: should the player commit crimes for the gang, and which
 * crime? Kept apart so player-work.js doesn't pay for these Singularity calls in every BitNode.
 * Posts JSON on port 30, then exits:
 *   { time, applies: false }                         no gang to work towards (no Gang API, already in a gang,
 *                                                     or the gang faction joined and the karma is low enough)
 *   { time, applies: true, faction, missing, crime, slow }
 *                                                     missing = unmet needs as text; crime = what to commit, or
 *                                                     null if crimes can't help; slow = the karma grind outside
 *                                                     BitNode 2 (karma -54,000 to create the gang), which
 *                                                     player-work.js does only when nothing else needs the player
 * In BitNode 2 the invite is all a gang needs; elsewhere (Source-File 2) the gang also needs karma -54,000.
 *
 * Which crime: every crime in the list is scored by what it is expected to give per second,
 *     score = chance x (karma + skillWeight x exp) / seconds
 * karma is what a success lowers it by and exp the stat experience it gives (stats lift the chance of the
 * harder crimes). Early on an easy crime with a high chance wins; as stats rise the harder, higher-karma crimes
 * take over by themselves. Once the best karma crime has a good chance, stat experience stops counting.
 * The scoring comes from the other player's crime script, which has run in game; the BitNode 2 invite path
 * is untested (written before reaching BitNode 2).
 *
 *   args: JSON {"factions": [...], "crimes": [...], "skillWeight": n, "goodChance": n}
 *   (gang.factions, gang.inviteCrimes, gang.crimeSkillWeight and gang.crimeGoodChance in the config)
 */
/** @param {NS} ns */
export async function main(ns) {
	const { factions, crimes, skillWeight, goodChance } = JSON.parse(String(ns.args[0]));
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
	let needExp = false;
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
					if (COMBAT_SKILLS.includes(skill)) needExp = true;
				}
			} else {
				// city, employer, backdoor...: listed, not checked (the invite itself decides). UNTESTED wording.
				missing.push(`"${need.type}" (see the faction's requirements)`);
			}
		}
	}
	if (karmaGrind) {
		missing.push(`karma ${ns.format.number(player.karma)} / ${access.karmaNeeded} to create the gang`);
		needKarma = true;
	}

	const crime = needKarma || needExp ? bestCrime(ns, crimes, needKarma, skillWeight, goodChance) : null;
	post({ applies: true, faction, missing, crime, slow: access.karmaNeeded < 0 });
}

/** The crime with the best score (see above); the one with the best chance if none scores above 0. */
function bestCrime(ns, crimes, needKarma, skillWeight, goodChance) {
	const rows = crimes.map((name) => {
		const stats = ns.singularity.getCrimeStats(name);
		const exp = Object.entries(stats)
			.filter(([key, value]) => key.endsWith("_exp") && key !== "intelligence_exp" && typeof value === "number")
			.reduce((sum, [, value]) => sum + value, 0);
		return { name, chance: ns.singularity.getCrimeChance(name), karma: stats.karma, exp, seconds: Math.max(0.5, stats.time / 1000) };
	});
	// Karma first (it is what a gang needs everywhere); stats count only while they limit the best karma
	// crime. With only stats missing (BitNode 2, karma already low enough) experience is all that counts.
	const topKarma = rows.reduce((top, row) => (row.chance * row.karma / row.seconds > top.chance * top.karma / top.seconds ? row : top));
	const weight = !needKarma ? 1 : topKarma.chance >= goodChance ? 0 : skillWeight;
	for (const row of rows) {
		row.score = row.chance * ((needKarma ? row.karma : 0) + weight * row.exp) / row.seconds;
	}
	const byScore = rows.slice().sort((first, second) => second.score - first.score);
	return byScore[0].score > 0 ? byScore[0].name : rows.slice().sort((first, second) => second.chance - first.chance)[0].name;
}
