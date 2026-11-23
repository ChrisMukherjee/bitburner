// Design: docs/darknet.md
// @ts-check
// Solvers for darknet passwords with too many possibilities to list, found position by position from the score the server
// gives each wrong guess: DeepGreen with letters or over 6 digits, and PHP 5.4 from 5 characters up. Imported by the
// crawler; uses only authenticate and heartbleed (through loginReply), which the crawler already pays for, so it adds no RAM.
// The game's rules (bitburner-src v3.0.1): DarkNet/controllers/ServerGenerator.ts getMastermindHintConfig and
// getSortedEchoVulnConfig build the passwords, DarkNet/effects/authentication.ts checkPassword writes the replies.

import { loginReply, parseMastermindReply } from "/darknet/heartbleed.js";
import { mastermindScore } from "/darknet/feedback-solvers.js";

const DIGITS = "0123456789";
const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"; // the game's letters (models/dictionaryData.ts)
/** Never in a generated password, so a guess padded with it scores only the symbols we placed. authenticate takes any string. */
export const FILLER = "-";
const MAX_GUESSES = 200; // a 10-character alphanumeric code takes about 60; this only stops a runaway
const HISTORY_FILE = "data/darknet-solver-history.txt"; // per-host replies, kept on the server the solver runs on
const HISTORY_TTL = 60 * 60 * 1000; // ms; older replies may predate a password change
/** PHP 5.4 answers a numeric guess of the right length with an RMS deviation only from 5 characters (authentication.ts). */
export const SORTED_ECHO_MIN_LENGTH = 5;
const SORTED_ECHO_MAX_GUESSES = 30; // 9 digits take about 4; this only stops a runaway
const PICK_OPTIONS = 20; // candidate guesses compared before each PHP 5.4 guess
const PICK_SAMPLE = 2000; // candidates each option is scored against

/** The symbols a DeepGreen password of this format can hold ("" for a format the game never makes for it). */
export function mastermindAlphabet(format) {
	if (format === "numeric") return DIGITS;
	if (format === "alphabetic") return LETTERS;
	if (format === "alphanumeric") return DIGITS + LETTERS;
	return "";
}

/**
 * Finds a Mastermind code of `length` symbols from `alphabet` with `ask(guess)`, which resolves to the reply
 * { exact, misplaced } or undefined to stop. Two steps, each guess padded with FILLER so it scores only what it places:
 *   1. Which symbols the code holds. With few symbols (up to twice the length, so digits) one guess of each symbol repeated:
 *      exact is how often it appears. With more, guesses of `length` different symbols: exact + misplaced is how many of
 *      them appear, and a group with any is halved until each is found (a code with no repeats needs no counts then).
 *   2. Where each symbol is: the symbol on half of the open positions scores how many of them hold it, halved again until
 *      every one is placed. The last symbol takes the positions left.
 * Returns the code, or undefined when `ask` stopped.
 * @param {number} length
 * @param {string} alphabet
 * @param {(guess: string) => Promise<{ exact: number, misplaced: number } | undefined>} ask
 */
export async function findCode(length, alphabet, ask) {
	const counts = await symbolCounts(length, alphabet, ask);
	if (!counts) return undefined;
	const code = new Array(length).fill(FILLER);
	let open = [...Array(length).keys()];
	const symbols = [...counts.keys()];
	for (let i = 0; i < symbols.length && open.length > 0; i++) {
		const symbol = symbols[i];
		let at;
		if (i === symbols.length - 1) at = open;
		else {
			let count = counts.get(symbol);
			if (count === undefined) {
				const reply = await ask(placed(length, symbol, open));
				if (!reply) return undefined;
				count = reply.exact;
			}
			at = await positionsOf(length, symbol, open, count, ask);
			if (!at) return undefined;
		}
		for (const position of at) code[position] = symbol;
		open = open.filter((position) => !at.includes(position));
	}
	return code.join("");
}

/**
 * Step 1 of findCode: Map symbol -> how many times it is in the code, in alphabet order. A count is undefined when only
 * "present" is known (found by group, in a code with repeats). Undefined when `ask` stopped.
 */
