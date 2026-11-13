// Design: docs/sleeves.md
// @ts-check
import { sleevesApiFromInfo } from "/utils/sleeves.js";

/**
 * For startup.js: the sleeve scripts have something to do when the Sleeve API works in this run (BitNode 10, or Source-File 10)
 * and `sleeves.enabled` is not switched off. In BitNode 10 with no sleeve yet they start too: the shop buys the first one.
 * Reads the getResetInfo startup.js already pays for.
 */
/** @param {NS} ns */
export function sleevesReady(ns, config) {
	return config.sleeves?.enabled !== false && sleevesApiFromInfo(ns.getResetInfo());
}
