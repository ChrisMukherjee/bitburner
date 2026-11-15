// Design: docs/route-focus.md
// @ts-check
// What the way out of the BitNode needs most right now, so the scripts that share the player, the sleeves and the spare RAM
// agree on it instead of each pursuing its own goal. Pure functions on plain data plus the port helpers, all 0GB.
//
// Only the hacking route has a binding constraint this module can read from the game's own numbers: Daedalus' invite
// (getFactionInviteRequirements, posted by buy-augs.js in data/aug-plan.json), then The Red Pill's Daedalus rep, then
// w0r1d_d43m0n's hacking level. singularity/player-work.js works the phase out every pass and posts it on FOCUS_PORT;
// hack/xp-farm.js, share/share-manager.js and sleeves/sleeve-manager.js read it. Nothing posted (no Singularity API, kill
// switch `routeFocus.enabled: false`, a stale post) means "none": every consumer behaves as it did before.

/** Port the phase is posted on (see docs/NETSCRIPT.md). */
export const FOCUS_PORT = 44;
// A post older than this counts as "none", so a stopped player-work.js can't pin the other scripts to an old answer.
const MAX_AGE_MS = 10 * 60_000;

/**
 * @typedef {{ money: number, installed: number, skills: Record<string, number> }} Have
 * @typedef {{ phase: "none" | "level" | "rep" | "daemon", binding: boolean, skipSide: boolean, gap: number, reason: string }} Focus
 *   phase     none    no hacking route, or what it waits on isn't the player's time or exp
 *             level   Daedalus' invite only waits for hacking level (installed augs are there, cash is on its way)
 *             rep     Daedalus is joined: The Red Pill's rep is what is left
 *             daemon  The Red Pill is installed: only w0r1d_d43m0n's hacking level is left
 *   binding   true while hacking exp is what the route waits for (level, daemon): spare RAM goes to the XP farm, not to share
 *   skipSide  true while the route has a clear next step (any phase but none): the gang invite's crimes and gym, and the
 *             sleeves' combat training, would take time from it
 *   gap       hacking levels still missing (level, daemon), else 0
 */

/**
 * What an invite's requirements (getFactionInviteRequirements) still need from the player, walking `someCondition` (any one
 * alternative is enough: the closest unmet one counts) and `everyCondition` (all of them).
 * @param {any} need
 * @param {Have} have
 * @returns {{ ok: boolean, kinds: string[], gap: number }} kinds: "money", "augs", "hacking", "skills" (other stats), "other"
 */
export function inviteGaps(need, have) {
	if (Array.isArray(need)) return all(need.map((item) => inviteGaps(item, have)));
	switch (need?.type) {
		case "money": return have.money >= need.money ? met() : unmet("money");
		case "numAugmentations": return have.installed >= need.numAugmentations ? met() : unmet("augs");
		case "skills": {
			const short = Object.entries(need.skills ?? {}).filter(([skill, level]) => (have.skills[skill] ?? 0) < Number(level));
			if (short.length === 0) return met();
			if (short.length === 1 && short[0][0] === "hacking") return { ok: false, kinds: ["hacking"], gap: Number(short[0][1]) - (have.skills.hacking ?? 0) };
			return unmet("skills");
		}
		case "someCondition": {
			const options = (need.conditions ?? []).map((item) => inviteGaps(item, have));
			if (options.some((option) => option.ok)) return met();
			// The alternative this route can work on: the hacking one first (the combat stats are not trained on this route), then
			// the one with the fewest kinds missing
			const rank = (/** @type {{ kinds: string[] }} */ option) => (option.kinds.includes("hacking") ? 0 : 1);
			return options.sort((first, second) => rank(first) - rank(second) || first.kinds.length - second.kinds.length || first.gap - second.gap)[0] ?? unmet("other");
		}
		case "everyCondition": return all((need.conditions ?? []).map((item) => inviteGaps(item, have)));
		default: return unmet("other"); // city, employer, backdoor, karma...: not something this module can wait on
	}
}

const met = () => ({ ok: true, kinds: [], gap: 0 });
const unmet = (/** @type {string} */ kind) => ({ ok: false, kinds: [kind], gap: 0 });
/** @param {{ ok: boolean, kinds: string[], gap: number }[]} parts */
function all(parts) {
	return {
		ok: parts.every((part) => part.ok),
		kinds: [...new Set(parts.flatMap((part) => part.kinds))],
		gap: Math.max(0, ...parts.map((part) => part.gap)),
	};
}

