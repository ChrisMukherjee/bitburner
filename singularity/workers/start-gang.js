// Design: docs/player-work.md
import { notify } from "/utils/notify.js";
import { GYM_STATS, GYMS, GYM_CASH_SECONDS } from "/utils/gyms.js";

const COMBAT = GYM_STATS.map(([skill]) => skill);
// Homicide gives the most expected karma per minute at any success chance (a failure still gives a quarter;
// v3.0.0 src/Work/CrimeWork.ts), the same pick gang/workers/invite.js makes. Hardcoded: its crime stats cost 5GB.
const KARMA_CRIME = "Homicide";
const NEXT = "/singularity/workers/start-crime.js";

/**
 * The gang invite for player-work-start.js, so the gang can start as early as the invite allows: below a 64GB
 * home player-work.js fits nowhere. Handed over to with ns.spawn. Args: gang faction, focus.
 *   1. karma missing: Homicide, committed by start-crime.js (the invite's karma, combat exp on the side);
 *   2. then combat stats missing: the gym of this city (a class keeps running between passes);
 *   3. otherwise (only money missing, no gym in this city, the invite on its way): the crime for cash.
 * join-factions.js accepts the invite and gang/gang-manager.js creates the gang. A stand-in for the start stage
 * only; singularity/player-work.js does the same from the early stage on.
 *   run /singularity/workers/start-gang.js "Slum Snakes" true
 */
/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	const faction = String(ns.args[0]);
	const focus = ns.args[1] !== false;
	const player = ns.getPlayer();
	const current = ns.singularity.getCurrentWork();

	let needKarma = false;
	const low = []; // [combat skill, level the invite needs] for those below it
	for (const need of ns.singularity.getFactionInviteRequirements(faction)) {
		if (need.type === "karma" && player.karma > need.karma) needKarma = true;
		if (need.type !== "skills") continue;
		for (const [skill, level] of Object.entries(need.skills)) {
			if (COMBAT.includes(skill) && player.skills[skill] < level) low.push([skill, level]);
		}
	}

	const gyms = GYMS[player.city];
	if (!needKarma && low.length > 0 && gyms) {
		const [skill, level] = low.sort((first, second) => player.skills[first[0]] - player.skills[second[0]])[0];
		const [, type, className] = GYM_STATS.find(([name]) => name === skill);
		const running = String(current?.classType ?? "").toUpperCase();
		if (current?.type === "CLASS" && (running === className || running === type.toUpperCase())) return;
		const [gym] = gyms.find(([, cost]) => player.money >= cost * GYM_CASH_SECONDS) ?? gyms[gyms.length - 1];
		if (ns.singularity.gymWorkout(gym, type, focus)) {
			notify(ns, "[start-work]", `training ${skill} at ${gym} for the ${faction} invite (${Math.floor(player.skills[skill])} / ${level})`, "info");
			return;
		}
	}
	// Karma missing: start-crime.js commits Homicide (the 5GB crime call stays there). Otherwise no gym in this
	// city (player-work.js flies to one from the early stage on) or only money missing: the crime for cash.
	ns.scp(NEXT, ns.getHostname(), "home");
	ns.spawn(NEXT, { spawnDelay: 0 }, focus, ...(needKarma ? [KARMA_CRIME] : []));
}
