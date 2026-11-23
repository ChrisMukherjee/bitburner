// NIL ("Yesn_t", hint "you are one who's'nt authorized") solver in darknet/feedback-solvers.js, against a copy of the game's
// reply (bitburner-src DarkNet/effects/authentication.ts): data is "yes"/"yesn't" per character sent, comma separated.
// Regression: there was no NIL solver, so the server stayed unsolved after reusing other servers' 5-digit passwords.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { solveNil, nilYesPositions, nilCharset } from "/darknet/feedback-solvers.js";

function nilServer(password) {
	const tried = [];
	const ns = fakeNs({ overrides: { dnet: { authenticate: async (_h, guess) => {
		tried.push(guess);
		if (guess === password) return { success: true, code: 200 };
		const data = guess.split("").map((c, i) => (c === password[i] ? "yes" : "yesn't")).join(",");
		return { success: false, code: 401, message: "that wasn't right", data };
	} } } });
	return { ns, tried };
}

test("regression: solves a numeric NIL password of known length in at most 10 guesses", async () => {
	for (const password of ["12345", "90817", "7", "300", "2500000"]) {
		const { ns, tried } = nilServer(password);
		const result = await solveNil(ns, "h", { passwordLength: password.length, passwordFormat: "numeric" });
		assert.equal(result.password, password);
		assert.ok(tried.length <= 10, `one guess per digit at most, got ${tried.length}`);
	}
});

test("solves an alphanumeric password with mixed case", async () => {
	const { ns, tried } = nilServer("aZ9kQ");
	const result = await solveNil(ns, "h", { passwordLength: 5, passwordFormat: "alphanumeric" });
	assert.equal(result.password, "aZ9kQ");
	assert.ok(tried.length <= 62, "one guess per character of the set at most");
});

test("unknown length: finds it from the positions that never say yes", async () => {
	const { ns } = nilServer("40817");
	const result = await solveNil(ns, "h", {});
	assert.equal(result.password, "40817");
});

test("an unreadable reply stops the solver instead of guessing", async () => {
	const ns = fakeNs({ overrides: { dnet: { authenticate: async () => ({ success: false, code: 401, data: "???" }) } } });
	const result = await solveNil(ns, "h", { passwordLength: 4, passwordFormat: "numeric" });
	assert.equal(result.password, undefined);
	assert.equal(result.attempts.length, 1);
});

test("a timeout or moved server is retried later, not marked unsolvable", async () => {
	const ns = fakeNs({ overrides: { dnet: { authenticate: async () => ({ success: false, code: 351 }) } } });
	const result = await solveNil(ns, "h", { passwordLength: 4, passwordFormat: "numeric" });
	assert.ok(result.later);
});

test("reply parsing and character sets", () => {
	assert.deepEqual(nilYesPositions({ data: "yes,yesn't,yes" }, 3), [0, 2]);
	assert.equal(nilYesPositions({ data: "yes,yesn't" }, 3), undefined);
	assert.equal(nilYesPositions({}, 3), undefined);
	assert.equal(nilCharset({ passwordFormat: "numeric" }), "0123456789");
	assert.ok(nilCharset({}).length === 62);
});
