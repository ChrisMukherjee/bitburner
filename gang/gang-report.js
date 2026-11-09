// Design: docs/gang.md
// @ts-check

// Written by gang/gang-manager.js (LOG_FILE there); keep the two in step.
const LOG_FILE = "data/gang-log.json";
const SUMMARY_PORT = 28;

/**
 * Prints how well the gang is doing, from the samples gang/gang-manager.js logs (every gang.logMs, default 5 minutes, a day kept):
 * money and respect per second against the ceiling (every member on its best money task with no wanted penalty), members training
 * or idle, ascensions per hour, land gained per hour with the time left to all of it, and when the gang first filled up.
 *
 *   run gang/gang-report.js
 *   run gang/gang-report.js --hours 6    only the last 6 hours of samples
 *
 * Reads the log from the server the manager runs on (home unless it was placed elsewhere).
 */
/** @param {NS} ns */
export async function main(ns) {
	const flags = ns.flags([["hours", 24]]);
	let log;
	try { log = JSON.parse(ns.read(LOG_FILE)); } catch { log = null; }
	const live = ns.peek(SUMMARY_PORT);
	if (!log?.samples?.length) {
		ns.tprint(`No samples in ${LOG_FILE} yet. The manager logs one every gang.logMs (5 minutes by default); it must run on this server.`);
		if (live && typeof live === "object" && live.metrics) printSample(ns, "Now", live.metrics);
		return;
	}
	const cutoff = Date.now() - Number(flags.hours) * 3_600_000;
	const samples = log.samples.filter((/** @type {any} */ sample) => sample.t >= cutoff);
	if (samples.length === 0) { ns.tprint(`No samples in the last ${flags.hours} hours.`); return; }
	const first = samples[0];
	const last = samples[samples.length - 1];
	const hours = Math.max(1 / 60, (last.t - first.t) / 3_600_000);
	printSample(ns, "Latest", last);

	const landPerHour = (last.territory - first.territory) / hours;
	const lines = [];
	lines.push(`over ${hours.toFixed(1)}h (${samples.length} samples): ascensions ${((last.ascensions - first.ascensions) / hours).toFixed(1)}/h, deaths ${last.deaths - first.deaths}`);
	lines.push(`money x${ratio(last.money, first.money)}, respect rate x${ratio(last.respectRate, first.respectRate)}, main stat x${ratio(last.avgMain, first.avgMain)}`);
	if (last.territory < 0.9999) {
		lines.push(landPerHour > 0
			? `land ${pct(first.territory)} -> ${pct(last.territory)} (+${pct(landPerHour)}/h): about ${((1 - last.territory) / landPerHour).toFixed(1)}h to all of it at this pace`
			: `land ${pct(last.territory)}, not growing${last.engaged ? " (clashes on)" : " (clashes off)"}`);
	} else {
		lines.push("all the land is ours");
	}
	const m = log.milestones ?? {};
	const at = (/** @type {number | undefined} */ seconds) => (seconds == null ? "not yet" : `${(seconds / 3600).toFixed(1)}h in`);
	lines.push(`milestones (manager uptime): gang full ${at(m.full)}, first clashes ${at(m.firstClash)}, all land ${at(m.landAll)}`);
	const idle = (last.members ?? 0) - Object.values(last.kinds ?? {}).reduce((sum, count) => sum + Number(count), 0);
	if (idle > 0) lines.push(`${idle} member(s) had no plan at the last sample (unassigned)`);
	for (const line of lines) ns.tprint("  " + line);
}

/** One sample as a short block. */
function printSample(ns, label, /** @type {any} */ sample) {
	const kinds = sample.kinds ?? {};
	ns.tprint(`${label}: ${sample.members} members, $${ns.format.number(sample.money)}/s` +
		(sample.efficiency == null ? "" : ` (${ns.format.percent(sample.efficiency)} of the $${ns.format.number(sample.ceiling)}/s ceiling)`) +
		`, respect ${ns.format.number(sample.respect)} (+${ns.format.number(sample.respectRate)}/s), wanted penalty ${ns.format.percent(sample.penalty)}`);
	ns.tprint(`  ${kinds.earn ?? 0} earning, ${kinds.train ?? 0} training, ${kinds.war ?? 0} warfare, ${kinds.cool ?? 0} cooling; ` +
		`land ${pct(sample.territory)}, clashes ${sample.engaged ? "on" : "off"}; main stat avg ${ns.format.number(sample.avgMain)}; ${sample.ascensions} ascensions`);
}

const pct = (/** @type {number} */ value) => `${(value * 100).toFixed(1)}%`;
const ratio = (/** @type {number} */ now, /** @type {number} */ before) => (before > 0 ? (now / before).toFixed(2) : "?");
