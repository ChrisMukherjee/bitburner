import { notify } from "/utils/notify.js";
// Port workers/faction-goals.js writes to (not imported: the static RAM check would charge its
// Singularity calls to this script too).
const GOALS_PORT = 23;

// Factions in the order to work for them. The rep goal of each is no longer fixed: it's the
// highest rep requirement among the augments still worth buying there (not owned or already
// bought, with the BitNode's rep-cost multiplier), worked out by workers/faction-goals.js.
// "Worth it" is the buy-augs.js filter. An augment sold by several factions counts for the
// first joined one here, e.g. DataJack goes to The Black Hand, not NiteSec.
const CITY_FACTIONS = ["Sector-12", "Aevum", "Chongqing", "New Tokyo", "Ishima", "Volhaven"];
const FACTIONS = [
	"Daedalus",            // The Red Pill: needed to finish the BitNode
	"CyberSec",
	"Netburners",
	"Tian Di Hui",         // Neuroreceptor Manager (no unfocused penalty)
	"NiteSec",
	"The Black Hand",
	"BitRunners",
	// Megacorps: invites need company rep from a job there (400k, 300k with the backdoor).
	"Bachman & Associates",
	"Clarke Incorporated",
	"Blade Industries",
	"OmniTek Incorporated",
	"NWO",
	"ECorp",
	"Fulcrum Secret Technologies",
	// City factions last, and only once joined (join-factions.js decides which, since some
	// cities rule each other out). Most of their augments aren't worth it; the goal logic skips those.
	...CITY_FACTIONS,
];

const CONFIG = {
	minHackLevel: 75,          // below this, leave the player studying (study.js)
	loopMs: 60_000,
	refreshMs: 10 * 60_000,    // re-read the goals this often (catches augments bought meanwhile)
	helper: "workers/faction-goals.js",
};

/**
 * Keeps the player doing hacking contracts for the first joined faction still below its
 * rep goal. Doesn't touch work while hacking is below minHackLevel, so study.js can run
 * first. Exits once every faction with something left to buy is joined and at its goal.
 *
 * The goals come from workers/faction-goals.js (about 22GB for a moment, on home or else on
 * this server), run at the start, whenever you join a faction, when a faction reaches its
 * goal, and every 10 minutes. This script stays about 10GB. Until the helper has had room
 * to run once, it does no faction work and logs why.
 *
 *   run singularity/faction-work.js           unfocused (80% speed, you keep the screen)
 *   run singularity/faction-work.js --focus   focused (full speed, takes over the screen)
 */
/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	const flags = ns.flags([["focus", false]]);
	let lastMessage = "";
	let goals = null;
	let goalsAt = 0;
	let goalsFor = "";       // joined factions when the goals were worked out
	let lastGoalFaction = "";

	while (true) {
		const player = ns.getPlayer();
		const joined = new Set(player.factions);
		const joinedKey = FACTIONS.filter((faction) => joined.has(faction)).join("|");
		const reached = lastGoalFaction && goals && ns.singularity.getFactionRep(lastGoalFaction) >= goals[lastGoalFaction].rep;
		if (!goals || joinedKey !== goalsFor || reached || Date.now() - goalsAt >= CONFIG.refreshMs) {
			const fresh = await refreshGoals(ns);
			if (fresh) {
				goals = fresh;
				goalsAt = Date.now();
				goalsFor = joinedKey;
			}
		}

		let message;
		let goalFaction = "";
		if (!goals) {
			message = `[faction-work] no room yet for ${CONFIG.helper} (${ns.format.ram(ns.getScriptRam(CONFIG.helper))}), so no rep goals; retrying`;
		} else {
			// A city faction we haven't joined isn't waited for (its invite may never come).
			const open = FACTIONS.filter((faction) => goals[faction].rep > 0 &&
				(joined.has(faction) ? ns.singularity.getFactionRep(faction) < goals[faction].rep : !CITY_FACTIONS.includes(faction)));
			if (open.length === 0) {
				notify(ns, "[faction-work]", "every faction has the rep for all its augments worth buying, done.", "success");
				return;
			}
			goalFaction = open.find((faction) => joined.has(faction)) ?? "";
			if (player.skills.hacking < CONFIG.minHackLevel) {
				message = `[faction-work] hacking ${player.skills.hacking} < ${CONFIG.minHackLevel}, leaving study alone`;
			} else if (!goalFaction) {
				message = `[faction-work] no joined faction below its goal; waiting for invites (${open.join(", ")})`;
			} else {
				const current = ns.singularity.getCurrentWork();
				const already = current?.type === "FACTION" && current.factionName === goalFaction;
				if (!already && ns.singularity.workForFaction(goalFaction, "hacking", flags.focus)) {
					notify(ns, "[faction-work]", `hacking contracts for ${goalFaction}`, "info");
				}
				const goal = goals[goalFaction];
				const rep = ns.singularity.getFactionRep(goalFaction);
				message = `[faction-work] ${goalFaction}: ${ns.format.number(rep)} / ${ns.format.number(goal.rep)} rep (for ${goal.aug}, ${goal.count} augment(s) left there)`;
			}
		}
		if (message !== lastMessage) ns.print(message);
		lastMessage = message;

		// Moving off a faction because its goal was reached: stop its work so we don't keep grinding it.
		if (!goalFaction && lastGoalFaction) {
			const current = ns.singularity.getCurrentWork();
			if (current?.type === "FACTION" && current.factionName === lastGoalFaction) ns.singularity.stopAction();
		}
		lastGoalFaction = goalFaction;

		await ns.sleep(CONFIG.loopMs);
	}
}

/** Runs the helper (home first, else this server) and returns its goals, or null if it couldn't run. */
async function refreshGoals(ns) {
	const askedAt = Date.now();
	let pid = ns.exec(CONFIG.helper, "home", 1, ...FACTIONS);
	if (pid === 0 && ns.getHostname() !== "home") {
		ns.scp(CONFIG.helper, ns.getHostname(), "home");
		pid = ns.exec(CONFIG.helper, ns.getHostname(), 1, ...FACTIONS);
	}
	if (pid === 0) return null;
	while (ns.isRunning(pid)) await ns.sleep(100);
	try {
		const result = JSON.parse(ns.peek(GOALS_PORT));
		return result.time >= askedAt ? result.goals : null;
	} catch {
		return null;
	}
}