async function symbolCounts(length, alphabet, ask) {
	const counts = new Map();
	if (alphabet.length <= 2 * length) {
		let total = 0;
		for (let i = 0; i < alphabet.length && total < length; i++) {
			const symbol = alphabet[i];
			if (i === alphabet.length - 1) { counts.set(symbol, length - total); break; } // the rest of the code
			const reply = await ask(symbol.repeat(length));
			if (!reply) return undefined;
			if (reply.exact > 0) counts.set(symbol, reply.exact);
			total += reply.exact;
		}
		return counts;
	}
	const present = [];
	const inGroup = async (group) => {
		const reply = await ask(group.join("") + FILLER.repeat(length - group.length));
		return reply ? reply.exact + reply.misplaced : undefined;
	};
	const halve = async (group, found) => {
		if (found === 0) return true;
		if (found === group.length) { present.push(...group); return true; }
		const half = group.slice(0, Math.ceil(group.length / 2));
		const inHalf = await inGroup(half);
		if (inHalf === undefined) return false;
		return (await halve(half, inHalf)) && (await halve(group.slice(half.length), found - inHalf));
	};
	for (let start = 0; start < alphabet.length && present.length < length; start += length) {
		const group = [...alphabet.slice(start, start + length)];
		const found = await inGroup(group);
		if (found === undefined || !(await halve(group, found))) return undefined;
	}
	const distinct = present.length === length;
	for (const symbol of present) counts.set(symbol, distinct ? 1 : undefined);
	return counts;
}

/** Step 2 of findCode: the `count` positions among `positions` that hold `symbol`, or undefined when `ask` stopped. */
async function positionsOf(length, symbol, positions, count, ask) {
	if (count <= 0) return [];
	if (count >= positions.length) return [...positions];
	const half = positions.slice(0, Math.ceil(positions.length / 2));
	const reply = await ask(placed(length, symbol, half));
	if (!reply) return undefined;
	const left = await positionsOf(length, symbol, half, reply.exact, ask);
	const right = left && (await positionsOf(length, symbol, positions.slice(half.length), count - reply.exact, ask));
	return left && right ? [...left, ...right] : undefined;
}

/** A guess with `symbol` at `positions` and FILLER everywhere else. */
function placed(length, symbol, positions) {
	const guess = new Array(length).fill(FILLER);
	for (const position of positions) guess[position] = symbol;
	return guess.join("");
}

/**
 * DeepGreen passwords too many to list (letters, or more than 6 digits; up to 10 characters): findCode, asking the server.
 * Replies already in the server's log (`observed`, from readLogs) or remembered in data/darknet-solver-history.txt are used
 * without asking again, so a restarted or second crawler carries on where the first stopped. Same return shape as the
 * other solvers: { password, attempts }, or { later } when the server stopped answering.
 * @param {NS} ns
 * @param {string} host
 * @param {{ passwordLength?: number, passwordFormat?: string }} details
 * @param {{ guess: string, exact: number, misplaced: number }[]} [observed]
 */
export async function solveMastermindLong(ns, host, details, observed = []) {
	const length = details.passwordLength ?? 0;
	const alphabet = mastermindAlphabet(details.passwordFormat ?? "");
	/** @type {{ password: string, code?: number, message?: string, data?: string }[]} */
	const attempts = [];
	if (!length || !alphabet) return { password: undefined, attempts };
	const known = new Map();
	for (const entry of [...loadHistory(ns, host), ...observed]) {
		if (String(entry.guess).length === length) known.set(String(entry.guess), { exact: entry.exact, misplaced: entry.misplaced });
	}
	/** @type {string | undefined} */
	let found;
	let later;
	let asked = 0;
	/** @param {string} guess */
	const ask = async (guess) => {
		if (found !== undefined) return scored(guess, found); // solved early: the rest is arithmetic
		const remembered = known.get(guess);
		if (remembered) return remembered;
		if (asked++ >= MAX_GUESSES) return undefined;
		const result = await loginReply(ns, host, guess);
		if (result.verdict === "ok") { found = guess; return scored(guess, found); }
		if (result.verdict === "later") { later = result; return undefined; }
		attempts.push({ password: guess, code: result.code, message: result.message, data: result.data });
		const reply = parseMastermindReply(result.data, result.message);
		if (!reply) return undefined; // no usable reply (attempts shows what came back): stop instead of guessing blind
		known.set(guess, reply);
		saveHistory(ns, host, known);
		return reply;
	};
	const code = await findCode(length, alphabet, ask);
	if (later) return { later };
	if (found === undefined && code !== undefined && !code.includes(FILLER)) await ask(code);
	if (later) return { later };
	if (found !== undefined) return { password: found, attempts: [] };
	saveHistory(ns, host, new Map()); // the replies led nowhere (the password may have changed): start afresh next time
	return { password: undefined, attempts: attempts.slice(-5) };
}

function scored(guess, code) {
	const [exact, misplaced] = mastermindScore(guess, code);
	return { exact, misplaced };
}

function loadHistory(ns, host) {
	try {
		const all = JSON.parse(ns.read(HISTORY_FILE) || "{}");
		return (all[host] ?? []).filter((entry) => Date.now() - entry.at < HISTORY_TTL);
	} catch {
		return [];
	}
}

