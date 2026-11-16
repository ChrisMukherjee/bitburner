// Design: docs/grafting.md
// @ts-check
/**
 * What this run can do with grafting. The one place that knows the rule: the Grafting API works in BitNode 10 and anywhere
 * once you own Source-File 10 (it needs the Singularity API too, which the callers check). Costs nothing: the caller
 * passes ns.getResetInfo(). Also the graft player-work.js reports in progress (port 35), which the reset rule waits for.
 */

/** Whether the Grafting API works by BitNode and Source-Files alone, from a getResetInfo() result. Pure, 0GB. @param {{ currentNode: number, ownedSF: Map<number, number> }} info */
export function graftingApiFromInfo(info) {
	return info.currentNode === 10 || info.ownedSF.has(10);
}

/** singularity/player-work.js keeps its state between passes on this port; its `grafting` field is the graft it saw running. */
export const PLAYER_WORK_STATE_PORT = 35;
/** player-work.js posts once a minute, so an older note no longer says what the player is doing. */
export const GRAFT_NOTE_MAX_AGE_MS = 5 * 60_000;

/**
 * The note player-work.js keeps while a graft runs: the augmentation, when it was seen, and the end time and price when
 * player-work started it (null for a graft started by hand). Pure.
 * @param {string} aug
 * @param {{ name: string, at: number, hours?: number, cost?: number } | null | undefined} started player-work's last graft start (graftTry)
 * @param {number} now
 * @returns {{ aug: string, seenAt: number, endsAt: number | null, cost: number | null }}
 */
export function graftNote(aug, started, now) {
	const ours = started?.name === aug && Number.isFinite(started?.hours);
	return { aug, seenAt: now, endsAt: ours ? started.at + Number(started.hours) * 3.6e6 : null, cost: ours && Number.isFinite(started?.cost) ? Number(started.cost) : null };
}

/**
 * The graft in progress according to player-work's latest note, or null (none, or the note is too old to trust). Pure.
 * @param {any} note the `grafting` field of player-work's port-35 state
 * @param {number} now
 * @returns {{ aug: string, seenAt: number, endsAt: number | null, cost: number | null } | null}
 */
export function graftInProgress(note, now, maxAgeMs = GRAFT_NOTE_MAX_AGE_MS) {
	if (!note || typeof note.aug !== "string" || typeof note.seenAt !== "number" || now - note.seenAt > maxAgeMs) return null;
	return note;
}

/**
 * The graft in progress, read from player-work's state on port 35 (0GB: a port peek), or null. An install cancels a graft and the
 * game keeps its price, so the reset rule (singularity/buy-augs.js) waits for it.
 */
export function readGraftInProgress(ns, now = Date.now()) {
	try {
		return graftInProgress(JSON.parse(ns.peek(PLAYER_WORK_STATE_PORT))?.grafting, now);
	} catch {
		return null; // "NULL PORT DATA"
	}
}
