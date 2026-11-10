// Design: docs/player-work.md
// @ts-check
import { loadConfig } from "/utils/config.js";
import { wantedBoosts } from "/utils/aug-filter.js";
// Port singularity/player-work.js reads the answer from.
const CRIME_INVITE_PORT = 39;
const NEUROFLUX = "NeuroFlux Governor";
const COMBAT_SKILLS = ["strength", "defense", "dexterity", "agility"];
// A failed crime still gives a quarter of its karma (v3.0.0 src/Work/CrimeWork.ts); kills only on a success.
const FAIL_SHARE = 0.25;

/**
 * One-shot for singularity/player-work.js on the Bladeburner route: which crime faction (Tetrads, The Syndicate, Speakers for
 * the Dead, The Dark Army, Slum Snakes: `crimeFactions.factions`) to get an invite from next, and what is still missing.
 * These sell most of the combat augments, and their invites need things nothing else in the scripts does: karma, people
 * killed (both from crimes; karma stays across installs, kills restart at each one), a city, and combat levels. Kept apart so
 * player-work.js doesn't pay for these Singularity calls. Posts JSON on port 39, then exits:
 *   { time, applies: false, blocked }   no listed faction sells a wanted augment and can be reached
 *   { time, applies: true, faction, missing, city, crime, rate, chance, gain, gym, blocked }
 *     missing  unmet needs as text
 *     city     the city to be in (null when the player is already in a right one)
 *     crime    what to commit for the karma or kills, or null when neither is missing
 *     rate     the crime's expected karma (or kills) per minute at its chance; gain says which
 *     gym      the level to train every combat stat to (0 = none)
 *     blocked  [{ faction, why }]: listed factions skipped for a need the scripts can't meet (hacking level, a job to quit)
 * Joined factions, ones whose invite is already waiting (singularity/join-factions.js accepts it) and ones selling nothing
 * wanted (utils/aug-filter.js, with the route's weights) are skipped. The first reachable faction in the list order wins.
 *
 *   args: JSON {"factions": [...], "crimes": [...] or null (every ns.enums.CrimeType)}
 */
/** @param {NS} ns */
export async function main(ns) {
	const { factions, crimes } = JSON.parse(String(ns.args[0]));
	const post = (data) => {
		ns.clearPort(CRIME_INVITE_PORT);
		ns.writePort(CRIME_INVITE_PORT, JSON.stringify({ time: Date.now(), ...data }));
	};
	const player = ns.getPlayer();
	const augConfig = loadConfig(ns).augments;
	const owned = new Set(ns.singularity.getOwnedAugmentations(true));
	const invited = new Set(ns.singularity.checkFactionInvitations());
	const candidates = [];
	for (const faction of Array.isArray(factions) ? factions : []) {
		if (player.factions.includes(faction) || invited.has(faction)) continue;
		let augs = [];
		try { augs = ns.singularity.getAugmentationsFromFaction(faction); } catch { continue; /* not a faction name */ }
		const wanted = augs.filter((aug) => aug !== NEUROFLUX && !owned.has(aug) && wantedBoosts(aug, ns.singularity.getAugmentationStats(aug), augConfig));
		if (wanted.length === 0) continue;
		candidates.push({ faction, wanted, needs: ns.singularity.getFactionInviteRequirements(faction) });
	}
	const pick = pickInvite(candidates, player);
	if (!pick.faction) {
		post({ applies: false, blocked: pick.blocked });
		return;
	}
	const gain = pick.karma !== null ? "karma" : pick.kills !== null ? "kills" : null;
	const best = gain ? bestCrime(ns, crimeList(ns, crimes), gain) : null;
	post({
		applies: true, faction: pick.faction, missing: pick.missing, city: pick.city, gym: pick.gym, blocked: pick.blocked,
		crime: best?.name ?? null, rate: best?.rate ?? 0, chance: best?.chance ?? 0, gain,
	});
}

/**
 * @typedef {{ money: number, karma: number, numPeopleKilled: number, city: string, jobs: Record<string, string>,
 *   skills: any }} InvitePlayer
 * @typedef {{ missing: string[], blocked: string[], city: string | null, karma: number | null, kills: number | null, gym: number }} Needs
 */

/**
 * The first candidate whose invite the scripts can reach, and what it still needs. Pure, for the tests.
 * @param {{ faction: string, needs: any[] }[]} candidates
 * @param {InvitePlayer} player
 * @returns {{ faction: string | null, missing: string[], city: string | null, karma: number | null, kills: number | null, gym: number, blocked: { faction: string, why: string }[] }}
 */
