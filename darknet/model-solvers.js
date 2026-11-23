// Design: docs/darknet.md
// @ts-check
// Darknet server models the hint interpreter could not open: each one's password follows from its hint data, or from the
// reply to a wrong guess, by a rule copied from the game (bitburner-src v3.0.1, DarkNet/controllers/ServerGenerator.ts builds
// each model's password and hint, DarkNet/effects/authentication.ts its reply to a wrong guess). The pure functions cost no
// RAM; the feedback solvers only use authenticate and heartbleed (through loginReply), which the crawler already pays for.

import { loginReply } from "/darknet/heartbleed.js";

export const PRIME_MODEL = "PrimeTime 2"; // "The password is the largest prime factor of N"
export const XOR_MODEL = "OrdoXenos"; // XOR mask encrypted password; data "masked;mask mask ..."
export const BINARY_MODEL = "110100100"; // "beep boop"; data is the password's character codes in binary
export const EXPRESSION_MODEL = "MathML"; // "The password is the evaluation of this expression"
export const BASE_MODEL = "OctantVoxel"; // "the password is the base B number X in base 10" (B can be fractional)
export const ROMAN_MODEL = "BellaCuore"; // a Roman numeral, or a range of two
export const EU_MODEL = "EuroZone Free"; // "My favorite EU country"
export const COMMON_MODEL = "TopPass"; // "It's a common password"
export const TIMING_MODEL = "2G_cellular"; // a wrong guess reports where the first mismatch is
export const MODULO_MODEL = "BigMo%od"; // "(password % n) % (n % 32)"

/** The game's EU country list (DarkNet/models/dictionaryData.ts EUCountries). */
export const EU_COUNTRIES = [
	"Austria", "Belgium", "Bulgaria", "Croatia", "Republic of Cyprus", "Czech Republic", "Denmark", "Estonia", "Finland",
	"France", "Germany", "Greece", "Hungary", "Ireland", "Italy", "Latvia", "Lithuania", "Luxembourg", "Malta",
	"Netherlands", "Poland", "Portugal", "Romania", "Slovakia", "Slovenia", "Spain", "Sweden",
];

/** The game's common password list (DarkNet/models/dictionaryData.ts commonPasswordDictionary). */
export const COMMON_PASSWORDS = [
	"123456", "password", "12345678", "qwerty", "123456789", "12345", "1234", "111111", "1234567", "dragon", "123123",
	"baseball", "abc123", "football", "monkey", "letmein", "696969", "shadow", "master", "666666", "qwertyuiop", "123321",
	"mustang", "1234567890", "michael", "654321", "superman", "1qaz2wsx", "7777777", "121212", "0", "qazwsx", "123qwe",
	"trustno1", "jordan", "jennifer", "zxcvbnm", "asdfgh", "hunter", "buster", "soccer", "harley", "batman", "andrew",
	"tigger", "sunshine", "iloveyou", "2000", "charlie", "robert", "thomas", "hockey", "ranger", "daniel", "starwars",
	"112233", "george", "computer", "michelle", "jessica", "pepper", "1111", "zxcvbn", "555555", "11111111", "131313",
	"freedom", "777777", "pass", "maggie", "159753", "aaaaaa", "ginger", "princess", "joshua", "cheese", "amanda", "summer",
	"love", "ashley", "6969", "nicole", "chelsea", "biteme", "matthew", "access", "yankees", "987654321", "dallas", "austin",
	"thunder", "taylor", "matrix",
];

const DIGITS = "0123456789";
const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const BASE_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"; // the game's numbers + uppercase letters
const ROMAN = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
/** Prime powers whose product is lcm(1..32): for n <= 32 the game's reply (p % n) % (((n - 1) % 32) + 1) is p % n. */
const MODULI = [32, 27, 25, 7, 11, 13, 17, 19, 23, 29, 31];
const ROMAN_MAX_GUESSES = 40; // a binary search over the game's widest range needs about 17
const MAX_CHARSET = DIGITS.length + LETTERS.length;

/** The largest prime factor of a number given as text ("" when it isn't a positive integer). */
export function largestPrimeFactor(text) {
	let n = Number(String(text ?? "").trim());
	if (!Number.isSafeInteger(n) || n < 2) return "";
	let largest = 1;
	for (let f = 2; f * f <= n; f++) {
		while (n % f === 0) { largest = f; n /= f; }
	}
	return String(n > 1 ? n : largest);
}

