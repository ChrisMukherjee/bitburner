// Solvers for server models that answer each wrong attempt with feedback we can learn from. So far: DeepGreen (Mastermind:
// each wrong attempt replies "exact,misplaced") and the Factori-Os model ("The password is divisible by 1 ;)"). The password is a product
// of primes, and each wrong attempt replies whether the password is divisible by what we sent (data "true"
// or "false"). We build the password up one prime factor at a time: if it's divisible by found * p, then p
// is another factor. An attempt that equals the password simply succeeds. Imported by the crawler; it only
// uses authenticate, which the crawler already pays for, so it adds no RAM.

import { login } from "darknet/auth.js";

export const FACTORIOS_MODEL = "Factori-Os";
export const DEEPGREEN_MODEL = "DeepGreen";
const MASTERMIND_MAX_LENGTH = 6; // 10^6 candidates is the most worth holding in memory

// The primes the game builds these passwords from (bitburner-src, DarkNet/controllers/ServerGenerator.ts).
// Small ones cover the random base and multipliers; large ones are only added on harder servers.
const SMALL_PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97];
const LARGE_PRIMES = [
	1069, 1409, 1471, 1567, 1597, 1601, 1697, 1747, 1801, 1889, 1979, 1999, 2063, 2207, 2371, 2503, 2539, 2693, 2741,
	2753, 2801, 2819, 2837, 2909, 2939, 3169, 3389, 3571, 3761, 3881, 4217, 4289, 4547, 4729, 4789, 4877, 4943, 4951,
	4957, 5393, 5417, 5419, 5441, 5519, 5527, 5647, 5779, 5881, 6007, 6089, 6133, 6389, 6451, 6469, 6547, 6661, 6719,
	6841, 7103, 7549, 7559, 7573, 7691, 7753, 7867, 8053, 8081, 8221, 8329, 8599, 8677, 8761, 8839, 8963, 9103, 9199,
	9343, 9467, 9551, 9601, 9739, 9749, 9859,
];

/**
 * Returns { password, attempts } like the crawler's crack(): password undefined if we couldn't find it, and
 * attempts holding the last few replies for the manager's Unsolved report. Returns { later: result } when a
 * reply wasn't a real "wrong password" (timeout, server moved or went offline): its divisibility data would
 * be missing, which used to silently drop a prime factor, so we stop and let the next re-check start over.
 * @param {NS} ns
 */
export async function solveDivisibility(ns, host) {
	// Not called `attempt`: the game's RAM check matches names, and ns.codingcontract.attempt costs 10 GB.
	const attempts = [];
	let later;
	const tryValue = async (value) => {
		const result = await login(ns, host, String(value));
		if (result.verdict === "ok") return "match";
		if (result.verdict === "later") { later = result; return "later"; }
		attempts.push({ password: String(value), code: result.code, message: result.message, data: result.data });
		return result.data === "true" ? "divides" : "no";
	};

	let found = 1;
	const first = await tryValue(found);
	if (first === "match") return { password: "1", attempts: [] }; // no prime factors at all
	if (first === "later") return { later };
	for (const prime of SMALL_PRIMES.concat(LARGE_PRIMES)) {
		while (true) { // a prime can appear more than once
			const outcome = await tryValue(found * prime);
			if (outcome === "match") return { password: String(found * prime), attempts: [] };
			if (outcome === "later") return { later };
			if (outcome !== "divides") break;
			found *= prime;
		}
	}
	return { password: undefined, attempts: attempts.slice(-5) };
}

/**
 * DeepGreen is Mastermind on a numeric password: a wrong attempt replies data "exact,misplaced" (digits in the right place /
 * right digit in the wrong place). Start with every numeric string of the right length and, after each attempt, keep only the
 * candidates that would have given the same reply. `observed` holds earlier replies read from the server's logs
 * (heartbleed.js), which narrow the start. Same return shape as solveDivisibility. Ported from the other player's lib-auth.js.
 * @param {NS} ns
 */
export async function solveMastermind(ns, host, details, observed = []) {
	const length = details.passwordLength;
	if (!length || details.passwordFormat !== "numeric" || length > MASTERMIND_MAX_LENGTH) return { password: undefined, attempts: [] };
	const attempts = [];
	let candidates = [];
	for (let n = 0, total = 10 ** length; n < total; n++) candidates.push(String(n).padStart(length, "0"));
	for (const seen of observed) {
		candidates = candidates.filter((code) => {
			const [exact, misplaced] = mastermindScore(seen.guess, code);
			return exact === seen.exact && misplaced === seen.misplaced;
		});
	}
	while (candidates.length > 0) {
		const guess = candidates[0];
		const result = await login(ns, host, guess);
		if (result.verdict === "ok") return { password: guess, attempts: [] };
		if (result.verdict === "later") return { later: result };
		attempts.push({ password: guess, code: result.code, message: result.message, data: result.data });
		const reply = String(result.data ?? "").match(/^\s*(\d+)\s*,\s*(\d+)\s*$/);
		if (!reply) break; // no usable reply: stop instead of guessing blind
		const exact = Number(reply[1]);
		const misplaced = Number(reply[2]);
		candidates = candidates.filter((code) => {
			const [codeExact, codeMisplaced] = mastermindScore(guess, code);
			return codeExact === exact && codeMisplaced === misplaced;
		});
	}
	return { password: undefined, attempts: attempts.slice(-5) };
}

/** Mastermind scoring: [exact, misplaced] of guess against code (digit strings, repeats allowed). */
function mastermindScore(guess, code) {
	let exact = 0;
	const guessCount = {};
	const codeCount = {};
	for (let i = 0; i < guess.length; i++) {
		if (guess[i] === code[i]) exact++;
		else {
			guessCount[guess[i]] = (guessCount[guess[i]] || 0) + 1;
			codeCount[code[i]] = (codeCount[code[i]] || 0) + 1;
		}
	}
	let misplaced = 0;
	for (const digit in guessCount) misplaced += Math.min(guessCount[digit], codeCount[digit] || 0);
	return [exact, misplaced];
}
