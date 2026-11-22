// @ts-check
import { bladeburnerAccess } from "/utils/bladeburner.js";
import { bladeburnerState } from "/bladeburner/state.js";

/** For startup.js: bb-manage.js has something to do when the Bladeburner API is usable and no challenge forbids the division. */
/** @param {NS} ns @param {{ forbid?: string[] } | null} [config] */
export function bladeburnerReady(ns, config = null) {
	return bladeburnerAccess(ns, config).available;
}

/** For startup.js: bb-pass.js plays only while bb-manage.js says the stats are ready ("run"). */
/** @param {NS} ns */
export function bladeburnerRunning(ns) {
	return bladeburnerState(ns) === "run";
}
