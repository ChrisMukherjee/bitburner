// Design: docs/bitnode-mults.md
import { BITNODE_FILE } from "/utils/config.js";

// Written by tools/save-bitnode-mults.js (startup.js runs it once per run when the game allows it).
export const MULTS_FILE = "data/bitnode-mults.json";

/**
 * The BitNode multipliers for this run, read from MULTS_FILE. 0GB, so any script can use it.
 * getBitNodeMultipliers needs BitNode 5 or Source-File 5 and costs 4GB, so one one-shot reads it and
 * everything else reads the file. Without the file (no Source-File 5, not saved yet, or left over from
 * another BitNode) every multiplier is 1, which is what the scripts assumed before this existed.
 *
 *   const mults = bitnodeMults(ns);
 *   mults.get("HacknetNodeMoney")  // 1 when unknown
 *   mults.known                    // false: these are just the defaults
 *
 * The file is read from the server the script runs on; scripts placed off home read their own copy
 * (the writer copies it to home only), so use it from home scripts or copy it along.
 */
/** @param {NS} ns */
export function bitnodeMults(ns) {
	let values = {};
	let known = false;
	try {
		const saved = JSON.parse(ns.read(MULTS_FILE));
		const node = parseInt(ns.read(BITNODE_FILE), 10);
		// The file survives a BitNode change; only trust it for the BitNode it was written in.
		if (saved && saved.mults && typeof saved.mults === "object" && Number.isFinite(node) && saved.node === node) {
			values = saved.mults;
			known = true;
		}
	} catch { /* no file yet */ }
	return {
		known,
		/** One multiplier by name (e.g. "ServerMaxMoney"); 1 when unknown. */
		get(name) {
			const value = values[name];
			return typeof value === "number" && Number.isFinite(value) ? value : 1;
		},
	};
}