export function pickInvite(candidates, player) {
	const blocked = [];
	for (const { faction, needs } of candidates) {
		const result = inviteNeeds(needs, player);
		if (result.blocked.length > 0) {
			blocked.push({ faction, why: result.blocked.join(", ") });
			continue;
		}
		return { faction, missing: result.missing, city: result.city, karma: result.karma, kills: result.kills, gym: result.gym, blocked };
	}
	return { faction: null, missing: [], city: null, karma: null, kills: null, gym: 0, blocked };
}

/**
 * What an invite's requirements (getFactionInviteRequirements) still need from this player. `blocked` lists needs the scripts
 * don't work on (other skills, a job to quit, files, backdoors...); karma and kills come from crimes, combat from the gym, a city
 * from a flight, money from waiting.
 * @param {any[]} needs
 * @param {InvitePlayer} player
 * @returns {Needs}
 */
export function inviteNeeds(needs, player) {
	/** @type {Needs} */
	const out = { missing: [], blocked: [], city: null, karma: null, kills: null, gym: 0 };
	for (const need of needs ?? []) addNeed(out, need, player);
	return out;
}

/** True when one requirement is met now. Unknown kinds count as not met. */
function met(need, player) {
	const probe = { missing: [], blocked: [], city: null, karma: null, kills: null, gym: 0 };
	addNeed(probe, need, player);
	return probe.missing.length === 0 && probe.blocked.length === 0;
}

function addNeed(out, need, player) {
	switch (need?.type) {
		case "money":
			if (player.money < need.money) out.missing.push(`$${Math.round(need.money / 1e6)}m`);
			return;
		case "skills":
			for (const [skill, level] of Object.entries(need.skills ?? {})) {
				const have = Math.floor(player.skills?.[skill] ?? 0);
				if (have >= level) continue;
				if (COMBAT_SKILLS.includes(skill)) {
					out.gym = Math.max(out.gym, level);
					out.missing.push(`${skill} ${have} / ${level}`);
				} else out.blocked.push(`${skill} ${have} / ${level}`);
			}
			return;
		case "karma":
			if (player.karma > need.karma) {
				out.karma = Math.min(out.karma ?? 0, need.karma);
				out.missing.push(`karma ${Math.round(player.karma)} / ${need.karma}`);
			}
			return;
		case "numPeopleKilled":
			if (player.numPeopleKilled < need.numPeopleKilled) {
				out.kills = Math.max(out.kills ?? 0, need.numPeopleKilled);
				out.missing.push(`kills ${player.numPeopleKilled} / ${need.numPeopleKilled}`);
			}
			return;
		case "city":
			if (player.city !== need.city) {
				out.city = need.city;
				out.missing.push(`be in ${need.city}`);
			}
			return;
		case "employedBy":
			if (!(need.company in (player.jobs ?? {}))) out.blocked.push(`a job at ${need.company}`);
			return;
		case "not":
			if (met(need.condition, player)) out.blocked.push(`not ${describe(need.condition)}`);
			return;
		case "everyCondition":
			for (const inner of need.conditions ?? []) addNeed(out, inner, player);
			return;
		case "someCondition": {
			const inner = need.conditions ?? [];
			if (inner.some((condition) => met(condition, player))) return;
			// Only "be in one of these cities" is worked on: fly to the first
			const flight = inner.find((condition) => condition?.type === "city");
			if (flight) addNeed(out, flight, player);
			else out.blocked.push(`one of ${inner.map(describe).join(" / ")}`);
			return;
		}
		default:
			out.blocked.push(describe(need));
	}
}

function describe(need) {
	if (need?.type === "employedBy") return `employed by ${need.company}`;
	if (need?.type === "city") return `in ${need.city}`;
	return `"${need?.type ?? "?"}"`;
}

/** The crimes to choose from: the config's list (names the game doesn't know are skipped), or every crime. */
function crimeList(ns, crimes) {
	const known = Object.values(ns.enums.CrimeType);
	if (!Array.isArray(crimes) || crimes.length === 0) return known;
	const list = crimes.filter((name) => known.includes(name));
	return list.length ? list : known;
}

/** The crime with the most expected karma (or kills) per minute at its current chance (Homicide, with v3.0.0's numbers). */
function bestCrime(ns, crimes, gain) {
	let best = null;
	for (const name of crimes) {
		const stats = ns.singularity.getCrimeStats(name);
		const chance = ns.singularity.getCrimeChance(name);
		const rate = gain === "karma"
			? (chance + FAIL_SHARE * (1 - chance)) * stats.karma / (stats.time / 60_000)
			: chance * stats.kills / (stats.time / 60_000);
		if (!best || rate > best.rate) best = { name, chance, rate };
	}
	return best && best.rate > 0 ? best : null;
}
