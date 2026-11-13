// Design: docs/sleeves.md
// @ts-check
// Port the manager reads the results from (sleeves/plan.js RESULT_PORT; not imported so the worker stays small).
const RESULT_PORT = 41;

/**
 * One-shot for sleeves/sleeve-manager.js: Bladeburner actions for sleeves (contracts, support, infiltration). The game refuses
 * while the player is not in the division: the next candidate is tried then. 4GB, for a moment.
 *   args: JSON [{ sleeve, candidates: [{ kind: "bb", action, contract }] }]
 * Writes [{ sleeve, ok, used }, ...] (one entry per sleeve) to port 41 when done.
 */
/** @param {NS} ns */
export async function main(ns) {
	const results = [];
	for (const { sleeve, candidates } of JSON.parse(String(ns.args[0]))) {
		let used = "";
		for (const candidate of candidates) {
			let ok = false;
			try {
				ok = ns.sleeve.setToBladeburnerAction(sleeve, candidate.action, candidate.contract);
			} catch {
				ok = false;
			}
			if (ok) { used = candidate.contract ?? candidate.action; break; }
		}
		results.push({ sleeve, ok: !!used, used });
	}
	ns.clearPort(RESULT_PORT);
	ns.writePort(RESULT_PORT, JSON.stringify(results));
}
