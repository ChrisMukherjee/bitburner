// regression: AccountsManager_4.2 ("a number between 0 and N") was never enumerated, so a 0-100 server stayed unsolved
// after a few reused passwords. The password has length L and lies in 10^(L-1)..10^L-1 (game: ServerGenerator getGuessNumberConfig).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { solveNumberGuess, guessNumberRange } from "/darknet/feedback-solvers.js";

function nsFor(password, hints) {
	const tried = [];
	const ns = fakeNs({ overrides: { dnet: { authenticate: async (_h, guess) => {
		tried.push(guess);
		if (guess === password) return { success: true, code: 200 };
		return { success: false, code: 401, message: hints ? (Number(guess) < Number(password) ? "Higher" : "Lower") : "Unauthorized" };
	} } } });
	return { ns, tried };
}

test("regression: range follows the password length (0-100 hint means 10..99)", () => {
	assert.deepEqual(guessNumberRange({ passwordLength: 2 }), { low: 10, high: 99 });
	assert.deepEqual(guessNumberRange({ passwordLength: 1 }), { low: 0, high: 9 });
	assert.deepEqual(guessNumberRange({ passwordHint: "The password is a number between 0 and 100" }), { low: 0, high: 99 });
});

test("regression: finds every 2-digit password without repeating a guess", async () => {
	for (let n = 10; n <= 99; n++) {
		const { ns, tried } = nsFor(String(n), false);
		const result = await solveNumberGuess(ns, "h", { passwordLength: 2 });
		assert.equal(result.password, String(n));
		assert.equal(new Set(tried).size, tried.length, "no repeated guess");
		assert.ok(tried.length <= 90, "at most the size of the range");
	}
});

test("known-wrong guesses from the log are skipped", async () => {
	const { ns, tried } = nsFor("57", false);
	await solveNumberGuess(ns, "h", { passwordLength: 2 }, new Set(["10", "11"]));
	assert.ok(!tried.includes("10") && !tried.includes("11"));
});

test("higher/lower replies turn it into a binary-style search", async () => {
	const { ns, tried } = nsFor("73", true);
	const result = await solveNumberGuess(ns, "h", { passwordLength: 2 });
	assert.equal(result.password, "73");
	assert.ok(tried.length <= 20, "far fewer than a linear scan when the game gives direction");
});
