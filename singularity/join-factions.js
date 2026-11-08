// @ts-check
import { loadConfig } from "/utils/config.js";
import { notify } from "/utils/notify.js";
// City factions lock you out of their rivals, so they are only joined when that costs nothing (see below).
const CITY_FACTIONS = new Set(["Sector-12", "Aevum", "Volhaven", "Chongqing", "New Tokyo", "Ishima"]);
// Port singularity/player-work.js posts its city plan on (from singularity/workers/city-plan.js).
const CITY_PLAN_PORT = 25;
const LOOP_MS = 30_000;

/**
 * Accepts faction invitations as they arrive (CyberSec, NiteSec, The Black Hand and
 * BitRunners come from auto-backdoor.js). Every faction except the city ones has no
 * rivals, so joining costs nothing.
 *
 * A city invite is accepted only when it can't lock out a city faction you still want:
 *   - you're already in a city faction of the same rival group (`cities.groups` in the config),
 *     so joining adds no new rivals, or
 *   - the city plan (port 25) says no city sells anything you still want, so the favor is free.
 * Otherwise singularity/player-work.js picks and joins the right ones.
 *
 * Flags:
 *   --once    one check, then exit
 *   --cities  join every city faction invite, even ones that lock out a wanted group.
 */
/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	const flags = ns.flags([["once", false], ["cities", false]]);
	const groups = loadConfig(ns).cities.groups;

	while (true) {
		for (const faction of ns.singularity.checkFactionInvitations()) {
			if (CITY_FACTIONS.has(faction) && !flags.cities && !cityInviteIsFree(ns, faction, groups)) continue;
			if (ns.singularity.joinFaction(faction)) {
				notify(ns, "[factions]", `joined ${faction}`, "success");
			}
		}
		if (flags.once) return;
		await ns.sleep(LOOP_MS);
	}
}

/** True if joining this city faction can't lock out a city faction that sells something still wanted. */
function cityInviteIsFree(ns, faction, groups) {
	const joined = ns.getPlayer().factions;
	const group = groups.find((factions) => factions.includes(faction));
	if (group?.some((other) => joined.includes(other))) return true;
	try {
		const plan = JSON.parse(ns.peek(CITY_PLAN_PORT));
		return plan.groups.every((entry) => Object.values(entry.needs).every((augs) => augs.length === 0));
	} catch {
		return false; // no plan posted yet: don't guess
	}
}
