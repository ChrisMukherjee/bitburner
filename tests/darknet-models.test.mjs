// Darknet models solved in darknet/model-solvers.js. Hints, data and replies are the game's (bitburner-src v3.0.1,
// DarkNet/controllers/ServerGenerator.ts builds each model's password and hint; DarkNet/effects/authentication.ts replies).
// Regression: PrimeTime 2, OrdoXenos, 110100100, MathML, EuroZone Free, TopPass, 2G_cellular and BigMo%od had no solver,
// OctantVoxel's fractional bases and BellaCuore's "nulla" and range form were misread, so those servers stayed unsolved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { darknetServer } from "./support/fake-darknet.mjs";
import { fitsDetails } from "/darknet/hint-interpreter.js";
import { CRAWLER_FILES } from "/darknet/config.js";
import {
	modelCandidates, largestPrimeFactor, xorDecode, binaryDecode, evaluateExpression, baseToDecimal, romanValue, romanRange,
	parseClueFiles, solveRomanRange, solveTiming, solveTripleModulo, combineRemainders, numbersOfLength, EU_COUNTRIES, COMMON_PASSWORDS,
} from "/darknet/model-solvers.js";
import fs from "node:fs";

const fits = (details) => modelCandidates(details).filter((candidate) => fitsDetails(candidate, details));

test("game: PrimeTime 2's password is the largest prime factor of the hint's number", () => {
	// getLargestPrimeFactorPassword: one large prime times up to six small ones.
	const target = 9859 * 2 * 97 * 3 * 3;
	assert.equal(largestPrimeFactor(String(target)), "9859");
	const details = { modelId: "PrimeTime 2", data: String(target), passwordHint: `The password is the largest prime factor of ${target}`, passwordLength: 4, passwordFormat: "numeric" };
	assert.deepEqual(fits(details), ["9859"]);
	assert.equal(largestPrimeFactor("1"), "", "no prime factor");
});

test("game: OrdoXenos XORs each character with its mask (data 'masked;masks')", () => {
	// Taken from the game's generator: password 8NXw9.
	assert.equal(xorDecode("=EKk%;00000101 00001011 00010011 00011100 00011100"), "8NXw9");
	assert.equal(xorDecode("abc;00000001"), "", "mask count must match");
});

test("game: 110100100 lists the password's character codes in 8-bit binary", () => {
	const password = "a9Z";
	const data = [...password].map((c) => c.charCodeAt(0).toString(2).padStart(8, "0")).join(" ");
	assert.equal(binaryDecode(data), password);
	assert.deepEqual(fits({ modelId: "110100100", data, passwordLength: 3, passwordFormat: "alphanumeric" }), [password]);
});

test("game: MathML evaluates like the game, symbols, brackets and traps included", () => {
	// From the game's generator at difficulty 25; the stored password is the parser's own output.
	assert.equal(String(evaluateExpression("47 ÷ ( 56 ➖ 49 ҳ 85 ҳ 14 ) ҳ 31 ➖ 14 ➕ ( 96 ➕ 58 ➕ 55 ➕ 21 ) ➕ 91 ҳ 68 ➕ 24 ➖ 6")), "6421.974988841968");
	assert.equal(evaluateExpression("4 + 5 * ( 6 + 7 ) / 2"), 36.5, "brackets first, then * and /, then + and -");
	assert.equal(evaluateExpression("3 + 4 , !globalThis.pwn3d && (globalThis.pwn3d=true) , ns.exit()"), 7, "injected code after a comma is ignored");
	assert.equal(evaluateExpression("(ns.exit(),2 + 3) * 4"), 20, "the ns.exit() trap is dropped");
});

test("game: OctantVoxel reads fractional bases and digits the way the game writes them", () => {
	assert.equal(baseToDecimal("16.3,590.DDF"), "1476", "from the game's generator at difficulty 20");
	assert.equal(baseToDecimal("8,702"), "450");
	assert.equal(baseToDecimal("2,1111"), "15");
	assert.equal(baseToDecimal("nonsense"), "");
});

test("game: BellaCuore numerals, 'nulla' for zero, and the range form", () => {
	assert.equal(romanValue("CLIII"), 153);
	assert.equal(romanValue("nulla"), 0, "the game's encoder writes 0 as nulla");
	assert.equal(romanValue("abc"), undefined);
	assert.deepEqual(fits({ modelId: "BellaCuore", data: "nulla", passwordLength: 1, passwordFormat: "numeric" }), ["0"]);
	assert.deepEqual(romanRange("nulla,CCX"), { low: 0, high: 210 });
	assert.equal(romanRange("CCX"), undefined, "a single numeral is not a range");
});

