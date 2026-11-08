// Design: docs/bladeburner.md
// @ts-check
// What the Bladeburner scripts share, on port 36 (ports work on every server, so the one-shots can run
// anywhere). One JSON object; each script patches its own part with postBladeburner:
//   state, stateTime   bb-manage.js: "off", "boot", "train", "run" or "hold" (see docs/bladeburner.md)
//   plan               the route estimate (route "combat"|"hacking", hold, time; trainTarget is read but nobody writes it yet), written by node-eta.js
//   eta                node-eta.js: its hacking exp samples of this run
//   rank, actions      bb-pass.js: rank samples of the last hour, and the live action readings the estimate uses
//   action             bb-pass.js: { type, name, time } of the running action (null when none), shown on status' "Doing:" line
//   blackOps         bb-pass.js: { done, time }, done when getNextBlackOp() found none (auto-destroy.js ends the BitNode)
//   time, title, script, oneShot, lines   the status line tools/status.js shows
// 0GB (ports only). The one-shots run one at a time (startup.js), so read-modify-write is safe.
export const BB_PORT = 36;
// A state older than this counts as "off", so a stopped manager can't keep the player held for ever.
const STATE_MAX_AGE_MS = 15 * 60_000;

/** The shared object, or {} when nothing is posted. */
export function readBladeburner(ns) {
	try {
		const post = JSON.parse(ns.peek(BB_PORT));
		return post && typeof post === "object" ? post : {};
	} catch {
		return {};
	}
}

/** Merges `patch` into the shared object (undefined values keep what is there). */
export function postBladeburner(ns, patch) {
	const post = { ...readBladeburner(ns), time: Date.now(), title: "Bladeburner", oneShot: true };
	for (const [key, value] of Object.entries(patch)) if (value !== undefined) post[key] = value;
	ns.clearPort(BB_PORT);
	ns.writePort(BB_PORT, JSON.stringify(post));
	return post;
}

/** "boot", "train", "run" or "hold" while bb-manage.js keeps posting it; "off" otherwise. */
export function bladeburnerState(ns) {
	const post = readBladeburner(ns);
	return post.state && Date.now() - (post.stateTime ?? 0) < STATE_MAX_AGE_MS ? post.state : "off";
}

/** The route estimate, or null when none is posted or it is older than 30 minutes. */
export function bladeburnerPlan(ns) {
	const plan = readBladeburner(ns).plan;
	return plan && Date.now() - (plan.time ?? 0) < 30 * 60_000 ? plan : null;
}

/** The combat stats must reach this before Bladeburner can be joined (and be played well). */
export const COMBAT_FLOOR = 100;

/** The level the gym trains every combat stat to: the join floor, or more when the route estimate asks for it. */
export function trainFloor(ns) {
	return Math.max(COMBAT_FLOOR, Number(bladeburnerPlan(ns)?.trainTarget) || 0);
}

/** True when bb-pass.js saw every Black Op done within the last hour (the BitNode can end without hacking w0r1d_d43m0n). */
export function blackOpsDone(ns) {
	const ops = readBladeburner(ns).blackOps;
	return !!ops?.done && Date.now() - (ops.time ?? 0) < 3600_000;
}
