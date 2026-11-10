// The test tools themselves: tests/support/changed-tests.mjs (what the change report lists) and
// tests/support/mutate.mjs (the mutation check).
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitTests, kindOf, compareTests } from "./support/changed-tests.mjs";
import { mutationSites, applyMutation, sample } from "./support/mutate.mjs";

const FILE = [
	"const fixture = 1;",
	"",
	'test("rule one", () => {',
	"\tassert.equal(f(1), 2);",
	"});",
	"",
	'test("regression: bug two", () => {',
	"\tassert.ok(g());",
	"});",
].join("\n");

test("splitTests finds each top-level test and keeps the code outside them apart", () => {
	const { tests, outside } = splitTests(FILE);
	assert.deepEqual([...tests.keys()], ["rule one", "regression: bug two"]);
	assert.match(tests.get("rule one"), /f\(1\), 2/);
	assert.equal(outside, "const fixture = 1;");
});

test("kindOf reads the tag at the start of the name; untagged tests are rules", () => {
	assert.equal(kindOf("regression: x"), "regression");
	assert.equal(kindOf("game: x"), "game");
	assert.equal(kindOf("choice: x"), "choice");
	assert.equal(kindOf("makePlan: x"), "rule", "a function name before a colon is not a tag");
});

test("compareTests reports changed, removed, added and renamed tests, and fixture edits", () => {
	const edited = FILE.replace("f(1), 2", "f(1), 3").replace("const fixture = 1;", "const fixture = 2;");
	assert.deepEqual(compareTests(FILE, edited), { changed: ["rule one"], removed: [], added: [], renamed: [], fixtures: true });
	const renamed = FILE.replace('"rule one"', '"game: rule one"');
	assert.deepEqual(compareTests(FILE, renamed).renamed, [["rule one", "game: rule one"]]);
	const dropped = FILE.split("\n").slice(0, 6).join("\n");
	assert.deepEqual(compareTests(FILE, dropped).removed, ["regression: bug two"]);
	const grown = `${FILE}\n\ntest("new", () => {\n});`;
	assert.deepEqual(compareTests(FILE, grown), { changed: [], removed: [], added: ["new"], renamed: [], fixtures: false }, "blank lines aren't fixtures");
});

test("mutationSites flips conditions in code, not in comments or imports", () => {
	const source = [
		'import { a } from "/x.js";',
		"// if (a < b) in a comment",
		"/* a > b",
		"   a && b */",
		"if (a < b && c === d) run(); // a || b",
	].join("\n");
	const sites = mutationSites(source);
	assert.deepEqual(sites.map((site) => site.from.trim()), ["<", "===", "&&"]);
	assert.equal(applyMutation(source, sites[0]).split("\n")[4], "if (a >= b && c === d) run(); // a || b");
});

test("sample is fixed for a seed and never picks a site twice", () => {
	const items = Array.from({ length: 50 }, (_, line) => ({ line, at: 0 }));
	assert.deepEqual(sample(items, 10), sample(items, 10));
	assert.equal(new Set(sample(items, 50).map((item) => item.line)).size, 50);
});
