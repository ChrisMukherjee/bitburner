// Design: docs/grafting.md
// @ts-check

/**
 * One-shot for singularity/player-work.js: starts grafting an augmentation (the player must be in New Tokyo).
 *   args: augmentation name, focus (true/false)
 * The game takes the money now and replaces the player's current work; player-work.js sees the work next pass.
 */
/** @param {NS} ns */
export async function main(ns) {
	ns.grafting.graftAugmentation(String(ns.args[0]), ns.args[1] !== false);
}
