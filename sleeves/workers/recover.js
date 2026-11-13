// Design: docs/sleeves.md
// @ts-check
// Port the manager reads the results from (sleeves/plan.js RESULT_PORT; not imported so the worker stays small).
const RESULT_PORT = 41;

/**
 * One-shot for sleeves/sleeve-manager.js: shock recovery or synchronization for the sleeves it names. 8GB, for a moment.
 *   args: JSON [{ sleeve, candidates: [{ kind: "recover" | "sync" }] }]
 * Writes [{ sleeve, ok, used }, ...] (one entry per sleeve) to port 41 when done.
 */
/** @param {NS} ns */
export async function main(ns) {
	const results = [];
	for (const { sleeve, candidates } of JSON.parse(String(ns.args[0]))) {
		let used = "";
		for (const candidate of candidates) {
			const ok = candidate.kind === "sync" ? ns.sleeve.setToSynchronize(sleeve) : ns.sleeve.setToShockRecovery(sleeve);
			if (ok) { used = candidate.kind; break; }
		}
		results.push({ sleeve, ok: !!used, used });
	}
	ns.clearPort(RESULT_PORT);
	ns.writePort(RESULT_PORT, JSON.stringify(results));
}
