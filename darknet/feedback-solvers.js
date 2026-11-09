// Solvers for server models that answer each wrong attempt with feedback we can learn from (plus Pr0verFl0, solved by one
// overflow guess, and OpenWebAccessPoint, read from captured packets). So far: DeepGreen (Mastermind:
// each wrong attempt replies "exact,misplaced") and the Factori-Os model ("The password is divisible by 1 ;)"). The password is a product
// of primes, and each wrong attempt replies whether the password is divisible by what we sent (data "true"
// or "false"). We build the password up one prime factor at a time: if it's divisible by found * p, then p
// is another factor. An attempt that equals the password simply succeeds. Imported by the crawler; it only
// uses authenticate, which the crawler already pays for, so it adds no RAM.

import { login } from "darknet/auth.js";
import { readLogs, parseMastermindReply, MAX_LOGS } from "darknet/heartbleed.js";
import { fitsDetails } from "darknet/hint-interpreter.js";

export const FACTORIOS_MODEL = "Factori-Os";
export const DEEPGREEN_MODEL = "DeepGreen";
export const OVERFLOW_MODEL = "Pr0verFl0";
export const PACKET_SNIFFER_MODEL = "OpenWebAccessPoint";
const SNIFF_MAX_ATTEMPTS = 8; // captures to intersect before giving up (two nearly always suffice)
const OVERFLOW_LENGTHS = [4, 5, 6, 7]; // the game builds these buffers 4 to 7 bytes long
const MASTERMIND_MAX_LENGTH = 6; // 10^6 candidates is the most worth holding in memory
const MASTERMIND_MAX_GUESSES = 60; // a numeric code of 6 digits needs about 8; this only stops a runaway
const MASTERMIND_HISTORY_FILE = "data/darknet-mastermind.txt"; // per-host replies, kept on the server the solver runs on
const MASTERMIND_HISTORY_TTL = 60 * 60 * 1000; // ms; older replies may predate a password change
const DIVISIBILITY_WINNER_CHECK = 8; // attempts between looks at the server log for a login that already worked

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
export async function solveDivisibility(ns, host, details = {}) {
	// Not called `attempt`: the game's RAM check matches names, and ns.codingcontract.attempt costs 10 GB.
	const attempts = [];
	const tried = new Set();
	let later;
	const tryValue = async (value) => {
		tried.add(String(value));
		const result = await login(ns, host, String(value));
		if (result.verdict === "ok") return "match";
		if (result.verdict === "later") { later = result; return "later"; }
		attempts.push({ password: String(value), code: result.code, message: result.message, data: result.data });
		const divisible = isDivisible(result);
		if (divisible === undefined) return "unreadable"; // never read an unclear reply as "no": that would skip a factor
		return divisible ? "divides" : "no";
	};
	// Every few attempts, see whether somebody already logged in (the player did it by hand, or another crawler).
	const checkWinner = async () => {
		if (attempts.length % DIVISIBILITY_WINNER_CHECK !== 0) return undefined;
		return await loggedWinner(ns, host, details, tried);
	};

	// The password is a number of exactly `passwordLength` digits, so no candidate may exceed 10^length - 1 (a 2-digit
	// password never needs the large primes), and the hint's "divisible by N" gives a factor to start from.
	const limit = details.passwordLength > 0 ? 10 ** details.passwordLength - 1 : Infinity;
	let found = hintDivisor(details.passwordHint);
	if (found > limit) found = 1;
	const first = await tryValue(found);
	if (first === "match") return { password: String(found), attempts: [] }; // no more prime factors
	if (first === "later") return { later };
	if (first === "unreadable") return { password: undefined, attempts };
	for (const prime of SMALL_PRIMES.concat(LARGE_PRIMES)) {
		while (found * prime <= limit) { // a prime can appear more than once
			const outcome = await tryValue(found * prime);
			if (outcome === "match") return { password: String(found * prime), attempts: [] };
			if (outcome === "later") return { later };
			if (outcome === "unreadable") return { password: undefined, attempts: attempts.slice(-5) };
			const winner = await checkWinner();
			if (winner?.password) return { password: winner.password, attempts: [] };
			if (winner?.later) return { later: winner.later };
			if (outcome !== "divides") break;
			found *= prime;
		}
	}
	return { password: undefined, attempts: attempts.slice(-5) };
}

