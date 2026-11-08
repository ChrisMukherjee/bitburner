// @ts-check
import { gangAccess } from "/utils/gang.js";

/**
 * For startup.js: true when gang/gang-manager.js has something to do, so its ~33GB isn't held
 * while waiting. That is: a gang exists, or a faction from gang.factions (config) is joined and
 * a gang can be created (see utils/gang.js for the karma rule).
 */
/** @param {NS} ns */
export function gangReady(ns, config) {
	const access = gangAccess(ns);
	if (access.inGang) return true;
	if (!config.gang.factions.some((faction) => ns.getPlayer().factions.includes(faction))) return false;
	return access.canCreate;
}
