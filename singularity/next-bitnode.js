import { blackOpsDone } from "/bladeburner/state.js";
import { nukeAllServers } from "/utils/nuke-all.js";

const DAEMON = "w0r1d_d43m0n";
const AFTER = "startup.js"; // runs on the fresh 8GB home in the next BitNode
const WORKER = "singularity/workers/destroy-daemon.js"; // holds the 32GB destroy call

/**
 * Destroys w0r1d_d43m0n and goes straight into the BitNode you name, skipping the BitVerse
 * screen, then runs startup.js there, so the next run starts with nobody at the keyboard.
 * THIS ENDS THE CURRENT BITNODE. It only runs when you start it, with a number.
 *
 *   run singularity/next-bitnode.js 4    finish this BitNode, start BitNode 4 again
 *   run singularity/next-bitnode.js 5    finish it and go to BitNode 5
 *
 * If anything is missing it prints "NOT ready"/"NOT proceeding" and the missing piece, and does nothing else:
 * the BitNode is not ended and the next one is not set. Only the "PROCEEDING" lines mean it went ahead.
 * Needs The Red Pill installed and your hacking level at w0r1d_d43m0n's requirement.
 * This file only checks and is small (about 3GB). The destroy call itself (32GB in BitNode 4 or with
 * SF4.3, 16x at SF4.1) is in workers/destroy-daemon.js, which this hands over to as its last step, so
 * a missing Red Pill or too little hacking is reported even when home is too small for the destroy.
 */
/** @param {NS} ns */
export async function main(ns) {
	const nextBN = Number(ns.args[0]);
	if (!Number.isInteger(nextBN) || nextBN < 1) {
		ns.tprint("NOT proceeding: no BitNode number given. Usage: run /singularity/next-bitnode.js <BitNode number>, e.g. 4");
		return;
	}
	if (!ns.fileExists(AFTER, "home")) {
		ns.tprint(`NOT proceeding, still in this BitNode: ${AFTER} isn't on home, and the next BitNode would start with nothing to run.`);
		return;
	}
	if (blackOpsDone(ns)) {
		ns.tprint(`Every Black Op is done: PROCEEDING, ending this BitNode without hacking ${DAEMON}.`);
		destroy(ns, nextBN);
		return;
	}
	if (!ns.serverExists(DAEMON)) {
		ns.tprint(`NOT ready, still in this BitNode, BitNode ${nextBN} NOT set: ${DAEMON} doesn't exist yet. Missing: The Red Pill installed.`);
		return;
	}
	const needed = ns.getServerRequiredHackingLevel(DAEMON);
	if (ns.getHackingLevel() < needed) {
		ns.tprint(`NOT ready, still in this BitNode, BitNode ${nextBN} NOT set: hacking level ${ns.getHackingLevel()} of ${needed} needed for ${DAEMON}. Missing: ${needed - ns.getHackingLevel()} more hacking levels.`);
		return;
	}
	nukeAllServers(ns); // root it if the batcher hasn't yet
	if (!ns.hasRootAccess(DAEMON)) {
		ns.tprint(`NOT ready, still in this BitNode, BitNode ${nextBN} NOT set: no root on ${DAEMON}. Missing: 5 open ports (the port-opening programs).`);
		return;
	}
	ns.tprint(`All checks passed: PROCEEDING. Destroying ${DAEMON}, next stop BitNode ${nextBN}...`);
	destroy(ns, nextBN);
}

/** Hands over to the worker: spawn ends this script first, so its few GB are free for the worker. */
function destroy(ns, nextBN) {
	const need = ns.getScriptRam(WORKER);
	if (ns.getServerMaxRam("home") < need) {
		ns.tprint(`NOT proceeding, still in this BitNode, BitNode ${nextBN} NOT set: home has ${ns.format.ram(ns.getServerMaxRam("home"))} but destroying ${DAEMON} needs ${ns.format.ram(need)}. Missing: home RAM upgrade.`);
		return;
	}
	ns.spawn(WORKER, { threads: 1, spawnDelay: 0 }, nextBN, AFTER);
}
