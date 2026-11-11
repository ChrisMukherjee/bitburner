// Design: docs/debug-report.md
// @ts-check
import { readPasses, PASS_PORT } from "/utils/pass-log.js";

// Every port the scripts use (see docs/NETSCRIPT.md), by name, for the report
const PORTS = {
	20: "darknet", 21: "stock influence", 22: "hacked total", 23: "faction goals", 24: "income rate", 25: "city plan",
	26: "stock summary", 27: "target stats", 28: "gang summary", 29: "gang equipment", 30: "gang invite", 31: "batcher RAM claim",
	32: "contract failures", 33: "one-shot gates", 34: "RAM reservations", 35: "player-work state", 36: "Bladeburner",
	38: "income mix", 39: "crime-faction invite",
};
const FILES = ["data/startup-why.txt", "data/node-eta.txt", "data/config.json"]; // written by the scripts, read by hand otherwise
const MAX_PORT_CHARS = 1500;
const MAX_FILE_LINES = 40;
const REPORT_FILE = "data/debug-report.txt";

/**
 * One file to paste when something looks wrong: `run /tools/debug-report.js`, then `cat data/debug-report.txt` and copy it
 * (or paste the terminal lines). It has what a running script's log and a one-shot's vanished log would have had:
 * the run (BitNode, Source-Files, home), what is running, why startup.js did not start something, the last result of every
 * one-shot pass, and the raw state on every port. Reads only; changes nothing.
 * Short-lived workers (a `/workers/` path, e.g. the batcher's hundreds of weaken/grow/hack batches) are listed one line per
 * script, with their copies, threads and first arguments; --full lists every copy.
 * Flags: --full prints no length limit per port and every running copy.
 */
/** @param {NS} ns */
export async function main(ns) {
	const full = ns.flags([["full", false]]).full;
	const info = ns.getResetInfo();
	const player = ns.getPlayer();
	const lines = [];
	const section = (title) => lines.push("", `=== ${title} ===`);

	lines.push(`DEBUG REPORT ${new Date().toISOString()}`);
	section("run");
	lines.push(`BitNode ${info.currentNode}; Source-Files: ${[...info.ownedSF.entries()].map(([node, level]) => `${node}.${level}`).join(" ") || "none"}`);
	lines.push(`run age ${((Date.now() - info.lastAugReset) / 3600_000).toFixed(2)} h; hacking ${player.skills.hacking}; money $${ns.format.number(player.money)}; ` +
		`home ${ns.format.ram(ns.getServerMaxRam("home"))} (${ns.format.ram(ns.getServerUsedRam("home"))} used), ${ns.getServer("home").cpuCores} cores`);
	lines.push(`city ${player.city}; factions: ${player.factions.join(", ") || "none"}`);

	section("running on home");
	lines.push(...processLines(ns.ps("home"), full === true));

	section("last pass of each one-shot (port " + PASS_PORT + ")");
	const passes = readPasses(ns);
	const names = Object.keys(passes).sort();
	if (names.length === 0) lines.push("nothing posted yet");
	for (const name of names) {
		lines.push(`${name}  (${ago(passes[name].time)} ago)`);
		for (const line of passes[name].lines) lines.push(`  ${line}`);
	}

	for (const file of FILES) {
		section(file);
		if (!ns.fileExists(file, "home")) { lines.push("(missing)"); continue; }
		const text = String(ns.read(file)).split("\n");
		lines.push(...text.slice(0, full ? text.length : MAX_FILE_LINES));
		if (!full && text.length > MAX_FILE_LINES) lines.push(`... ${text.length - MAX_FILE_LINES} more lines (--full)`);
	}

	section("ports");
	for (const [port, name] of Object.entries(PORTS)) {
		const data = ns.peek(Number(port));
		if (data === "NULL PORT DATA") { lines.push(`${port} ${name}: empty`); continue; }
		const text = typeof data === "string" ? data : JSON.stringify(data);
		lines.push(`${port} ${name}: ${full || text.length <= MAX_PORT_CHARS ? text : text.slice(0, MAX_PORT_CHARS) + ` ... (${text.length} chars, --full)`}`);
	}

	ns.write(REPORT_FILE, lines.join("\n") + "\n", "w");
	ns.tprint(`Debug report written: ${lines.length} lines. Read it with: cat ${REPORT_FILE}`);
}

function ago(time) {
	const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
	return seconds < 120 ? `${seconds} s` : seconds < 7200 ? `${Math.round(seconds / 60)} min` : `${(seconds / 3600).toFixed(1)} h`;
}

/**
 * One line per running script; workers (a `/workers/` path) one line per script with how many copies and threads, and the
 * distinct first arguments (their targets), so a busy batcher doesn't fill the report with thousands of lines. Pure, for the tests.
 * @param {{ filename: string, args: (string | number | boolean)[], threads: number }[]} procs
 * @param {boolean} [full]  list every copy
 * @returns {string[]}
 */
export function processLines(procs, full = false) {
	const out = [];
	/** @type {Map<string, { copies: number, threads: number, firsts: Set<string> }>} */
	const workers = new Map();
	for (const proc of procs) {
		if (full || !proc.filename.includes("/workers/")) {
			out.push(`${proc.filename} ${proc.args.join(" ")} (x${proc.threads})`.trim());
			continue;
		}
		const entry = workers.get(proc.filename) ?? { copies: 0, threads: 0, firsts: new Set() };
		entry.copies++;
		entry.threads += proc.threads;
		if (proc.args.length > 0) entry.firsts.add(String(proc.args[0]));
		workers.set(proc.filename, entry);
	}
	for (const [name, entry] of workers) {
		const firsts = [...entry.firsts];
		const shown = firsts.slice(0, 5).join(", ") + (firsts.length > 5 ? `, +${firsts.length - 5} more` : "");
		out.push(`${name}: ${entry.copies} running, ${entry.threads} threads${shown ? ` (${shown})` : ""}`);
	}
	return out;
}
