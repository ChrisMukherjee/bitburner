// Design: docs/sleeves.md
// @ts-check
// Port the manager reads the results from (sleeves/plan.js RESULT_PORT; not imported so the worker stays small).
const RESULT_PORT = 41;

/**
 * One-shot for sleeves/sleeve-manager.js: faction or company work. The game refuses a faction or company another sleeve (or
 * the player) already works for, or a work type the faction doesn't offer: the next candidate is tried then. 8GB, for a moment.
 *   args: JSON [{ sleeve, candidates: [{ kind: "faction", faction, work } | { kind: "company", company }] }]
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
				ok = candidate.kind === "faction"
					? !!ns.sleeve.setToFactionWork(sleeve, candidate.faction, candidate.work)
					: ns.sleeve.setToCompanyWork(sleeve, candidate.company);
			} catch {
				ok = false; // the game throws for a faction without that work type
			}
			if (ok) { used = candidate.kind === "faction" ? `${candidate.faction} (${candidate.work})` : candidate.company; break; }
		}
		results.push({ sleeve, ok: !!used, used });
	}
	ns.clearPort(RESULT_PORT);
	ns.writePort(RESULT_PORT, JSON.stringify(results));
}