/** OrdoXenos: data is "masked;m1 m2 ...", one 8-bit binary mask per character; XOR undoes it. "" if unreadable. */
export function xorDecode(data) {
	const text = String(data ?? "");
	const cut = text.lastIndexOf(";");
	if (cut < 0) return "";
	const masked = [...text.slice(0, cut)];
	const masks = text.slice(cut + 1).trim().split(/\s+/).map((bits) => parseInt(bits, 2));
	if (masks.length !== masked.length || masks.some((mask) => !Number.isInteger(mask))) return "";
	return masked.map((char, i) => String.fromCharCode(char.charCodeAt(0) ^ masks[i])).join("");
}

/** 110100100: data is the password's character codes, 8 binary digits each, space separated. "" if unreadable. */
export function binaryDecode(data) {
	const parts = String(data ?? "").trim().split(/\s+/);
	if (parts.length === 0 || parts.some((bits) => !/^[01]{1,16}$/.test(bits))) return "";
	return parts.map((bits) => String.fromCharCode(parseInt(bits, 2))).join("");
}

/**
 * The game's own expression clean-up (ServerGenerator.ts cleanArithmeticExpression): fancy operator symbols become plain
 * ones, the "ns.exit()," trap is dropped, and anything after the first comma (an injected-code trap) is ignored.
 * The expression is never evaluated as code.
 */
export function cleanExpression(expression) {
	const fixed = String(expression ?? "")
		.replaceAll("ҳ", "*").replaceAll("÷", "/").replaceAll("➕", "+").replaceAll("➖", "-")
		.replaceAll("ns.exit(),", "");
	return fixed.split(",")[0];
}

/**
 * MathML: the value of the hint's expression, worked out the way the game does (ServerGenerator.ts
 * parseSimpleArithmeticExpression: innermost brackets first, then * and / left to right, then + and -), so the
 * rounding matches the password the game stored.
 * @param {string} expression
 * @returns {number}
 */
export function evaluateExpression(expression) {
	const tokens = cleanExpression(expression).split("");
	let currentDepth = 0;
	const depth = tokens.map((token) => {
		if (token === "(") {
			currentDepth += 1;
		} else if (token === ")") {
			currentDepth -= 1;
			return currentDepth + 1;
		}
		return currentDepth;
	});
	const depth1Start = depth.indexOf(1);
	const firstZeroAfter = depth.indexOf(0, depth1Start);
	const depth1End = firstZeroAfter === -1 ? depth.length - 1 : firstZeroAfter - 1;
	if (depth1Start !== -1) {
		const inner = evaluateExpression(tokens.slice(depth1Start + 1, depth1End).join(""));
		tokens.splice(depth1Start, depth1End - depth1Start + 1, inner.toString());
		return evaluateExpression(tokens.join(""));
	}
	let rest = tokens.join("");
	const mulDiv = /(-?\d*\.?\d+) *([*/]) *(-?\d*\.?\d+)/;
	let match = rest.match(mulDiv);
	while (match) {
		const [whole, left, operator, right] = match;
		const value = operator === "*" ? parseFloat(left) * parseFloat(right) : parseFloat(left) / parseFloat(right);
		rest = rest.replace(whole, Math.abs(value) < 0.000001 ? value.toFixed(20) : value.toString());
		match = rest.match(mulDiv);
	}
	const addSub = /(-?\d*\.?\d+) *([+-]) *(-?\d*\.?\d+)/;
	match = rest.match(addSub);
	while (match) {
		const [whole, left, operator, right] = match;
		const value = operator === "+" ? parseFloat(left) + parseFloat(right) : parseFloat(left) - parseFloat(right);
		rest = rest.replace(whole, value.toString());
		match = rest.match(addSub);
	}
	const [, leftover] = rest.match(/(-?\d*\.?\d+)/) ?? ["", ""];
	return parseFloat(leftover);
}

/**
 * OctantVoxel: data is "B,X", the number X written in base B. On harder servers B is fractional (8.5) and X can have a
 * fractional part ("1A2.3"); the game reads it digit by digit times B^place (ServerGenerator.ts parseBaseNNumberString).
 * The password is an integer and the game accepts anything within 0.5%, so the value is rounded. "" if unreadable.
 */
export function baseToDecimal(data) {
	const cut = String(data ?? "").indexOf(",");
	if (cut < 0) return "";
	const base = Number(String(data).slice(0, cut));
	const number = String(data).slice(cut + 1).trim().toUpperCase();
	if (!(base > 1) || !/^[0-9A-Z]+(\.[0-9A-Z]+)?$/.test(number)) return "";
	let place = number.split(".")[0].length - 1;
	let value = 0;
	for (const char of number) {
		if (char === ".") continue;
		value += BASE_DIGITS.indexOf(char) * base ** place;
		place -= 1;
	}
	return Number.isFinite(value) ? String(Math.round(value)) : "";
}

