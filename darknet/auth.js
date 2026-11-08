// @ts-check
// Darknet login helper shared by the crawler and the feedback solvers. Only uses ns.dnet.authenticate,
// which they already pay for, so importing it adds no RAM.
//
// What ns.dnet.authenticate can answer (bitburner-src DarkNet/Enums.ts ResponseCodeEnum):
//   200 success, 401 wrong password (the only answer that says anything about the guess),
//   408 timed out because of darknet instability (happens even with the right password),
//   351 the server moved and isn't our neighbour any more, 503 the server went offline,
//   451 not enough charisma (labyrinth servers).
export const AUTH_OK = 200;
export const WRONG_PASSWORD = 401;
const TIMED_OUT = 408;
const TIMEOUT_RETRIES = 4; // even at the 50% cap, 5 timeouts in a row is ~3%

/**
 * authenticate, retrying 408 timeouts. The result gets an extra `verdict`:
 *   "ok"    logged in,
 *   "wrong" the server rejected this password (try the next candidate),
 *   "later" anything else (moved, offline, timed out, too little charisma): the guess may still be right,
 *           so stop for now and try this server again on the next re-check instead of giving up on it.
 * @param {NS} ns
 */
export async function login(ns, host, password) {
	let result;
	for (let i = 0; i <= TIMEOUT_RETRIES; i++) {
		result = await ns.dnet.authenticate(host, password);
		if (result.code !== TIMED_OUT) break;
	}
	const verdict = result.success ? "ok" : result.code === WRONG_PASSWORD ? "wrong" : "later";
	return { ...result, verdict };
}
