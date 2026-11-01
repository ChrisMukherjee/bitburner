import { nukeAllServers } from "/utils/nuke-all.js";

const DAEMON = "w0r1d_d43m0n";
const AFTER = "startup.js"; // runs on the fresh 8GB home in the next BitNode

/**
 * Destroys w0r1d_d43m0n and goes straight into the BitNode you name, skipping the BitVerse
 * screen, then runs startup.js there, so the next run starts with nobody at the keyboard.
 * THIS ENDS THE CURRENT BITNODE. It only runs when you start it, with a number.
 *
 *   run singularity/next-bitnode.js 4    finish this BitNode, start BitNode 4 again
 *   run singularity/next-bitnode.js 5    finish it and go to BitNode 5
 *
 * Needs The Red Pill installed and your hacking level at w0r1d_d43m0n's requirement.
 * About 34GB in BitNode 4 or with SF4.3 (destroyW0r1dD43m0n alone is 32GB there).
 */
/** @param {NS} ns */
export async function main(ns) {
	const nextBN = Number(ns.args[0]);
	if (!Number.isInteger(nextBN) || nextBN < 1) {
		ns.tprint("Usage: run singularity/next-bitnode.js <BitNode number>, e.g. 4");
		return;
	}
	if (!ns.fileExists(AFTER, "home")) {
		ns.tprint(`${AFTER} isn't on home; not leaving the BitNode without it.`);
		return;
	}
	if (!ns.serverExists(DAEMON)) {
		ns.tprint(`${DAEMON} doesn't exist yet: install The Red Pill first.`);
		return;
	}
	const needed = ns.getServerRequiredHackingLevel(DAEMON);
	if (ns.getHackingLevel() < needed) {
		ns.tprint(`Hacking ${ns.getHackingLevel()} of ${needed} needed for ${DAEMON}.`);
		return;
	}
	nukeAllServers(ns); // root it if the batcher hasn't yet
	if (!ns.hasRootAccess(DAEMON)) {
		ns.tprint(`No root on ${DAEMON} yet (it needs 5 open ports).`);
		return;
	}
	ns.tprint(`Destroying ${DAEMON}, next stop BitNode ${nextBN}...`);
	ns.singularity.destroyW0r1dD43m0n(nextBN, AFTER);
}
