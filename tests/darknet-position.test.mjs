// DeepGreen past 6 digits or with letters, and PHP 5.4 from 5 characters (darknet/position-solvers.js). Replies follow the
// game (bitburner-src v3.0.1): DarkNet/effects/authentication.ts checkPassword and DarkNet/utils/darknetAuthUtils.ts.
// Regression: both stayed unsolved. DeepGreen's solver listed every candidate, so it gave up past 10^6 (over 6 digits, or any
// letters), and PHP 5.4 tried at most 720 anagrams, so a 7 to 9 digit password was rarely reached.
import { test } from "node:test";
import assert from "node:assert/strict";
import { darknetServer } from "./support/fake-darknet.mjs";
import { mastermindScore, solveMastermind } from "/darknet/feedback-solvers.js";
import {
	FILLER, SORTED_ECHO_MIN_LENGTH, arrangements, findCode, mastermindAlphabet, parseRmsReply, solveMastermindLong, solveSortedEcho, squaredError,
} from "/darknet/position-solvers.js";
import { crack } from "/darknet/crawler.js";
import { CRAWLER_FILES } from "/darknet/config.js";

// The game's Mastermind counts (darknetAuthUtils.ts getExactCorrectCharsCount, getMisplacedCorrectCharsCount), copied.
function gameMastermind(password, attempted) {
	const exact = password.split("").filter((c, i) => c === attempted[i]).length;
	const restPassword = password.split("").filter((c, i) => c !== attempted[i]);
	const restAttempt = attempted.split("").filter((c, i) => c !== password[i]);
	const misplaced = restAttempt.filter((c, i) => restPassword.includes(c)
		&& restAttempt.slice(0, i).filter((p) => p === c).length < restPassword.filter((p) => p === c).length).length;
	return { exact, misplaced };
}
// authentication.ts, the MastermindHint case.
const deepGreen = (password, guess) => {
	const { exact, misplaced } = gameMastermind(password, guess);
	return { message: `Hint: ${exact} symbols are match exactly,  and ${misplaced} symbols match but are in the wrong place.`, data: `${exact},${misplaced}` };
};
// authentication.ts, the SortedEchoVuln case.
const phpEcho = (password, guess) => {
	const sorted = password.split("").sort().join("");
	const plain = { message: `The PIN uses ${sorted}`, data: sorted };
	if (password.length < 5 || guess.length !== password.length) return plain;
	let error = 0;
	for (let i = 0; i < guess.length; i++) {
		const a = Number(guess[i]);
		if (!Number.isFinite(a)) return plain;
		error += (a - Number(password[i])) ** 2;
	}
	return { ...plain, data: `${sorted}; RMS Deviation:${Math.sqrt(error / guess.length).toFixed(3)}` };
};

/** A seeded random, so the PHP 5.4 picks are repeatable. */
function seeded(seed) {
	return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
}

test("game: mastermindScore counts exact and misplaced symbols the way the game does, repeats included", () => {
	const random = seeded(7);
	const pick = (n) => Array.from({ length: n }, () => "aab01Z"[Math.floor(random() * 6)]).join("");
	for (let i = 0; i < 500; i++) {
		const password = pick(6), guess = pick(6);
		const [exact, misplaced] = mastermindScore(guess, password);
		assert.deepEqual({ exact, misplaced }, gameMastermind(password, guess), `${guess} against ${password}`);
	}
});

test("game: DeepGreen codes with letters or past 6 digits open, guessing only the reported length", async () => {
	// getMastermindHintConfig: numeric up to 10 digits; from difficulty 17, 30% are alphanumeric, also up to 10.
	for (const [password, format] of [["7305918264", "numeric"], ["4400917", "numeric"], ["q7Ze0Ka9pP", "alphanumeric"], ["xYz", "alphabetic"], ["aaBbaa", "alphabetic"], ["0a0", "alphanumeric"]]) {
		const { ns, tried } = darknetServer(password, deepGreen);
		const result = await solveMastermindLong(ns, "h", { passwordLength: password.length, passwordFormat: format });
		assert.equal(result.password, password);
		assert.ok(tried.every((guess) => guess.length === password.length), "every guess has the password's length");
		const symbols = mastermindAlphabet(format).length;
		// Finding the symbols costs at most one guess per symbol, placing them at most one per position and halving step.
		assert.ok(tried.length <= symbols + password.length * Math.ceil(Math.log2(password.length) + 1) + 1, `${password}: ${tried.length} guesses`);
	}
});

test("regression: the old DeepGreen solver gives up on these, the new one is what the crawler asks", async () => {
	const long = { modelId: "DeepGreen", passwordHint: "Only a true master may pass", data: "", passwordLength: 8, passwordFormat: "numeric" };
	const lettered = { ...long, passwordLength: 4, passwordFormat: "alphanumeric" };
	for (const [details, password] of [[long, "52817734"], [lettered, "b4Q4"]]) {
		const old = darknetServer(password, deepGreen);
		assert.equal((await solveMastermind(old.ns, "h", details)).password, undefined, "too many candidates to list");
		const { ns } = darknetServer(password, deepGreen);
		assert.equal((await crack(ns, "h", details, {})).password, password);
	}
});