function saveHistory(ns, host, known) {
	try {
		const all = JSON.parse(ns.read(HISTORY_FILE) || "{}");
		all[host] = [...known].map(([guess, reply]) => ({ guess, ...reply, at: Date.now() })).slice(-MAX_GUESSES);
		ns.write(HISTORY_FILE, JSON.stringify(all), "w");
	} catch {
		// the history is only a convenience
	}
}

/**
 * Every distinct arrangement of `sorted`'s characters that the game could have made: no leading zero, because numeric
 * passwords are stored as Number(password).toString() (ServerGenerator.ts getPassword). At most 9! = 362,880.
 * @param {string} sorted
 */
export function arrangements(sorted) {
	const chars = [...sorted].sort();
	const out = [];
	while (true) {
		if (chars.length === 1 || chars[0] !== "0") out.push(chars.join(""));
		// next permutation in lexicographic order, skipping repeats
		let i = chars.length - 2;
		while (i >= 0 && chars[i] >= chars[i + 1]) i--;
		if (i < 0) return out;
		let j = chars.length - 1;
		while (chars[j] <= chars[i]) j--;
		[chars[i], chars[j]] = [chars[j], chars[i]];
		const tail = chars.splice(i + 1).reverse();
		chars.push(...tail);
	}
}

/** Sum of squared differences digit by digit: what PHP 5.4's RMS deviation encodes (rms^2 x length). */
export function squaredError(guess, code) {
	let total = 0;
	for (let i = 0; i < code.length; i++) total += (Number(guess[i]) - Number(code[i])) ** 2;
	return total;
}

/** The squared error a PHP 5.4 reply gives away ("<sorted>; RMS Deviation:1.732"), or undefined without one. */
export function parseRmsReply(data, length) {
	const match = String(data ?? "").match(/RMS Deviation:\s*([\d.]+)/i);
	return match ? Math.round(Number(match[1]) ** 2 * length) : undefined;
}

/**
 * PHP 5.4 from 5 characters up. Data is the password's digits sorted, and a wrong numeric guess of the right length also
 * replies with the RMS deviation from the password, which fixes the sum of squared differences. Keep the arrangements of
 * Data that give each reply; guess the one (of a sample) whose replies split the rest most evenly. About 4 guesses for 9
 * digits. Shorter passwords get no deviation, so the crawler tries their anagrams instead (hint-interpreter.js).
 * @param {NS} ns
 * @param {string} host
 * @param {{ data?: string, passwordLength?: number }} details
 * @param {() => number} [random] for tests
 */
export async function solveSortedEcho(ns, host, details, random = Math.random) {
	const sorted = String(details.data ?? "").split(";")[0].trim();
	/** @type {{ password: string, code?: number, message?: string, data?: string }[]} */
	const attempts = [];
	if (!/^\d+$/.test(sorted) || sorted.length < SORTED_ECHO_MIN_LENGTH || (details.passwordLength ?? sorted.length) !== sorted.length) {
		return { password: undefined, attempts };
	}
	let candidates = arrangements(sorted);
	for (let round = 0; candidates.length > 0 && round < SORTED_ECHO_MAX_GUESSES; round++) {
		const guess = pickGuess(candidates, random);
		const result = await loginReply(ns, host, guess);
		if (result.verdict === "ok") return { password: guess, attempts: [] };
		if (result.verdict === "later") return { later: result };
		attempts.push({ password: guess, code: result.code, message: result.message, data: result.data });
		const error = parseRmsReply(result.data, sorted.length);
		if (error === undefined) break; // no deviation in the reply: stop and leave the anagrams to the crawler
		candidates = candidates.filter((code) => code !== guess && squaredError(guess, code) === error);
		if (round % 4 === 3) await ns.sleep(0); // filtering hundreds of thousands of strings: let the game breathe
	}
	return { password: undefined, attempts: attempts.slice(-5) };
}

/** The candidate (of a random few) whose possible replies leave the smallest largest group, judged on a sample. */
function pickGuess(candidates, random) {
	if (candidates.length <= 2) return candidates[0];
	const sample = (n) => candidates.length <= n ? candidates : Array.from({ length: n }, () => candidates[Math.floor(random() * candidates.length)]);
	const against = sample(PICK_SAMPLE);
	let best = candidates[0];
	let bestWorst = Infinity;
	for (const option of sample(PICK_OPTIONS)) {
		const groups = new Map();
		for (const code of against) {
			const key = squaredError(option, code);
			groups.set(key, (groups.get(key) ?? 0) + 1);
		}
		const worst = Math.max(...groups.values());
		if (worst < bestWorst) { bestWorst = worst; best = option; }
	}
	return best;
}
