// Checks across the whole repo that catch the slips a rename or a new script tends to cause:
// an import or script path that points nowhere, a helper's copy list missing one of its imports, a script
// missing from its folder README, an alias with a relative path, and tools/status.js reading startup.js's
// list differently from startup.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, gamePath } from "./support/game-path.mjs";
import { SCRIPTS } from "/startup.js";
import { parseStartupScripts, parseList, darknetLine } from "/tools/status.js";

// Folders that never reach the game or aren't ours.
const SKIP = new Set(["node_modules", "archive", "tests", ".git", "data", ".vscode"]);

/** Every game script (.js), as repo-relative paths with forward slashes. */
function gameScripts(dir = ROOT) {
	const found = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (SKIP.has(entry.name)) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) found.push(...gameScripts(full));
		else if (entry.name.endsWith(".js")) found.push(path.relative(ROOT, full).split(path.sep).join("/"));
	}
	return found;
}
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const exists = (file) => fs.existsSync(path.join(ROOT, file));
const scripts = gameScripts();

test("every import points at a file that exists", () => {
	const broken = [];
	for (const file of scripts) {
		for (const [, specifier] of read(file).matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+\.js)["']/g)) {
			const url = gamePath(specifier) ?? new URL(specifier, `file:///${path.join(ROOT, file)}`).href;
			if (!fs.existsSync(fileURLToPath(url))) broken.push(`${file} imports ${specifier}`);
		}
	}
	assert.deepEqual(broken, []);
});

test("script paths written in code (run, exec, copy lists) exist", () => {
	const missing = [];
	for (const file of scripts) {
		const code = read(file).replace(/\/\/.*$/gm, ""); // comments may name archived scripts
		for (const [, name] of code.matchAll(/["'`](\/?(?:[\w-]+\/)+[\w.-]+\.js)["'`]/g)) {
			if (name.includes("archive/")) continue;
			if (!exists(name.replace(/^\//, ""))) missing.push(`${file}: ${name}`);
		}
	}
	assert.deepEqual(missing, []);
});

/** The files a script imports, directly or through other imports, as repo-relative paths. */
function importClosure(file, seen = new Set()) {
	for (const [, specifier] of read(file).matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+\.js)["']/g)) {
		const dependency = specifier.startsWith(".") ? path.posix.join(path.posix.dirname(file), specifier) : specifier.replace(/^\//, "");
		if (seen.has(dependency)) continue;
		seen.add(dependency);
		importClosure(dependency, seen);
	}
	return seen;
}

test("a helper's copy list (xHelper with xImports) names every file the helper imports", () => {
	// startHelper copies only the listed files to the server it picks, and the helper can't start there without them.
	const missing = [];
	let pairs = 0;
	for (const file of scripts) {
		const code = read(file);
		for (const [, name, helper] of code.matchAll(/(\w+)Helper:\s*["']([^"']+\.js)["']/g)) {
			const list = code.match(new RegExp(`${name}Imports:\\s*\\[([^\\]]*)\\]`));
			if (!list) {
				missing.push(`${file}: ${name}Helper has no ${name}Imports list`);
				continue;
			}
			pairs++;
			const listed = new Set([...list[1].matchAll(/["']([^"']+)["']/g)].map(([, entry]) => entry.replace(/^\//, "")));
			for (const dependency of importClosure(helper)) if (!listed.has(dependency)) missing.push(`${file}: ${name}Imports lacks ${dependency}`);
		}
	}
	assert.ok(pairs >= 3, "found the copy lists in singularity/player-work.js");
	assert.deepEqual(missing, []);
});

test("every script startup.js runs exists", () => {
	assert.deepEqual(SCRIPTS.map((entry) => entry.script).filter((script) => !exists(script)), []);
});

test("tools/status.js reads startup.js's script list the way startup.js has it", () => {
	const parsed = parseStartupScripts(read("startup.js"));
	const actual = SCRIPTS.map((entry) => ({
		stage: entry.stage, script: entry.script, until: entry.until, oneShot: !!entry.oneShot, hasReady: !!entry.ready,
	}));
	assert.deepEqual(parsed, actual);
});

test("tools/status.js says why the darknet manager isn't running", () => {
	const stages = ["start", "early", "mid", "late"];
	const ns = (owned) => ({ fileExists: () => owned });
	assert.match(darknetLine(ns(false), [], "late", stages), /DarkscapeNavigator\.exe/);
	assert.match(darknetLine(ns(true), [], "early", stages), /mid stage/);
	assert.match(darknetLine(ns(true), [], "late", stages), /isn't running/);
	assert.match(darknetLine(ns(false), [{ filename: "darknet/dnet-manager.js" }], "late", stages), /running/);
});

test("tools/status.js finds the Go bot's opponent rotation", () => {
	assert.ok(parseList(read("go/go-bot.js"), "ROTATION").length > 0);
});

test("every script is listed in its folder's README", () => {
	const unlisted = [];
	for (const file of scripts) {
		// The nearest README.md at or above the script's folder (workers/ are listed in the parent's).
		let dir = path.posix.dirname(file);
		while (dir !== "." && !exists(`${dir}/README.md`)) dir = path.posix.dirname(dir);
		const readme = dir === "." ? "README.md" : `${dir}/README.md`;
		const relative = dir === "." ? file : file.slice(dir.length + 1);
		if (!read(readme).includes(relative)) unlisted.push(`${file} (not in ${readme})`);
	}
	assert.deepEqual(unlisted, []);
});

test("aliases in the README run scripts by absolute path", () => {
	const relative = [];
	for (const [line] of read("README.md").matchAll(/^alias .*$/gm)) {
		for (const [, script] of line.matchAll(/\brun\s+(\S+)/g)) if (!script.startsWith("/")) relative.push(line);
	}
	assert.deepEqual(relative, []);
});

/** Every .js file under archive/, as paths relative to archive/ with forward slashes. */
function archivedScripts(dir = path.join(ROOT, "archive")) {
	const found = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) found.push(...archivedScripts(full));
		else if (entry.name.endsWith(".js")) found.push(path.relative(path.join(ROOT, "archive"), full).split(path.sep).join("/"));
	}
	return found;
}

test("every archived script has a line in archive/README.md", () => {
	const readme = read("archive/README.md");
	assert.deepEqual(archivedScripts().filter((file) => !readme.includes(`(${file})`)), []);
});

test("no -vX copy is left outside archive/ (move it there and list it in archive/README.md)", () => {
	assert.deepEqual(scripts.filter((file) => /-v\d+\.js$/.test(file)), []);
});
