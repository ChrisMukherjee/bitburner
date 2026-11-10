// Mutation check: how much of a script's logic would the tests notice breaking?
//   npm run mutate -- singularity/buy-augs.js                 (tests that import the script)
//   npm run mutate -- hack/batcher.js tests/batcher.test.mjs  (only these tests)
//   npm run mutate -- utils/config.js --max 80                (sample size; --all for every site)
// Copies the repo to a temp folder, then flips one condition at a time in the copy (< to >=, === to !==, && to ||
// and so on) and runs the tests. A flip no test notices "survives": that condition is either untested, or the
// flip changes nothing (rare for these negations). The repo itself is never changed. See docs/testing.md.
import { cpSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FLIPS = [[" < ", " >= "], [" <= ", " > "], [" > ", " <= "], [" >= ", " < "], [" === ", " !== "], [" !== ", " === "], [" && ", " || "], [" || ", " && "]];

/** Every place in the source where one of FLIPS applies, skipping comments and imports. */
export function mutationSites(source) {
	const sites = [];
	let inComment = false;
	source.split("\n").forEach((line, index) => {
		const trimmed = line.trim();
		if (trimmed.startsWith("/*")) inComment = true;
		if (inComment) { if (trimmed.includes("*/")) inComment = false; return; }
		if (trimmed.startsWith("//") || trimmed.startsWith("import ")) return;
		const code = line.replace(/\s\/\/.*$/, "");
		for (const [from, to] of FLIPS) {
			for (let at = code.indexOf(from); at >= 0; at = code.indexOf(from, at + 1)) sites.push({ line: index, at, from, to });
		}
	});
	return sites;
}

/** The source with one site flipped. */
export function applyMutation(source, site) {
	const lines = source.split("\n");
	const text = lines[site.line];
	lines[site.line] = text.slice(0, site.at) + site.to + text.slice(site.at + site.from.length);
	return lines.join("\n");
}

/** A fixed-seed sample, so two runs on the same code pick the same sites. */
export function sample(items, count, seed = 12345) {
	const pool = [...items];
	const picked = [];
	let state = seed;
	while (picked.length < count && pool.length > 0) {
		state = (state * 1103515245 + 12345) % 2147483648;
		picked.push(pool.splice(Math.floor((state / 2147483648) * pool.length), 1)[0]);
	}
	return picked.sort((a, b) => a.line - b.line || a.at - b.at);
}

function main() {
	const args = process.argv.slice(2);
	const all = args.includes("--all");
	const maxAt = args.indexOf("--max");
	const max = all ? Infinity : maxAt >= 0 ? Number(args[maxAt + 1]) : 40;
	const plain = args.filter((arg, i) => !arg.startsWith("--") && !(maxAt >= 0 && i === maxAt + 1));
	const [script, ...given] = plain;
	if (!script) {
		console.log("usage: npm run mutate -- <script.js> [tests/x.test.mjs ...] [--max N | --all]");
		process.exit(1);
	}
	const tests = given.length > 0 ? given : readdirSync("tests").filter((name) => name.endsWith(".test.mjs"))
		.filter((name) => readFileSync(join("tests", name), "utf8").includes(`"/${script}"`)).map((name) => `tests/${name}`);
	if (tests.length === 0) {
		console.log(`No test imports /${script}: nothing protects it.`);
		return;
	}
	const copy = mkdtempSync(join(tmpdir(), "mutate-"));
	try {
		cpSync(".", copy, { recursive: true, filter: (path) => !/[\\/](\.git|node_modules|archive)([\\/]|$)/.test(path.slice(process.cwd().length)) });
		const run = () => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "./tests/support/register.mjs", "--test", ...tests],
			{ cwd: copy, timeout: 120_000, encoding: "utf8" }).status === 0;
		if (!run()) {
			console.log("The tests fail before any change: fix them first.");
			process.exit(1);
		}
		const source = readFileSync(join(copy, script), "utf8");
		const sites = mutationSites(source);
		const picked = sample(sites, max);
		const lines = source.split("\n");
		const survivors = [];
		for (const site of picked) {
			writeFileSync(join(copy, script), applyMutation(source, site));
			if (run()) survivors.push(`  ${String(site.line + 1).padStart(4)}  ${site.from.trim()} -> ${site.to.trim()}   ${lines[site.line].trim().slice(0, 100)}`);
		}
		const caught = picked.length - survivors.length;
		console.log(`${script}: ${caught} of ${picked.length} flips caught (${Math.round((100 * caught) / Math.max(1, picked.length))}%), ` +
			`${sites.length} sites, tests: ${tests.join(" ")}`);
		if (survivors.length > 0) console.log(`Not noticed by any test:\n${survivors.join("\n")}`);
	} finally {
		rmSync(copy, { recursive: true, force: true });
	}
}

if (process.argv[1]?.endsWith("mutate.mjs")) main();
