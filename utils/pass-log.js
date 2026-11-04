// Design: docs/debug-report.md
// The last result of each one-shot pass, kept on a port so it outlives the script (a one-shot's own log is gone as soon as
// it exits). tools/debug-report.js prints them. One JSON object: { "<script>": { time, lines } }. One-shots run one at a
// time (startup.js), so read-modify-write is safe. 0GB (ports only).
export const PASS_PORT = 37;
const MAX_LINES = 6;
const MAX_LINE_LENGTH = 240;

/** Every script's last pass, or {} when nothing is posted. */
export function readPasses(ns) {
	try {
		const passes = JSON.parse(ns.peek(PASS_PORT));
		return passes && typeof passes === "object" ? passes : {};
	} catch {
		return {};
	}
}

/** Keeps `lines` (what the pass did, or why it did nothing) as the last result of `script`. */
export function postPass(ns, script, lines) {
	const passes = readPasses(ns);
	passes[script] = { time: Date.now(), lines: lines.slice(0, MAX_LINES).map((line) => String(line).slice(0, MAX_LINE_LENGTH)) };
	ns.clearPort(PASS_PORT);
	ns.writePort(PASS_PORT, JSON.stringify(passes));
}