/**
 * The phase of the hacking route, from plain data.
 * @param {{
 *   route: string | undefined, hacking: number, daemonLevel: number | null, daedalusJoined: boolean, redPillInstalled: boolean,
 *   invite: any[] | null, have: Have, enabled?: boolean
 * }} input  route: "hacking" or "combat" (route-estimate verdict, else the config route); invite: Daedalus' requirements
 *   while it isn't joined (data/aug-plan.json bitnode.daedalusInvite), null when unknown
 * @returns {Focus}
 */
export function routeFocus(input) {
	const none = (/** @type {string} */ reason) => ({ phase: /** @type {const} */ ("none"), binding: false, skipSide: false, gap: 0, reason });
	if (input.enabled === false) return none("routeFocus.enabled is false");
	if (input.route !== "hacking") return none("the route is not hacking");
	if (input.redPillInstalled) {
		const gap = input.daemonLevel === null ? 0 : input.daemonLevel - input.hacking;
		if (gap <= 0) return none("w0r1d_d43m0n's hacking level is reached");
		return { phase: "daemon", binding: true, skipSide: true, gap, reason: `hacking ${Math.floor(input.hacking)} / ${input.daemonLevel} for w0r1d_d43m0n` };
	}
	if (input.daedalusJoined) return { phase: "rep", binding: false, skipSide: true, gap: 0, reason: "Daedalus rep for The Red Pill" };
	if (!input.invite) return none("Daedalus' invite requirements are not known yet");
	const gaps = inviteGaps(input.invite, input.have);
	if (gaps.ok) return none("Daedalus' invite is met");
	// Installed augments missing means the reset rule's business (a push buys them); anything but cash and level is not ours either
	if (!gaps.kinds.includes("hacking") || gaps.kinds.some((kind) => !["hacking", "money"].includes(kind))) return none(`Daedalus' invite waits for ${gaps.kinds.join(", ")}`);
	return { phase: "level", binding: true, skipSide: true, gap: gaps.gap, reason: `hacking ${Math.floor(input.hacking)} / ${Math.floor(input.hacking + gaps.gap)} for Daedalus' invite` };
}

/** Posts the phase for the other scripts (port 44). */
export function postRouteFocus(ns, /** @type {Focus} */ focus) {
	ns.clearPort(FOCUS_PORT);
	ns.writePort(FOCUS_PORT, JSON.stringify({ ...focus, time: Date.now() }));
}

/** The posted phase, or null when none is posted or it is older than ten minutes. */
export function readRouteFocus(ns) {
	try {
		const posted = JSON.parse(ns.peek(FOCUS_PORT));
		return posted && typeof posted === "object" && Date.now() - (posted.time ?? 0) < MAX_AGE_MS ? posted : null;
	} catch {
		return null;
	}
}

/** True while hacking exp is what the route waits for (see Focus.binding). False when nothing is posted. */
export function hackingBinding(ns) {
	return readRouteFocus(ns)?.binding === true;
}

/** True while the route has a next step that side quests would delay (see Focus.skipSide). False when nothing is posted. */
export function skipSideQuests(ns) {
	return readRouteFocus(ns)?.skipSide === true;
}

/**
 * Who gets the RAM the batcher leaves free: share-manager.js (faction rep) or the XP farm (hacking exp). Share has it during faction
 * work, unless the route waits for hacking exp and the farm is running to use it. One rule for both scripts, so they never both
 * idle or both run.
 * @param {{ factionWork: boolean, shareRunning: boolean, farmRunning: boolean, binding: boolean }} state
 */
export function spareRamGoesToShare(state) {
	return state.factionWork && state.shareRunning && !(state.binding && state.farmRunning);
}

/**
 * Which open faction to work for next. `open` holds the joined factions still below their rep goal, in config order. Without
 * `byValue` the first is taken (the order is the cheap-first priority). With it (hacking exp is binding, so rep only matters for
 * the augments it buys), the faction whose picked augments are worth the most per second of missing rep goes first; ties and
 * factions with no value reading keep the config order.
 * @param {string[]} open
 * @param {Record<string, { rep: number, value?: number }>} goals
 * @param {(faction: string) => number} repOf
 * @param {boolean} byValue
 * @returns {string} "" when open is empty
 */
export function pickGoalFaction(open, goals, repOf, byValue) {
	if (open.length === 0) return "";
	if (!byValue || open.some((faction) => !(goals[faction]?.value >= 0))) return open[0];
	const density = (/** @type {string} */ faction) => (goals[faction].value ?? 0) / Math.max(1, goals[faction].rep - repOf(faction));
	return open.reduce((best, faction) => (density(faction) > density(best) ? faction : best));
}
