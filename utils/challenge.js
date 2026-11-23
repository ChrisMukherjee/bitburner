// Design: docs/challenges.md
// @ts-check
import { CHALLENGES } from "/config.js";
import { USER_CONFIG_FILE, CHALLENGE_STATE_FILE } from "/utils/config.js";
import { notify } from "/utils/notify.js";

/**
 * Which challenges apply to which run. A challenge is about one run of one BitNode (the game checks it when that BitNode is destroyed),
 * and setting it in the middle of a run can't earn it if the run has already broken it, so a challenge named in `challenges` applies
 * from the start of the NEXT run, not at once. That lets a player set it for the run after the one they are in without being there
 * when it starts. `challenge <name> --now` is for a run that is still clean.
 *
 * data/challenge-state.json: { run, node, active, named }
 *   run     the run it was last rolled over to (getResetInfo().lastNodeReset), node its BitNode
 *   active  the challenges that apply in that run (loadConfig, utils/config.js, lays only these over the config)
 *   named   one record per named challenge: { run, now, again? }
 *             run    the run it was named in
 *             now    true: it applies in that run too (`--now`); false: only in the runs after it (queued)
 *             again  the run in which it was named again while it already applied: that attempt ends with the run, and the
 *                    challenge carries on into the next one instead of retiring
 * A challenge with no record (a save from before records existed, or one written into data/config.json by hand) is taken as named
 * now and queued: nothing tells which run it was meant for, and treating it as applying would retire it when this run ends, before
 * the run it was set for. `challenge <name> --now` applies it at once if this run is still clean.
 */

/**
 * @typedef {{ run: number, now: boolean, again?: number }} Named
 * @typedef {{ run: number, node: number, active: string[], named: Record<string, Named> }} ChallengeState
 * @typedef {Record<string, { retire?: boolean, nodes?: number[], [key: string]: any }>} ChallengeTable
 */

/** Whether a challenge with this record applies in this run. Pure. @param {Named | undefined} named @param {number} run */
export function appliesIn(named, run) {
	return !!named && (run > named.run || (named.now && run === named.run));
}

/**
 * The record of each named challenge, from the saved state. A state written before records existed ({ run, node, active }) still says
 * which names applied in its run and which were waiting; a name with no record at all is queued from `run` (see above). Pure.
 * @param {any} state the saved state, or null @param {string[]} names @param {number} run the run now
 * @returns {{ named: Record<string, Named>, adopted: string[] }} adopted: the names that had no record
 */
export function namedRecords(state, names, run) {
	/** @type {Record<string, Named>} */
	const named = {};
	const adopted = [];
	const oldFormat = state && !state.named && Number.isFinite(state.run) && Array.isArray(state.active);
	for (const name of names) {
		const saved = state?.named?.[name];
		if (saved && Number.isFinite(saved.run)) named[name] = { ...saved, now: !!saved.now };
		else if (oldFormat) named[name] = { run: state.run, now: state.active.includes(name) };
		else {
			named[name] = { run, now: false };
			adopted.push(name);
		}
	}
	return { named, adopted };
}

/**
 * What startup.js does at a start: on a new run, retires the challenges whose attempt was the run that ended and makes the queued ones
 * active; inside the same run only adds records for names it hadn't seen. A challenge marked `retire` (CHALLENGES) that applied in a run
 * of its own BitNode is over when that run ends, won or lost: leaving it on would silently keep blocking the mechanic in the next run.
 * One named during that run for the next one (queued, or named again while it applied) stays and applies now. Pure, 0GB.
 * @param {any} state the saved state, or null
 * @param {number} run the run now (getResetInfo().lastNodeReset) @param {number} node the BitNode now
 * @param {string[]} names the challenges named in data/config.json
 * @param {ChallengeTable} [challenges]
 * @returns {{ state: ChallengeState, retired: string[], adopted: string[], names: string[], changed: boolean }}
 */