/** A Roman numeral's value (the game writes 0 as "nulla"), or undefined if it isn't one. */
export function romanValue(text) {
	const token = String(text ?? "").trim();
	if (token.toLowerCase() === "nulla") return 0;
	if (!/^[IVXLCDM]+$/i.test(token)) return undefined;
	const values = [...token.toUpperCase()].map((char) => ROMAN[/** @type {keyof typeof ROMAN} */ (char)]);
	let total = 0;
	for (let i = 0; i < values.length; i++) total += values[i] < (values[i + 1] ?? 0) ? -values[i] : values[i];
	return total;
}

/** BellaCuore's range form ("between 'X' and 'Y'", data "X,Y") as { low, high }, or undefined for the single form. */
export function romanRange(data) {
	const parts = String(data ?? "").split(",");
	if (parts.length !== 2) return undefined;
	const [low, high] = parts.map(romanValue);
	return low === undefined || high === undefined ? undefined : { low, high };
}

/**
 * Passwords that follow straight from a model's hint, best first, or [] when the model isn't one of these (or its data
 * can't be read). The caller still checks them against the reported length and format.
 * @param {{ modelId?: string, data?: string, passwordHint?: string }} details
 * @returns {string[]}
 */
export function modelCandidates(details) {
	const data = details.data ?? "";
	switch (details.modelId) {
		case PRIME_MODEL: return nonEmpty(largestPrimeFactor(data || String(details.passwordHint ?? "").match(/(\d+)\s*$/)?.[1]));
		case XOR_MODEL: return nonEmpty(xorDecode(data));
		case BINARY_MODEL: return nonEmpty(binaryDecode(data));
		case EXPRESSION_MODEL: {
			const value = evaluateExpression(data);
			return Number.isFinite(value) ? [String(value)] : [];
		}
		case BASE_MODEL: return nonEmpty(baseToDecimal(data));
		case ROMAN_MODEL: {
			const value = romanValue(data);
			return value === undefined ? [] : [String(value)];
		}
		case EU_MODEL: return [...EU_COUNTRIES];
		case COMMON_MODEL: return [...COMMON_PASSWORDS];
		default: return [];
	}
}

/** @param {string} value */
function nonEmpty(value) {
	return value ? [value] : [];
}

/**
 * Passwords that dropped darknet clue files (".data.txt", written when a cache or a cleared RAM block pays out data) give
 * away. The game writes `Server: <host> Password: "<pw>"` for a nearby server and `Remember this password: <pw>` for an
 * unopened neighbour of the server holding the file (DarkNet/effects/effects.ts addClue).
 * @param {string[]} texts the files' contents
 * @returns {{ byHost: Record<string, string>, loose: string[] }}
 */
export function parseClueFiles(texts) {
	/** @type {Record<string, string>} */
	const byHost = {};
	const loose = [];
	for (const text of texts) {
		const named = String(text ?? "").match(/Server:\s*(\S+)\s+Password:\s*"([^"]*)"/);
		if (named) byHost[named[1]] = named[2];
		const remembered = String(text ?? "").match(/Remember this password:\s*(.*)$/m);
		if (remembered && remembered[1] !== "") loose.push(remembered[1]);
	}
	return { byHost, loose: [...new Set(loose)] };
}

/** The characters a password of this format can use (digits first; the game only adds letters on harder servers). */
export function charsetFor(format) {
	if (format === "numeric") return DIGITS;
	if (format === "alphabetic") return LETTERS;
	return DIGITS + LETTERS;
}

/**
 * BellaCuore's range form. A wrong guess replies "ALTUS NIMIS" (too high) or "PARUM BREVIS" (too low), so a binary search
 * between the two numerals finds it (the game's password lies in the range). Same return shape as the other solvers:
 * { password, attempts } or { later }.
 * @param {NS} ns
 */
export async function solveRomanRange(ns, host, details) {
	const range = romanRange(details.data);
	if (!range) return { password: undefined, attempts: [] };
	let { low, high } = range;
	const attempts = [];
	for (let round = 0; round < ROMAN_MAX_GUESSES && low <= high; round++) {
		const guess = String(Math.floor((low + high) / 2));
		const result = await loginReply(ns, host, guess);
		if (result.verdict === "ok") return { password: guess, attempts: [] };
		if (result.verdict === "later") return { later: result };
		attempts.push({ password: guess, code: result.code, message: result.message, data: result.data });
		const reply = String(result.data ?? "").toUpperCase();
		if (reply.includes("ALTUS")) high = Number(guess) - 1;
		else if (reply.includes("PARUM")) low = Number(guess) + 1;
		else break; // never guess from a reply we can't read
	}
	return { password: undefined, attempts: attempts.slice(-5) };
}