/**
 * Whether a Factori-Os reply says the password is divisible by what we sent: true / false, or undefined when the reply
 * can't be read. The game sends data "true" or "false" and the message "Password IS divisible by 'N'" or "...is not
 * divisible...", so we accept the data as a string or boolean and fall back to the message.
 * @param {{ data?: any, message?: any }} result
 */
export function isDivisible(result) {
	const data = String(result?.data ?? "").trim().toLowerCase();
	if (data === "true") return true;
	if (data === "false") return false;
	const message = String(result?.message ?? "");
	if (/not divisible/i.test(message)) return false;
	if (/\bis divisible/i.test(message)) return true;
	return undefined;
}

/**
 * A password the server's log says already logged in (the player typed it, or another crawler found it), tried now.
 * Returns { password } on success, { later } when the server went away, undefined when there is nothing to use.
 * @param {NS} ns
 */
async function loggedWinner(ns, host, details, skip = new Set()) {
	const logs = await readLogs(ns, host, MAX_LOGS);
	for (const candidate of new Set(logs.winners)) {
		if (skip.has(candidate) || !fitsDetails(candidate, details)) continue;
		const result = await login(ns, host, candidate);
		if (result.verdict === "ok") return { password: candidate };
		if (result.verdict === "later") return { later: result };
	}
	return undefined;
}

