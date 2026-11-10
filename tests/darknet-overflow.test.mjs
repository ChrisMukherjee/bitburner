// Pr0verFl0 (buffer overflow) solver in darknet/feedback-solvers.js, checked against a copy of the game's rule
// (bitburner-src DarkNet/effects/authentication.ts, case BufferOverflow).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { overflowGuess, overflowLength, solveOverflow } from "/darknet/feedback-solvers.js";

/** The game's check: the guess overwrites a buffer of `n` blanks + `n` mask chars; it passes when the halves match. */
function gameAccepts(password, attempted) {
	if (attempted === password) return true;
	const mask = attempted === "■".repeat(password.length) ? "?" : "■";
	const buffer = "ˍ".repeat(password.length) + mask.repeat(password.length);
	const over = attempted.slice(0, buffer.length) + buffer.slice(attempted.length);
	return over.slice(0, password.length) === over.slice(password.length);
}
function nsFor(password) {
	const tried = [];
	const ns = fakeNs({ overrides: { dnet: { authenticate: async (_host, guess) => {
		tried.push(guess);
		return gameAccepts(password, guess) ? { success: true, code: 200 } : { success: false, code: 401, message: "no" };
	} } } });
	return { ns, tried };
}

test("game: overflow guess opens every buffer length the game builds", () => {
	for (let length = 4; length <= 7; length++) assert.ok(gameAccepts("x".repeat(length), overflowGuess(length)));
});

test("length comes from the details, else from the hint text", () => {
	assert.equal(overflowLength({ passwordLength: 4 }), 4);
	assert.equal(overflowLength({ passwordHint: "Warning: password buffer is 6 bytes" }), 6);
	assert.equal(overflowLength({ passwordHint: "something else" }), undefined);
});

test("solveOverflow logs in with one guess when the length is known", async () => {
	const { ns, tried } = nsFor("qwer");
	const result = await solveOverflow(ns, "hydro:services", { passwordLength: 4 });
	assert.equal(result.password, "aaaaaaaa");
	assert.equal(tried.length, 1);
});

test("solveOverflow tries each game length when it cannot tell", async () => {
	const { ns, tried } = nsFor("abcdef");
	const result = await solveOverflow(ns, "h", { passwordHint: "" });
	assert.equal(result.password, "a".repeat(12));
	assert.equal(tried.length, 3);
});
