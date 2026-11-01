import { notify } from "/utils/notify.js";
// City factions lock you out of their rivals, so they are only joined with --cities.
const CITY_FACTIONS = new Set(["Sector-12", "Aevum", "Volhaven", "Chongqing", "New Tokyo", "Ishima"]);
const LOOP_MS = 30_000;

/**
 * Accepts faction invitations as they arrive (CyberSec, NiteSec, The Black Hand and
 * BitRunners come from auto-backdoor.js). Every faction except the city ones has no
 * rivals, so joining costs nothing.
 *
 * Flags:
 *   --once    one check, then exit
 *   --cities  also join every city faction invite (Sector-12, Aevum, ...), which blocks their rivals.
 *             Normally leave this off: singularity/city-factions.js joins the right ones in the right order.
 */
export async function main(ns) {
	ns.disableLog("ALL");
	const flags = ns.flags([["once", false], ["cities", false]]);

	while (true) {
		for (const faction of ns.singularity.checkFactionInvitations()) {
			if (CITY_FACTIONS.has(faction) && !flags.cities) continue;
			if (ns.singularity.joinFaction(faction)) {
				notify(ns, "[factions]", `joined ${faction}`, "success");
			}
		}
		if (flags.once) return;
		await ns.sleep(LOOP_MS);
	}
}