/** Where the first wrong character is, from a 2G_cellular reply ("...checking each character (3)"), or undefined. */
export function mismatchIndex(result) {
	const match = String(result?.message ?? "").match(/character \((-?\d+)\)/);
	return match ? Number(match[1]) : undefined;
}

/**
 * 2G_cellular: a wrong guess says the index of the first character that differs, so each position is found by trying the
 * format's characters there until the index moves past it (at most 10 guesses a digit, 62 with letters).
 * @param {NS} ns
 */
export async function solveTiming(ns, host, details) {
	const length = details.passwordLength;
	if (!(length > 0)) return { password: undefined, attempts: [] };
	const charset = charsetFor(details.passwordFormat);
	const attempts = [];
	let known = "";
	let guesses = 0;
	while (known.length < length && guesses < length * MAX_CHARSET) {
		let advanced = false;
		for (const char of charset) {
			const guess = (known + char).padEnd(length, charset[0]);
			guesses++;
			const result = await loginReply(ns, host, guess);
			if (result.verdict === "ok") return { password: guess, attempts: [] };
			if (result.verdict === "later") return { later: result };
			attempts.push({ password: guess, code: result.code, message: result.message, data: result.data });
			const index = mismatchIndex(result);
			if (index === undefined) return { password: undefined, attempts: attempts.slice(-5) };
			if (index > known.length) {
				known = guess.slice(0, index);
				advanced = true;
				break;
			}
		}
		if (!advanced) break;
	}
	return { password: undefined, attempts: attempts.slice(-5) };
}

/**
 * The number below lcm(moduli) with the given remainders (Chinese remainder theorem, moduli pairwise coprime), as a BigInt.
 * @param {{ modulus: number, remainder: number }[]} parts
 */
export function combineRemainders(parts) {
	let value = 0n;
	let step = 1n;
	for (const { modulus, remainder } of parts) {
		const m = BigInt(modulus);
		const r = BigInt(remainder);
		while (((value % m) + m) % m !== r) value += step;
		step *= m;
	}
	return { value, step };
}

/**
 * Every number of `length` digits (no leading zero) that leaves `value` modulo `step`, smallest first.
 * @param {bigint} value @param {bigint} step @param {number} length
 */
export function numbersOfLength(value, step, length) {
	const low = length <= 1 ? 0n : 10n ** BigInt(length - 1);
	const high = 10n ** BigInt(length);
	const out = [];
	let n = value < low ? value + ((low - value + step - 1n) / step) * step : value;
	for (; n < high; n += step) out.push(String(n));
	return out;
}

/** The remainder a BigMo%od reply gives (data "r", or the message "... = r"), or undefined. */
export function moduloReply(result) {
	const data = String(result?.data ?? "").trim();
	if (/^\d+$/.test(data)) return Number(data);
	const match = String(result?.message ?? "").match(/=\s*(\d+)\s*$/);
	return match ? Number(match[1]) : undefined;
}

/**
 * BigMo%od: a wrong guess n replies (password % n) % (((n - 1) % 32) + 1), which for n <= 32 is just password % n. The
 * remainders for 32, 27, 25 and the primes up to 31 fix the password modulo lcm(1..32) (about 1.4e14), and the reported
 * length leaves at most a handful of numbers to try.
 * @param {NS} ns
 */
export async function solveTripleModulo(ns, host, details) {
	const length = details.passwordLength;
	if (!(length > 0) || details.passwordFormat !== "numeric") return { password: undefined, attempts: [] };
	const attempts = [];
	const parts = [];
	for (const modulus of MODULI) {
		const guess = String(modulus);
		const result = await loginReply(ns, host, guess);
		if (result.verdict === "ok") return { password: guess, attempts: [] };
		if (result.verdict === "later") return { later: result };
		attempts.push({ password: guess, code: result.code, message: result.message, data: result.data });
		const remainder = moduloReply(result);
		if (remainder === undefined) return { password: undefined, attempts: attempts.slice(-5) };
		parts.push({ modulus, remainder });
	}
	const { value, step } = combineRemainders(parts);
	for (const guess of numbersOfLength(value, step, length)) {
		const result = await loginReply(ns, host, guess);
		if (result.verdict === "ok") return { password: guess, attempts: [] };
		if (result.verdict === "later") return { later: result };
		attempts.push({ password: guess, code: result.code, message: result.message, data: result.data });
	}
	return { password: undefined, attempts: attempts.slice(-5) };
}
