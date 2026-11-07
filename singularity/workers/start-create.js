// Design: docs/player-work.md
import { notify } from "/utils/notify.js";

/**
 * Starts creating one program for player-work-start.js (which hands over with ns.spawn so it needn't
 * hold the 5GB createProgram call itself). Args: program file, estimated minutes, focus.
 * 6.6GB, for a moment.
 *   run /singularity/workers/start-create.js BruteSSH.exe 5 true
 */
/** @param {NS} ns */
export async function main(ns) {
	const [file, minutes, focus] = ns.args;
	if (ns.singularity.createProgram(file, focus !== false)) {
		notify(ns, "[start-work]", `creating ${file} (up to about ${minutes} min) instead of waiting for the cash`, "info");
	}
}
