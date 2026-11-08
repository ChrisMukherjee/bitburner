// Design: docs/bitnode-mults.md
import { postGate } from "/singularity/ready.js";
import { BITNODE_FILE } from "/utils/config.js";
import { MULTS_FILE } from "/utils/bitnode-mults.js";
import { MULTS_GATE } from "/utils/sf5.js";

/**
 * One-shot: saves ns.getBitNodeMultipliers() to data/bitnode-mults.json on home for utils/bitnode-mults.js, which the
 * other scripts read at 0GB. startup.js runs it once per run when the game allows it (BitNode 5 or Source-File 5).
 * Without that access the call throws; it says so, posts "done" and leaves no file, so every multiplier reads as 1.
 */
/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	let mults = null;
	try {
		mults = ns.getBitNodeMultipliers();
	} catch (error) {
		ns.print(`[bitnode-mults] not available (needs BitNode 5 or Source-File 5): ${error}`);
	}
	const node = parseInt(ns.read(BITNODE_FILE), 10);
	if (mults && !Number.isFinite(node)) return; // startup.js writes the BitNode first; the next pass will do
	postGate(ns, MULTS_GATE, { done: true });
	if (!mults) return;
	ns.write(MULTS_FILE, JSON.stringify({ node, time: Date.now(), mults }), "w");
	// Placed off home by startup.js? The readers run on home.
	if (ns.getHostname() !== "home") ns.scp(MULTS_FILE, "home", ns.getHostname());
}
