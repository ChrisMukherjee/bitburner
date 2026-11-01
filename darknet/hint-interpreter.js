// Interprets a Bitburner darknet server's in-game "hint" to work out its password.
// This is a game puzzle: the hint either states the password, says there is none, names a default, or
// describes a small transform of the server's Data field (strip to digits, convert a number's base, etc.).
// Pure functions, no ns calls, so importing this is free. The caller tries the candidates in order.

const DEFAULTS = ["admin", "password", "0000", "12345"];

const DOG_NAMES = ["fido", "spot", "rover", "max", "laika"];

const FORMAT_PATTERNS = {
	numeric: /^[0-9]*$/,
	alphabetic: /^[a-zA-Z]*$/,
	alphanumeric: /^[a-zA-Z0-9]*$/,
};

/** True if a candidate matches the length and character set the server reports. Empty is only valid at length 0. */
function fitsDetails(candidate, details) {
	if (details.passwordLength > 0 && candidate.length !== details.passwordLength) return false;
	if (details.passwordLength === 0 && candidate !== "") return false;
	const pattern = FORMAT_PATTERNS[details.passwordFormat];
	return !pattern || pattern.test(candidate);
}

/** Strings inside quotes or backticks; usually the literal a "stated" hint is quoting. */
function quotedStrings(text) {
	const found = [];
	for (const match of String(text ?? "").matchAll(/["'`]([^"'`]+)["'`]/g)) found.push(match[1]);
	return found;
}

/** Runs of digits in a piece of text, e.g. "base 8 number 702" -> ["8", "702"]. */
function numberRuns(text) {
	return (String(text ?? "").match(/\d+/g) ?? []);
}

/** Bases a hint asks for, by name or "base N"; ordered so the most explicit comes first. */
function basesFrom(hint) {
	const lower = String(hint ?? "").toLowerCase();
	const bases = [];
	for (const match of lower.matchAll(/base\s*(\d+)/g)) bases.push(Number(match[1]));
	if (/\b(octal)\b/.test(lower)) bases.push(8);
	if (/\b(hex|hexadecimal)\b/.test(lower)) bases.push(16);
	if (/\b(binary)\b/.test(lower)) bases.push(2);
	return [...new Set(bases)].filter((base) => base >= 2 && base <= 36);
}

/**
 * Candidate passwords derived from the Data field and the hint, best guess first. Covers the transforms
 * we've seen: keep only digits, keep only letters/alphanumerics, and reverse. The data itself is included
 * last as a fallback. Base conversions have their own shape (convertBase).
 */
function dataCandidates(details) {
	const data = String(details.data ?? "");
	const digits = (data.match(/\d/g) ?? []).join("");
	const letters = (data.match(/[a-zA-Z]/g) ?? []).join("");
	const alnum = (data.match(/[a-zA-Z0-9]/g) ?? []).join("");
	const out = [];

	// "prove you are human" / "write the numbers" style: just the digits (and their reverse).
	if (digits) out.push(digits, [...digits].reverse().join(""));
	if (letters) out.push(letters);
	if (alnum && alnum !== digits && alnum !== letters) out.push(alnum);

	out.push(data.trim(), data);
	return out;
}

/**
 * "the base 8 number 702 in base 10" (Data "8,702"): converts the number from the first base the hint
 * names into the "in base N" one (default 10). The number is the last numeral in Data valid in that
 * base (Data may list the base first), falling back to the hint. Returns null if nothing fits.
 */
function convertBase(details) {
	const hint = String(details.passwordHint ?? "").toLowerCase();
	const toMatch = hint.match(/in base\s*(\d+)/);
	const toBase = toMatch ? Number(toMatch[1]) : 10;
	const fromBase = basesFrom(hint).find((base) => !toMatch || base !== toBase);
	if (!fromBase) return null;

	const validIn = (text) => (String(text ?? "").match(/[0-9a-z]+/gi) ?? []).filter((n) => isValidInBase(n, fromBase));
	const numeral = validIn(details.data).pop() ?? validIn(hint.replace(/base\s*\d+/g, "")).pop();
	if (!numeral) return null;
	return parseInt(numeral, fromBase).toString(toBase);
}

const ROMAN_VALUES = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };

/** A Roman-numeral token from the hint's quotes or the Data field, or null. e.g. "CLIII". */
function romanToken(details) {
	const candidates = [...quotedStrings(details.passwordHint), String(details.data ?? "").trim()];
	return candidates.find((text) => text !== "" && /^[ivxlcdm]+$/i.test(text)) ?? null;
}

/** Reads a Roman numeral ("CLIII") as its value ("153"), or null if it isn't one. */
function convertRoman(details) {
	const token = romanToken(details);
	if (!token) return null;
	const digits = [...token.toLowerCase()].map((char) => ROMAN_VALUES[char]);
	let total = 0;
	for (let i = 0; i < digits.length; i++) {
		total += digits[i] < (digits[i + 1] ?? 0) ? -digits[i] : digits[i];
	}
	return String(total);
}

/** True if every character of a numeral is a legal digit in the given base (so "8" is not base-8). */
function isValidInBase(numeral, base) {
	for (const char of numeral.toLowerCase()) {
		const digit = parseInt(char, 36);
		if (!(digit >= 0 && digit < base)) return false;
	}
	return numeral.length > 0;
}

/** Which of the hint shapes this looks like, used for logging and to order the candidates. */
export function classifyHint(details) {
	const hint = String(details.passwordHint ?? "").toLowerCase();
	if (/no password|blank|empty|unprotected|not set|none/.test(hint)) return "none";
	if (/default|factory|usual|common|standard/.test(hint)) return "default";
	if (/dog/.test(hint)) return "dog";
	if (/\bbase\s*\d+|\boctal\b|\bhex(adecimal)?\b|\bbinary\b/.test(hint)) return "base";
	if (/\broman\b|\bnumeral\b/.test(hint) || romanToken(details)) return "roman";
	if (String(details.data ?? "").trim() !== "") return "data";
	if (quotedStrings(details.passwordHint).length > 0 || numberRuns(details.passwordHint).length > 0) return "stated";
	return "unknown";
}

/**
 * Ordered password candidates for a server, best guess first, filtered to the reported length and format.
 *   dataTransform - optional fn(dataString, details) -> string|string[] to try first for "data" hints.
 */
export function candidatePasswords(details, dataTransform) {
	const shape = classifyHint(details);
	const raw = [];

	if (shape === "none") raw.push("");
	if (shape === "default") raw.push(...DEFAULTS);
	if (shape === "dog") raw.push(...DOG_NAMES);
	if (shape === "base") raw.push(convertBase(details) ?? "");
	if (shape === "roman") raw.push(convertRoman(details) ?? "");
	// "The password is 362" / "Remember to use 949": the hint states it, quoted or not.
	if (shape === "stated") raw.push(...quotedStrings(details.passwordHint), ...numberRuns(details.passwordHint));
	if (shape === "data") {
		if (dataTransform) {
			const out = dataTransform(String(details.data ?? ""), details);
			raw.push(...(Array.isArray(out) ? out : [out]));
		}
		raw.push(...dataCandidates(details));
	}

	// Cheap fallbacks that are sometimes right whatever the shape.
	raw.push("", String(details.data ?? ""), ...quotedStrings(details.passwordHint), ...DEFAULTS);

	const candidates = [];
	const seen = new Set();
	for (const candidate of raw) {
		const value = String(candidate ?? "");
		if (seen.has(value)) continue;
		seen.add(value);
		if (fitsDetails(value, details)) candidates.push(value);
	}
	return { shape, candidates };
}