/** The N in a hint like "The password is divisible by N ;)": a known divisor of the password (1 when absent). */
export function hintDivisor(hint) {
	const match = String(hint ?? "").match(/divisible by\s+(\d+)/i);
	const value = match ? Number(match[1]) : 1;
	return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

/**
 * DeepGreen is Mastermind on a numeric password: a wrong attempt replies data "exact,misplaced" (digits in the right place /
 * right digit in the wrong place). Start with every numeric string of exactly `passwordLength` digits (never any other
 * length) and keep only the candidates that agree with everything known:
 *   - the replies to earlier attempts, read from the server's log before every guess (so several crawlers working on the
 *     same server, and a restarted crawler, build on each other instead of repeating guesses), plus the ones this
 *     server's file remembers (data/darknet-mastermind.txt, expiring after an hour in case the password changed);
 *   - the log's "I can see a 8 and a 6" lines, which name two digits that are in the password.
 * Each guess is a random remaining candidate, so concurrent solvers rarely pick the same one. A login that already worked
 * (e.g. typed by hand) is picked up from the log too. `observed` and `clues` are earlier reads of that log (crawler.js);
 * `random` is for tests. Same return shape as solveDivisibility.
 * @param {NS} ns
 */
export async function solveMastermind(ns, host, details, observed = [], clues = [], random = Math.random) {
	const length = details.passwordLength;
	if (!length || details.passwordFormat !== "numeric" || length > MASTERMIND_MAX_LENGTH) return { password: undefined, attempts: [] };
	const attempts = [];
	const history = new Map(); // guess -> { exact, misplaced }
	const known = new Map(); // fresh replies only (this run + the log), used if older ones contradict the rest
	const remember = (entries, store = history) => {
		for (const entry of entries) if (entry.guess.length === length && /^\d+$/.test(entry.guess)) store.set(entry.guess, { exact: entry.exact, misplaced: entry.misplaced });
	};
	remember(loadHistory(ns, host));
	remember(observed);
	remember(observed, known);
	const allClues = [...clues];
	const wrongGuesses = new Set();

	const everything = () => {
		const all = [];
		for (let n = 0, total = 10 ** length; n < total; n++) all.push(String(n).padStart(length, "0"));
		return all;
	};
	const narrow = (list) => {
		let out = list;
		for (const [guess, reply] of history) out = out.filter((code) => agrees(guess, code, reply));
		return out.filter((code) => allClues.every((clue) => holdsClue(code, clue)));
	};
	// If the remembered replies contradict the fresh ones the password changed since: trust only the fresh ones.
	const narrowAll = () => {
		let list = narrow(everything().filter((code) => !wrongGuesses.has(code)));
		if (list.length === 0 && history.size > known.size) {
			history.clear();
			remember([...known].map(([guess, reply]) => ({ guess, ...reply })));
			list = narrow(everything().filter((code) => !wrongGuesses.has(code)));
		}
		return list;
	};
	let candidates = narrowAll();

	for (let round = 0; candidates.length > 0 && round < MASTERMIND_MAX_GUESSES; round++) {
		// Pick up whatever other solvers and the player did since the last look.
		const logs = await readLogs(ns, host, MAX_LOGS);
		remember(logs.observed);
		remember(logs.observed, known);
		allClues.push(...logs.clues);
		for (const word of logs.winners) {
			if (wrongGuesses.has(word) || !fitsDetails(word, details)) continue;
			wrongGuesses.add(word);
			const result = await login(ns, host, word);
			if (result.verdict === "ok") return { password: word, attempts: [] };
			if (result.verdict === "later") return { later: result };
		}
		candidates = narrow(candidates.filter((code) => !history.has(code) && !wrongGuesses.has(code)));
		if (candidates.length === 0) candidates = narrowAll();
		if (candidates.length === 0) break;

		const guess = candidates[Math.floor(random() * candidates.length)];
		const result = await login(ns, host, guess);
		if (result.verdict === "ok") return { password: guess, attempts: [] };
		if (result.verdict === "later") return { later: result };
		attempts.push({ password: guess, code: result.code, message: result.message, data: result.data });
		wrongGuesses.add(guess);
		const reply = parseMastermindReply(result.data, result.message);
		if (!reply) break; // no usable reply (the attempts above show what came back): stop instead of guessing blind
		history.set(guess, reply);
		known.set(guess, reply);
		saveHistory(ns, host, history);
		candidates = candidates.filter((code) => agrees(guess, code, reply));
	}
	return { password: undefined, attempts: attempts.slice(-5) };
}

/** True if `code` would have given `reply` to `guess`. */
function agrees(guess, code, reply) {
	const [exact, misplaced] = mastermindScore(guess, code);
	return exact === reply.exact && misplaced === reply.misplaced;
}

/** True if the code contains both characters of a "there's a 8 and a 6" clue (twice, when they are the same). */
export function holdsClue(code, [a, b]) {
	const count = (char) => [...code].filter((c) => c === char).length;
	return a === b ? count(a) >= 2 : count(a) >= 1 && count(b) >= 1;
}

function loadHistory(ns, host) {
	try {
		const all = JSON.parse(ns.read(MASTERMIND_HISTORY_FILE) || "{}");
		return (all[host] ?? []).filter((entry) => Date.now() - entry.at < MASTERMIND_HISTORY_TTL);
	} catch {
		return [];
	}
}

function saveHistory(ns, host, history) {
	try {
		const all = JSON.parse(ns.read(MASTERMIND_HISTORY_FILE) || "{}");
		all[host] = [...history].map(([guess, reply]) => ({ guess, ...reply, at: Date.now() })).slice(-MASTERMIND_MAX_GUESSES);
		ns.write(MASTERMIND_HISTORY_FILE, JSON.stringify(all), "w");
	} catch {
		// the history is only a convenience
	}
}

/**
 * Pr0verFl0 (hint "Warning: password buffer is N bytes") needs no search. The game lays out N blanks plus N mask characters,
 * writes the guess over the start of that buffer, and accepts when the first N characters equal the next N. A guess of 2N
 * characters whose two halves match therefore always opens it (bitburner-src DarkNet/effects/authentication.ts). What we
 * store as "the password" is that guess, not the real one; it logs in the same way every time.
 * Returns undefined when the length is unknown, so callers can fall back to trying every possible length.
 * @param {number} length
 */
export function overflowGuess(length) {
	return Number.isInteger(length) && length > 0 ? "a".repeat(length * 2) : undefined;
}

/** Buffer size from the details (`passwordLength`), else from the hint text; undefined if neither says. */
export function overflowLength(details) {
	if (details.passwordLength > 0) return details.passwordLength;
	const match = String(details.passwordHint ?? "").match(/buffer is (\d+) bytes/i);
	return match ? Number(match[1]) : undefined;
}

/**
 * Opens a Pr0verFl0 server with one overflow guess (see overflowGuess). Same return shape as solveDivisibility. With an unknown
 * length it tries each length the game uses, so a wrong guess can only cost a few failed logins.
 * @param {NS} ns
 */
export async function solveOverflow(ns, host, details) {
	const known = overflowLength(details);
	const attempts = [];
	for (const length of known ? [known] : OVERFLOW_LENGTHS) {
		const guess = overflowGuess(length);
		const result = await login(ns, host, guess);
		if (result.verdict === "ok") return { password: guess, attempts: [] };
		if (result.verdict === "later") return { later: result };
		attempts.push({ password: guess, code: result.code, message: result.message, data: result.data });
	}
	return { password: undefined, attempts };
}

/**
 * Candidate passwords inside one captured packet: on easy servers the game writes " <host>:<password> " into random data, and
 * on harder ones the password is a plain run of `length` characters hidden in random data of the same character set. Returns the
 * set of every run that fits the format (host-marked one first when present, then flagged `marked`).
 * @param {string} data
 * @param {string} host
 * @param {number} length
 * @param {string} [format]
 * @returns {{ marked: string|undefined, windows: Set<string> }}
 */
export function sniffCandidates(data, host, length, format) {
	const text = String(data ?? "");
	const fits = { numeric: /^\d+$/, alphabetic: /^[A-Za-z]+$/, alphanumeric: /^[A-Za-z0-9]+$/ }[format ?? ""] ?? /^\S+$/;
	let marked;
	const at = text.indexOf(host + ":");
	if (at >= 0) {
		const word = text.slice(at + host.length + 1, at + host.length + 1 + length);
		if (word.length === length && fits.test(word)) marked = word;
	}
	const windows = new Set();
	for (let i = 0; i + length <= text.length; i++) {
		const word = text.slice(i, i + length);
		if (fits.test(word)) windows.add(word);
	}
	return { marked, windows };
}

/**
 * OpenWebAccessPoint (hint about browsing at the cafe): every wrong attempt replies with a captured packet in `data`, ~125-145
 * characters of noise with the password hidden in it (bitburner-src DarkNet/models/packetSniffing.ts). The noise is random per
 * capture but the password is not, so the runs of the right length and format that appear in every capture narrow to the
 * password (usually after two). Same return shape as solveDivisibility.
 * @param {NS} ns
 */
export async function solvePacketSniffer(ns, host, details) {
	const length = details.passwordLength;
	if (!(length > 0)) return { password: undefined, attempts: [] };
	const attempts = [];
	const wrong = new Set();
	let common;
	const guessWith = async (word) => {
		const result = await login(ns, host, word);
		if (result.verdict === "ok") return { password: word };
		if (result.verdict === "later") return { later: result };
		wrong.add(word);
		attempts.push({ password: word, code: result.code, message: result.message, data: String(result.data ?? "").slice(0, 40) });
		return { result };
	};
	const filler = details.passwordFormat === "numeric" ? "0".repeat(length) : "a".repeat(length);
	for (let round = 0; round < SNIFF_MAX_ATTEMPTS; round++) {
		const first = await guessWith(round === 0 ? filler : filler.slice(1) + String(round % 10));
		if (first.password) return { password: first.password, attempts: [] };
		if (first.later) return { later: first.later };
		const { marked, windows } = sniffCandidates(first.result.data, host, length, details.passwordFormat);
		if (marked && !wrong.has(marked)) {
			const outcome = await guessWith(marked);
			if (outcome.password) return { password: outcome.password, attempts: [] };
			if (outcome.later) return { later: outcome.later };
		}
		common = common ? new Set([...common].filter((word) => windows.has(word))) : windows;
		for (const word of wrong) common.delete(word);
		if (common.size === 0) common = undefined; // a capture without the password (server moved?): start over
		else if (round > 0 && common.size <= 3) {
			for (const word of [...common]) {
				const outcome = await guessWith(word);
				if (outcome.password) return { password: outcome.password, attempts: [] };
				if (outcome.later) return { later: outcome.later };
				common.delete(word);
			}
		}
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
