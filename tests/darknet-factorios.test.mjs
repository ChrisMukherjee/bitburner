// Factori-Os solver (darknet/feedback-solvers.js solveDivisibility): candidates respect the password length and the
// hint's divisor. Regression: a 2-digit password made the solver try 4-digit primes like 3881.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { solveDivisibility, hintDivisor } from "/darknet/feedback-solvers.js";

function serverNs(password, tried) {
	return fakeNs({ overrides: { dnet: { authenticate: async (host, guess) => {
		tried.push(Number(guess));
		if (Number(guess) === password) return { success: true, code: 200 };
		return { success: false, code: 401, message: "no", data: String(password % Number(guess) === 0) };
	} } } });
}

test("a 2-digit password is found without ever trying more than 2 digits", async () => {
	for (const password of [1, 2, 12, 36, 64, 77, 97, 99]) {
		const tried = [];
		const result = await solveDivisibility(serverNs(password, tried), "h", { passwordLength: 2, passwordHint: "The password is divisible by 1 ;)" });
		assert.equal(result.password, String(password));
		assert.ok(tried.every((value) => value <= 99), `tried ${tried.filter((value) => value > 99)}`);
	}
});

test("the hint divisor is the starting factor", async () => {
	const tried = [];
	const result = await solveDivisibility(serverNs(3571, tried), "h", { passwordLength: 4, passwordHint: "The password is divisible by 3571 ;)" });
	assert.equal(result.password, "3571");
	assert.equal(tried.length, 1);
});

test("without details it still finds a large-prime password", async () => {
	const result = await solveDivisibility(serverNs(2 * 3881, []), "h");
	assert.equal(result.password, String(2 * 3881));
});

test("hintDivisor", () => {
	assert.equal(hintDivisor("The password is divisible by 12 ;)"), 12);
	assert.equal(hintDivisor("something else"), 1);
});
