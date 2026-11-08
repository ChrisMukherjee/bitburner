// Design: docs/bitnode-mults.md
// @ts-check
import { readGates } from "/singularity/ready.js";

export const MULTS_GATE = "bitnode-mults";

/**
 * Whether this run can read the BitNode multipliers: in BitNode 5, and anywhere once you own Source-File 5.
 * Costs getResetInfo (1GB). { available }
 */
/** @param {NS} ns */
export function bitnodeMultsAccess(ns) {
	const info = ns.getResetInfo();
	return { available: info.currentNode === 5 || info.ownedSF.has(5) };
}

/** A ready check for startup.js: the multipliers can be read and tools/save-bitnode-mults.js hasn't saved them this run. */
/** @param {NS} ns */
export function bitnodeMultsReady(ns) {
	return !readGates(ns)[MULTS_GATE]?.done && bitnodeMultsAccess(ns).available;
}
