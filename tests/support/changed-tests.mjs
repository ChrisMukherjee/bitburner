// Lists the tests whose expectations changed against a git ref (default HEAD), for the change report.
//   npm run test:changed            (against HEAD: the working tree's uncommitted test edits)
//   npm run test:changed -- main~3  (against any ref)
// A test is matched by name. Its kind comes from the name's tag (regression:, game:, choice:, else rule), which tells
// the reader how much a change to it needs explaining (docs/testing.md, "When a test fails").
// Edits outside any test (shared fixtures and helpers) are listed too: changing a fixture can make an old test pass
// under a new rule without touching its assertions.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ref = process.argv[2] ?? "HEAD";
const dir = "tests";

/** Splits a test file into top-level tests (`test(` ... `});` at column 0) and the code outside them. */
export function splitTests(text) {
	const tests = new Map();
	const outside = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const start = lines[i].match(/^test\(\s*(["'`])(.*?)\1/);
		if (!start) { outside.push(lines[i]); continue; }
		let end = i;
		while (end < lines.length - 1 && lines[end] !== "});") end++;
		tests.set(start[2], lines.slice(i, end + 1).join("\n"));
		i = end;
	}
	// Blank lines between tests come and go as tests are added; they aren't fixtures.
	return { tests, outside: outside.filter((line) => line.trim() !== "").join("\n") };
}

/** The kind a test name declares. */
export function kindOf(name) {
	const tag = name.match(/^(regression|game|choice):/);
	return tag ? tag[1] : "rule";
}

/** Compares two versions of one test file. */
export function compareTests(oldText, newText) {
	const before = splitTests(oldText);
	const after = splitTests(newText);
	const changed = [...after.tests].filter(([name, body]) => before.tests.has(name) && before.tests.get(name) !== body).map(([name]) => name);
	let removed = [...before.tests.keys()].filter((name) => !after.tests.has(name));
	let added = [...after.tests.keys()].filter((name) => !before.tests.has(name));
	// A renamed test with the body otherwise unchanged (the name line itself differs)
	const bodyOf = (body) => body.split("\n").slice(1).join("\n");
	const renamed = [];
	for (const name of [...removed]) {
		const twin = added.find((other) => bodyOf(after.tests.get(other)) === bodyOf(before.tests.get(name)));
		if (twin) { renamed.push([name, twin]); removed = removed.filter((n) => n !== name); added = added.filter((n) => n !== twin); }
	}
	return { changed, removed, added, renamed, fixtures: before.outside !== after.outside };
}

function gitShow(path) {
	try {
		return execFileSync("git", ["show", `${ref}:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return null;
	}
}

function main() {
	if (!existsSync(dir)) throw new Error("run from the repo root");
	const files = readdirSync(dir).filter((name) => name.endsWith(".test.mjs"));
	const tracked = execFileSync("git", ["ls-tree", "--name-only", ref, `${dir}/`], { encoding: "utf8" }).split("\n")
		.filter((path) => path.endsWith(".test.mjs")).map((path) => path.slice(dir.length + 1));
	let any = false;
	const show = (label, names) => names.forEach((name) => console.log(`  ${label.padEnd(8)} [${kindOf(Array.isArray(name) ? name[1] : name)}] ${Array.isArray(name) ? `${name[0]}  ->  ${name[1]}` : name}`));
	for (const file of [...new Set([...files, ...tracked])].sort()) {
		const oldText = gitShow(`${dir}/${file}`) ?? "";
		const newText = existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8") : "";
		if (oldText === newText) continue;
		const diff = compareTests(oldText, newText);
		const edits = diff.changed.length + diff.removed.length + diff.renamed.length;
		if (edits === 0 && !diff.fixtures && diff.added.length === 0) continue;
		any = true;
		console.log(`${file}${oldText ? "" : " (new file)"}`);
		show("changed", diff.changed);
		show("removed", diff.removed);
		show("renamed", diff.renamed);
		if (oldText) show("added", diff.added); else console.log(`  added    ${diff.added.length} tests`);
		if (diff.fixtures && oldText) console.log("  fixtures shared helpers or fixtures outside the tests changed");
	}
	if (!any) console.log(`No test changes against ${ref}.`);
	else console.log("\nEvery changed, removed or renamed test, and every fixture change, goes in the change report with the reason (docs/testing.md).");
}

if (process.argv[1]?.endsWith("changed-tests.mjs")) main();