export function rollChallenges(state, run, node, names, challenges = CHALLENGES) {
	const sameRun = !!state && state.run === run;
	const { named, adopted } = namedRecords(state, names, run); // a name with no record waits for the run after this one
	const retired = [];
	if (!sameRun && state && Number.isFinite(state.run)) {
		for (const name of names) {
			const record = named[name];
			const challenge = challenges[name];
			if (!challenge?.retire || !challenge.nodes?.includes(state.node) || !appliesIn(record, state.run)) continue;
			if (record.again === state.run) named[name] = { run: state.run, now: false }; // named again for the next run: that run is this one
			else retired.push(name);
		}
	}
	const kept = names.filter((name) => !retired.includes(name));
	/** @type {Record<string, Named>} */
	const records = {};
	for (const name of kept) {
		const { again, ...rest } = named[name];
		records[name] = !sameRun || again === undefined ? rest : { ...rest, again };
	}
	const next = { run, node: sameRun ? state.node : node, active: kept.filter((name) => appliesIn(records[name], run)), named: records };
	const changed = !sameRun || JSON.stringify(next) !== JSON.stringify({ run: state.run, node: state.node, active: state.active ?? [], named: state.named ?? {} });
	return { state: next, retired, adopted, names: kept, changed };
}

/**
 * The state after `challenge <names>` in run `run` (tools/set-config.js). Without `now` each name is for the next run: a new one waits,
 * and one that already applies keeps applying and is marked to carry on into the next run instead of retiring. With `now` it applies in
 * this run as well. Pure.
 * @param {ChallengeState} state the state rolled over to this run @param {string[]} names @param {boolean} now
 * @returns {{ state: ChallengeState, already: string[] }} already: the names that applied in this run before
 */
export function nameChallenges(state, names, now) {
	const run = state.run;
	const named = { ...state.named };
	const already = [];
	for (const name of names) {
		const record = named[name];
		if (appliesIn(record, run)) {
			already.push(name);
			if (!now) named[name] = { ...record, again: run };
		} else named[name] = { run, now: !!now };
	}
	return { state: { ...state, named, active: Object.keys(named).filter((name) => appliesIn(named[name], run)) }, already };
}

/** The state with these challenges gone (`challenge clear`): they stop applying at once. Pure. @param {any} state @param {string[]} names */
export function disarm(state, names) {
	if (!state) return state;
	const named = { ...(state.named ?? {}) };
	for (const name of names) delete named[name];
	return { ...state, active: (state.active ?? []).filter((name) => !names.includes(name)), named };
}

/** The saved state, or null. @param {NS} ns */
export function readChallengeState(ns) {
	try {
		const state = JSON.parse(ns.read(CHALLENGE_STATE_FILE));
		return state && typeof state === "object" ? state : null;
	} catch {
		return null;
	}
}

/**
 * startup.js calls this once per start, before it records the BitNode (tools/set-config.js too, before it changes anything): rolls the
 * state over to this run, takes retired challenges out of data/config.json and says so, and says when a named challenge had no record.
 * Leaves a data/config.json that isn't valid JSON alone. 0GB (file reads and writes only).
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
	const names = [mine.challenges ?? []].flat();
	const rolled = rollChallenges(readChallengeState(ns), run, node, names);
	if (!rolled.changed) return [];
	ns.write(CHALLENGE_STATE_FILE, JSON.stringify(rolled.state), "w");
	if (rolled.adopted.length) {
		notify(ns, "[challenge]", `${rolled.adopted.join(", ")} is named in ${USER_CONFIG_FILE} with no record of when it was set, so it waits for the next ` +
			`BitNode run. If this run is still clean for it: run /tools/set-config.js challenge ${rolled.adopted.join(" ")} --now`, "info", true);
	}
	if (rolled.retired.length === 0) return [];
	mine.challenges = rolled.names;
	ns.write(USER_CONFIG_FILE, JSON.stringify(mine, null, 2), "w");
	notify(ns, "[challenge]", `The BitNode run that ended is over, so ${rolled.retired.map((name) => `"${CHALLENGES[name].achievement}"`).join(", ")} is done (check your achievements) and ` +
		`${rolled.retired.join(", ")} is switched off. To try again: run /tools/set-config.js challenge ${rolled.retired.join(" ")} (applies from the next run)`, "info", true);
	return rolled.retired;
}
