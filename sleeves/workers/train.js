// Design: docs/sleeves.md
// @ts-check
// Port the manager reads the results from (sleeves/plan.js RESULT_PORT; not imported so the worker stays small).
const RESULT_PORT = 41;

/**
 * One-shot for sleeves/sleeve-manager.js: gym workouts and university courses, flying the sleeve to the city first when the
 * candidate says so (`travel`). 12GB, for a moment.
 *   args: JSON [{ sleeve, candidates: [{ kind: "gym", gym, stat, travel } | { kind: "class", university, course, travel }] }]
 * Writes [{ sleeve, ok, used }, ...] (one entry per sleeve) to port 41 when done.
 */
/** @param {NS} ns */
export async function main(ns) {
	const results = [];
	for (const { sleeve, candidates } of JSON.parse(String(ns.args[0]))) {
		let used = "";
		for (const candidate of candidates) {
			if (candidate.travel && !ns.sleeve.travel(sleeve, candidate.travel)) continue;
			const ok = candidate.kind === "gym"
				? ns.sleeve.setToGymWorkout(sleeve, candidate.gym, candidate.stat)
				: ns.sleeve.setToUniversityCourse(sleeve, candidate.university, candidate.course);
			if (ok) { used = candidate.kind === "gym" ? `${candidate.stat} at ${candidate.gym}` : `${candidate.course} at ${candidate.university}`; break; }
		}
		results.push({ sleeve, ok: !!used, used });
	}
	ns.clearPort(RESULT_PORT);
	ns.writePort(RESULT_PORT, JSON.stringify(results));
}
