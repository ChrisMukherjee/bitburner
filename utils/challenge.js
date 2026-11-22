// Design: docs/challenges.md
// @ts-check
import { CHALLENGES } from "/config.js";
import { USER_CONFIG_FILE } from "/utils/config.js";
import { notify } from "/utils/notify.js";

/**
 * The challenges to take out of `challenges` now that a BitNode has ended: the ones marked `retire` in CHALLENGES whose `nodes` include
 * the BitNode that was left. A challenge is about one run of one BitNode, and the game checks it only when that BitNode is destroyed, so
 * once it is left the attempt is over, won or lost; leaving it on would silently keep blocking the mechanic in the next run of that BitNode.
 * Pure, 0GB.
 * @param {string[]} names the challenges that are on
 * @param {number | null} previousNode the BitNode of the last run startup.js saw (data/bitnode.txt before it is overwritten)
 * @param {number | null} currentNode the BitNode now
 * @param {Record<string, { retire?: boolean, nodes?: number[] }>} [challenges]
 */
export function retiredChallenges(names, previousNode, currentNode, challenges = CHALLENGES) {
	if (!Number.isFinite(previousNode) || !Number.isFinite(currentNode) || previousNode === currentNode) return [];
	return names.filter((name) => challenges[name]?.retire && challenges[name].nodes?.includes(/** @type {number} */ (previousNode)));
}

/**
 * startup.js calls this once per new run, before it records the BitNode: takes the retired challenges out of data/config.json and says so.
 * Leaves the file alone when it isn't valid JSON. 0GB (file reads and writes only).
 * @param {NS} ns @param {number | null} previousNode @param {number} currentNode
 * @returns {string[]} the challenges taken out
 */
export function retireChallenges(ns, previousNode, currentNode) {
	let mine;
	try {
		const text = ns.read(USER_CONFIG_FILE).trim();
		mine = text ? JSON.parse(text) : {};
	} catch {
		return [];
	}
	const on = [mine.challenges ?? []].flat();
	const done = retiredChallenges(on, previousNode, currentNode);
	if (done.length === 0) return [];
	mine.challenges = on.filter((name) => !done.includes(name));
	ns.write(USER_CONFIG_FILE, JSON.stringify(mine, null, 2), "w");
	notify(ns, "[challenge]", `BitNode ${previousNode} has ended, so ${done.map((name) => `"${CHALLENGES[name].achievement}"`).join(", ")} is over (check your achievements) and ` +
		`${done.join(", ")} is switched off. To try again next time: run /tools/set-config.js challenge ${done.join(" ")}`, "info", true);
	return done;
}
