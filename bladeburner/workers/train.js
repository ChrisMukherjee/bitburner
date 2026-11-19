// Design: docs/combat-training.md
// @ts-check
import { postBladeburner } from "/bladeburner/state.js";

/**
 * One-shot for singularity/player-work.js when Bladeburner's Training raises the combat stats faster than the gym or a crime
 * (utils/training.js), or runs beside the gym with The Blade's Simulacrum installed: starts General > Training unless it is
 * already running, and notes the time on port 36 (`training`) so bladeburner/bb-manage.js leaves the action running instead of
 * clearing it for the gym. Without the Simulacrum, starting it ends the player's current work (the game's rule).
 *   run /bladeburner/workers/train.js
 */
/** @param {NS} ns */
export async function main(ns) {
	const bb = ns.bladeburner;
	if (!bb.inBladeburner()) return;
	const now = bb.getCurrentAction();
	const running = now?.type === "General" && now.name === "Training";
	if (!running && !bb.startAction("General", "Training")) return;
	postBladeburner(ns, { training: { time: Date.now() } });
}
