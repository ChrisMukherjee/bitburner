// Design: docs/aug-reset.md
/**
 * Run by hand: what the reset rule saw at each install (data/reset-log.json, written by install-augs.js).
 *   run /singularity/reset-log.js
 * One row per install: how long the run was, how many augments were bought, the batch's speed-up (x e^value)
 * and value per hour, the better later moment the rule was weighing (null: none), and the income then.
 * Compare consecutive rows to tune resetRule (waitMargin, maxWaitMinutes, weights): value per hour that keeps
 * falling means resets come too late, runs of 1-2 augments at a low rate mean too early. Reads one file; changes nothing.
 */
/** @param {NS} ns */
export async function main(ns) {
	let history = [];
	try { history = JSON.parse(ns.read("data/reset-log.json") || "[]"); } catch { history = []; }
	if (history.length === 0) { ns.tprint("No resets logged yet: install-augs.js writes data/reset-log.json at each install."); return; }
	ns.tprint("run min | bought | speed-up | value/h | better later (min, value/h) | income $/s");
	for (const row of history) {
		const speed = row.value === null ? "n/a" : "x" + Math.exp(row.value).toFixed(2);
		const rate = row.rate === null ? "n/a" : row.rate.toFixed(3);
		const later = row.best ? `${row.best.inMinutes} min, ${row.best.rate.toFixed(3)}` : "none";
		const income = row.income === null ? "n/a" : ns.format.number(row.income);
		ns.tprint(`${String(row.runMinutes).padStart(7)} | ${String(row.bought).padStart(6)} | ${speed.padStart(8)} | ${rate.padStart(7)} | ${later.padEnd(27)} | ${income}`);
	}
	const rated = history.filter((row) => row.rate !== null);
	if (rated.length > 0) ns.tprint(`${rated.length} resets with a rate; average ${(rated.reduce((sum, row) => sum + row.rate, 0) / rated.length).toFixed(3)} value/h, average run ${Math.round(history.reduce((sum, row) => sum + row.runMinutes, 0) / history.length)} min.`);
}
