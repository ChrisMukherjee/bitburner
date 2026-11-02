import { gangAccess } from "/utils/gang.js";
// Port singularity/player-work.js reads the answer from.
const INVITE_PORT = 30;
const COMBAT_SKILLS = ["strength", "defense", "dexterity", "agility"];

/**
 * One-shot for singularity/player-work.js: should the player commit crimes for the gang invite,
 * and which crime? Kept apart so player-work.js doesn't pay for these Singularity calls in every
 * BitNode. Posts JSON on port 30, then exits:
 *   { time, applies: false }                         a gang needs more than the invite here, already in a gang,
 *                                                     or a gang faction joined
 *   { time, applies: true, faction, missing, crime } missing = unmet invite needs as text;
 *                                                     crime = what to commit, or null if crimes can't help
 * Only where the invite is all a gang needs (BitNode 2): elsewhere it also needs karma -54,000,
 * a long grind of its own.
 * UNTESTED IN GAME (written before reaching BitNode 2).
 *
 *   args: JSON {"factions": [...], "crimes": [...]} (gang.factions and gang.inviteCrimes in the config)
 */
/** @param {NS} ns */
export async function main(ns) {
	const { factions, crimes } = JSON.parse(String(ns.args[0]));
	const post = (data) => {
		ns.clearPort(INVITE_PORT);
		ns.writePort(INVITE_PORT, JSON.stringify({ time: Date.now(), ...data }));
	};
	const player = ns.getPlayer();
	// Crimes only help where the invite is all a gang needs (no karma -54,000 grind; see utils/gang.js).
	const access = gangAccess(ns);
	if (!access.available || access.karmaNeeded < 0 || access.inGang || factions.some((faction) => player.factions.includes(faction))) {
		post({ applies: false });
		return;
	}

	const faction = factions[0];
	const missing = [];
	let crimeHelps = false;
	for (const need of ns.singularity.getFactionInviteRequirements(faction)) {
		if (need.type === "karma") {
			if (player.karma > need.karma) {
				missing.push(`karma ${ns.format.number(player.karma)} / ${need.karma}`);
				crimeHelps = true;
			}
		} else if (need.type === "money") {
			if (player.money < need.money) missing.push(`$${ns.format.number(need.money)}`);
		} else if (need.type === "skills") {
			for (const [skill, level] of Object.entries(need.skills)) {
				if (player.skills[skill] >= level) continue;
				missing.push(`${skill} ${player.skills[skill]} / ${level}`);
				if (COMBAT_SKILLS.includes(skill)) crimeHelps = true;
			}
		} else {
			// city, employer, backdoor...: listed, not checked (the invite itself decides). UNTESTED wording.
			missing.push(`"${need.type}" (see the faction's requirements)`);
		}
	}

	// Fastest karma: success chance x karma / time. Low stats make Homicide fail a lot, so Mug wins
	// early; both train the four combat stats.
	const rate = (crime) => {
		const stats = ns.singularity.getCrimeStats(crime);
		return ns.singularity.getCrimeChance(crime) * stats.karma / stats.time;
	};
	const best = crimeHelps ? crimes.reduce((first, second) => (rate(second) > rate(first) ? second : first)) : null;
	post({ applies: true, faction, missing, crime: best });
}
