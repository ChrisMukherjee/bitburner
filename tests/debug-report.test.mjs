// tools/debug-report.js: the "running on home" section.
import { test } from "node:test";
import assert from "node:assert/strict";
import { processLines } from "/tools/debug-report.js";

const weaken = (target, id) => ({ filename: "hack/workers/weaken.js", args: [target, id, 0], threads: 16 });

test("regression: a busy batcher's workers take one line per script, not one per copy", () => {
	const procs = [{ filename: "hack/batcher.js", args: [], threads: 1 }];
	for (let i = 0; i < 2000; i++) procs.push(weaken(i % 2 ? "the-hub" : "ecorp", 1794338310863 + i));
	procs.push({ filename: "hack/workers/grow.js", args: ["ecorp", 1, 0], threads: 722 });
	const lines = processLines(procs);
	assert.deepEqual(lines, [
		"hack/batcher.js  (x1)", // no arguments: two spaces, as before
		"hack/workers/weaken.js: 2000 running, 32000 threads (ecorp, the-hub)",
		"hack/workers/grow.js: 1 running, 722 threads (ecorp)",
	]);
	assert.equal(processLines(procs, true).length, 2002, "--full lists every copy");
});

test("processLines: many targets are cut to five", () => {
	const procs = ["a", "b", "c", "d", "e", "f", "g"].map((target, i) => weaken(target, i));
	assert.deepEqual(processLines(procs), ["hack/workers/weaken.js: 7 running, 112 threads (a, b, c, d, e, +2 more)"]);
});
