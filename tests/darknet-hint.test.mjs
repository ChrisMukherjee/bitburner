// PHP 5.4 darknet model: Data is the password with its characters sorted (darknet/hint-interpreter.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { anagrams, candidatePasswords } from "/darknet/hint-interpreter.js";

test("anagrams lists distinct arrangements in order", () => {
	assert.deepEqual(anagrams("558"), ["558", "585", "855"]);
	assert.deepEqual(anagrams("123").length, 6);
	assert.deepEqual(anagrams("ab"), ["ab", "ba"]);
});

test("anagrams stops at the limit", () => {
	assert.equal(anagrams("123456789", 50).length, 50);
});

test("PHP 5.4 candidates are the anagrams of Data", () => {
	const details = { modelId: "PHP 5.4", data: "558", passwordHint: "The key is made from 558", passwordLength: 3, passwordFormat: "numeric" };
	const { candidates } = candidatePasswords(details);
	assert.deepEqual(candidates.slice(0, 3), ["558", "585", "855"]);
});