test("game: EuroZone Free and TopPass guess the game's lists, cut to the reported length", () => {
	const eu = fits({ modelId: "EuroZone Free", passwordLength: 5, passwordFormat: "alphabetic" });
	assert.deepEqual(eu, EU_COUNTRIES.filter((c) => c.length === 5));
	assert.ok(eu.includes("Spain"));
	const common = fits({ modelId: "TopPass", passwordLength: 6, passwordFormat: "numeric" });
	assert.ok(common.includes("123456") && common.every((p) => /^\d{6}$/.test(p)));
	assert.equal(COMMON_PASSWORDS.length, 93, "the game's list has 93 entries");
	assert.equal(EU_COUNTRIES.length, 27, "the EU's 27 members");
});

test("other models give no candidates here", () => {
	assert.deepEqual(modelCandidates({ modelId: "DeepGreen", data: "" }), []);
});

test("game: clue files name a server's password or a neighbour's", () => {
	const clues = parseClueFiles([
		'Server: dark-node_7 Password: "4471"',
		"Remember this password: hunter",
		"The password for x contains 1 and 2",
		"Some common passwords include 123456, password",
	]);
	assert.deepEqual(clues.byHost, { "dark-node_7": "4471" });
	assert.deepEqual(clues.loose, ["hunter"]);
});

test("BellaCuore's range form is a binary search on ALTUS NIMIS / PARUM BREVIS", async () => {
	const { ns, tried } = darknetServer("137", (password, guess) => ({
		message: "The password is between 'CX' and 'CCX'", data: Number(guess) > Number(password) ? "ALTUS NIMIS" : "PARUM BREVIS",
	}));
	const result = await solveRomanRange(ns, "h", { data: "CX,CCX", passwordLength: 3 });
	assert.equal(result.password, "137");
	assert.ok(tried.length <= Math.ceil(Math.log2(101)) + 1, `binary search over 101 numbers, got ${tried.length}`);
});

test("2G_cellular is found character by character from the mismatch index", async () => {
	const timing = (password, guess) => ({
		message: `Found a mismatch while checking each character (${[...password].findIndex((c, i) => c !== guess[i])})`,
		data: "Response time: 0ms",
	});
	for (const [password, format, set] of [["40817", "numeric", 10], ["aZ9k", "alphanumeric", 62]]) {
		const { ns, tried } = darknetServer(password, timing);
		const result = await solveTiming(ns, "h", { passwordLength: password.length, passwordFormat: format });
		assert.equal(result.password, password);
		assert.ok(tried.length <= password.length * set, `at most one pass of the set per character, got ${tried.length}`);
	}
});

test("game: BigMo%od is fixed by its remainders for 32, 27, 25 and the primes to 31", async () => {
	// authentication.ts: (password % n) % (((n - 1) % 32) + 1), and the message "... = r".
	const modulo = (password, guess) => {
		const p = Number(password), n = Number(guess);
		const r = (p % n) % (((n - 1) % 32) + 1);
		return { message: `(Password % ${n}) % (${n} % 32) = ${r}`, data: String(r) };
	};
	for (const password of ["7", "4821", "987654321098765", "100000000000000"]) {
		const { ns, tried } = darknetServer(password, modulo);
		const result = await solveTripleModulo(ns, "h", { passwordLength: password.length, passwordFormat: "numeric" });
		assert.equal(result.password, password);
		assert.ok(tried.length <= 11 + 7, `11 remainders, then at most 7 numbers of that length, got ${tried.length}`);
	}
	const { value, step } = combineRemainders([{ modulus: 4, remainder: 3 }, { modulus: 5, remainder: 1 }]);
	assert.equal(value, 11n);
	assert.equal(step, 20n);
	assert.deepEqual(numbersOfLength(11n, 20n, 2), ["11", "31", "51", "71", "91"]);
});

test("regression: every darknet module the crawler imports is copied with it", () => {
	const seen = new Set();
	const queue = ["darknet/crawler.js"];
	while (queue.length) {
		const file = queue.pop();
		if (seen.has(file)) continue;
		seen.add(file);
		const text = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
		for (const [, path] of text.matchAll(/from\s+"\/?(darknet\/[\w-]+\.js)"/g)) queue.push(path);
	}
	for (const file of seen) assert.ok(CRAWLER_FILES.includes(file), `${file} is imported by the crawler but not in CRAWLER_FILES`);
});