test("a reply already in the server's log or the history file is not asked again", async () => {
	const password = "K9m2Qx";
	const first = darknetServer(password, deepGreen);
	await solveMastermindLong(first.ns, "h", { passwordLength: 6, passwordFormat: "alphanumeric" });
	const observed = first.tried.slice(0, -1).map((guess) => ({ guess, ...gameMastermind(password, guess) }));
	const second = darknetServer(password, deepGreen);
	const result = await solveMastermindLong(second.ns, "h", { passwordLength: 6, passwordFormat: "alphanumeric" }, observed);
	assert.equal(result.password, password);
	assert.deepEqual(second.tried, [password], "only the answer is sent");
	const history = first.ns.read("data/darknet-solver-history.txt");
	const third = darknetServer(password, deepGreen, { files: { "data/darknet-solver-history.txt": history } });
	assert.equal((await solveMastermindLong(third.ns, "h", { passwordLength: 6, passwordFormat: "alphanumeric" })).password, password);
	assert.deepEqual(third.tried, [password], "a restarted crawler picks up the saved replies");
});

test("digits are counted only until the counts fill the code", async () => {
	const { ns, tried } = darknetServer("1121112", deepGreen);
	assert.equal((await solveMastermindLong(ns, "h", { passwordLength: 7, passwordFormat: "numeric" })).password, "1121112");
	assert.ok(!tried.includes("3333333"), "0, 1 and 2 already account for all 7 digits");
});

test("findCode stops when the replies stop, and the filler is never part of a code", async () => {
	assert.equal(await findCode(4, "0123456789", async () => undefined), undefined);
	assert.ok(!mastermindAlphabet("alphanumeric").includes(FILLER));
	const { ns } = darknetServer("12345678", () => ({ message: "garbled" }));
	const result = await solveMastermindLong(ns, "h", { passwordLength: 8, passwordFormat: "numeric" });
	assert.equal(result.password, undefined, "an unreadable reply stops the solver");
	assert.equal(result.attempts.length, 1);
});

test("game: PHP 5.4 passwords are arrangements of Data with no leading zero (getPassword stores Number(password))", () => {
	assert.deepEqual(arrangements("012"), ["102", "120", "201", "210"]);
	assert.equal(arrangements("112233445").length, 362880 / 2 ** 4, "9! over 2! for each of the four doubled digits");
	assert.equal(new Set(arrangements("0012345")).size, arrangements("0012345").length);
	assert.ok(arrangements("0012345").every((code) => code[0] !== "0"));
	assert.deepEqual(arrangements("0"), ["0"]);
});

test("game: the RMS deviation gives back the sum of squared differences", () => {
	const password = "908172635", guess = "123456789";
	const reply = phpEcho(password, guess).data;
	assert.equal(parseRmsReply(reply, password.length), squaredError(guess, password));
	assert.equal(parseRmsReply("0123", 4), undefined, "no deviation in the reply");
});

test("game: PHP 5.4 from 5 digits opens from its RMS replies in a few guesses", async () => {
	for (const password of ["908172635", "4405913", "10000", "98765"]) {
		const { ns, tried } = darknetServer(password, phpEcho);
		ns.sleep = async () => {};
		const sorted = password.split("").sort().join("");
		const result = await solveSortedEcho(ns, "h", { data: sorted, passwordLength: password.length }, seeded(3));
		assert.equal(result.password, password);
		assert.ok(tried.length <= 8, `${password}: ${tried.length} guesses (9 digits average about 4 in the game's own servers)`);
	}
});

test("PHP 5.4 below 5 digits is left to the anagrams, and the crawler sends longer ones here", async () => {
	const short = darknetServer("4312", phpEcho);
	assert.equal((await solveSortedEcho(short.ns, "h", { data: "1234", passwordLength: 4 })).password, undefined);
	assert.equal(short.tried.length, 0, "no guess without a deviation to read");
	assert.equal(SORTED_ECHO_MIN_LENGTH, 5);
	const password = "73019264";
	const { ns, tried } = darknetServer(password, phpEcho);
	ns.sleep = async () => {};
	const sorted = password.split("").sort().join("");
	const details = { modelId: "PHP 5.4", passwordHint: `The PIN uses ${sorted}`, data: sorted, passwordLength: 8, passwordFormat: "numeric" };
	assert.equal((await crack(ns, "h", details, {})).password, password);
	assert.ok(tried.length <= 10, `${tried.length} guesses, not thousands of anagrams`);
});

test("the crawler copies the new solver with it", () => {
	assert.ok(CRAWLER_FILES.includes("darknet/position-solvers.js"));
});
