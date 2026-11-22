// Design: docs/challenges.md
// @ts-check
import { CHALLENGES } from "/config.js";
import { USER_CONFIG_FILE, CHALLENGE_STATE_FILE } from "/utils/config.js";
import { notify } from "/utils/notify.js";

/**
 * Which challenges apply to which run. A challenge is about one run of one BitNode (the game checks it when that BitNode is destroyed),
 * and setting it in the middle of a run can't earn it if the run has already broken it, so a challenge named in `challenges` applies
 * from the start of the NEXT run (the next time startup.js sees a new BitNode run), not at once. That lets a player set it for the run
 * after the one they are in without being there when it starts. `challenge <name> --now` is for a run that is still clean.
 *
 * data/challenge-state.json, written by startup.js at the start of each run: { run, node, active }
 *   run     the run's id (getResetInfo().lastNodeReset)
 *   node    its BitNode
 *   active  the challenges that apply in this run: those named in `challenges` when it started, plus any `--now`
 * loadConfig (utils/config.js) lays only the names in `active` over the config. No file (a save from before this existed) = all of them.
 */

/**
 * What startup.js does at a start: on a new run, retires the challenges of the run that ended and makes the rest active; inside the
 * same run nothing changes. A challenge that was active in the run that ended and is marked `retire` (CHALLENGES) is over, won or lost:
 * leaving it on would silently keep blocking the mechanic in the next run. A challenge named while that run was going (not active in
 * it) is kept and becomes active now. Pure, 0GB.
 * @param {{ run: number, node: number, active?: string[] } | null} state the saved state
 * @param {number} run the run now (getResetInfo().lastNodeReset) @param {number} node the BitNode now
 * @param {string[]} names the challenges named in data/config.json
 * @param {Record<string, { retire?: boolean, nodes?: number[], [key: string]: any }>} [challenges]
 * @returns {{ state: { run: number, node: number, active: string[] }, retired: string[], names: string[], changed: boolean }}
 */
export function rollChallenges(state, run, node, names, challenges = CHALLENGES) {
	if (state && state.run === run) {
		return { state: { run, node: state.node, active: state.active ?? [] }, retired: [], names, changed: false };
	}
	const retired = state ? (state.active ?? []).filter((name) => names.includes(name) && challenges[name]?.retire && challenges[name].nodes?.includes(state.node)) : [];
	const remaining = names.filter((name) => !retired.includes(name));
	return { state: { run, node, active: remaining }, retired, names: remaining, changed: true };
}

/**
 * The state with these challenges made active in the run now (`challenge <name> --now`). @param {any} state @param {string[]} names
 */
export function armNow(state, names) {
	return state ? { ...state, active: [...new Set([...(state.active ?? []), ...names])] } : state;
}

/** The state with these challenges not active any more (named again, or cleared). @param {any} state @param {string[]} names */
export function disarm(state, names) {
	return state ? { ...state, active: (state.active ?? []).filter((name) => !names.includes(name)) } : state;
}

/**
 * startup.js calls this once per start, before it records the BitNode: rolls the state over to this run, takes retired challenges out of
 * data/config.json and says so. Leaves a data/config.json that isn't valid JSON alone. 0GB (file reads and writes only).
 * @param {NS} ns @param {number} run @param {number} node
 * @returns {string[]} the challenges taken out
 */
export function retireChallenges(ns, run, node) {
	if (!Number.isFinite(run) || !Number.isFinite(node)) return []; // no run id to tell runs apart: leave everything as it is
	let mine;
	try {
		const text = ns.read(USER_CONFIG_FILE).trim();
		mine = text ? JSON.parse(text) : {};
	} catch {
		return [];
	}
	let state = null;
	try { state = JSON.parse(ns.read(CHALLENGE_STATE_FILE)); } catch { /* none yet: a save from before this existed */ }
	const names = [mine.challenges ?? []].flat();
	const rolled = rollChallenges(state, run, node, names);
	if (!rolled.changed) return [];
	ns.write(CHALLENGE_STATE_FILE, JSON.stringify(rolled.state), "w");
	if (rolled.retired.length === 0) return [];
	mine.challenges = rolled.names;
	ns.write(USER_CONFIG_FILE, JSON.stringify(mine, null, 2), "w");
	notify(ns, "[challenge]", `The BitNode run that ended is over, so ${rolled.retired.map((name) => `"${CHALLENGES[name].achievement}"`).join(", ")} is done (check your achievements) and ` +
		`${rolled.retired.join(", ")} is switched off. To try again: run /tools/set-config.js challenge ${rolled.retired.join(" ")} (applies from the next run)`, "info", true);
	return rolled.retired;
}
