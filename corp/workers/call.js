// Design: docs/corporation.md
// @ts-check
/**
 * Runs a list of NS calls by name and posts what each returned. The corporation's functions cost 10GB (reads) and 20GB
 * (actions) each, so no fixed script can afford many of them; corp/corp-manager.js starts this one with exactly the RAM its
 * batch needs (RunOptions.ramOverride: 1.6GB plus each distinct function once, from ns.getFunctionRamCost), and the game
 * checks every call against that.
 *   run corp/workers/call.js '[["corporation.getCorporation"],["corporation.hireAdVert","Tobacco"]]'
 * Results go to port 49, one per call in order: { ok: true, value } or { ok: false, error }. A call that throws doesn't stop
 * the rest. Getters are left out of the results (getDivision's deprecated `type` would print a warning when read). Its static RAM is the 1.6GB base: the calls are looked up by name, so the RAM check sees none of them.
 */
/** @param {NS} ns */
export async function main(ns) {
	const RESULT_PORT = 49;
	const list = JSON.parse(String(ns.args[0] ?? "[]"));
	const out = [];
	for (const [path, ...rest] of list) {
		try {
			/** @type {any} */
			let target = ns;
			const parts = String(path).split(".");
			for (const part of parts.slice(0, -1)) target = target[part];
			const value = await target[parts[parts.length - 1]](...rest);
			out.push({ ok: true, value: plain(value) });
		} catch (error) {
			out.push({ ok: false, error: String(error?.message ?? error).slice(0, 300) });
		}
	}
	ns.writePort(RESULT_PORT, JSON.stringify(out));
}

/** A copy of a result with data properties only (accessors dropped), so JSON never touches a deprecated getter. */
function plain(value) {
	if (value === undefined) return null;
	if (!value || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(plain);
	/** @type {Record<string, any>} */
	const copy = {};
	for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
		if ("value" in descriptor && descriptor.enumerable) copy[key] = plain(descriptor.value);
	}
	return copy;
}
