// Design: docs/aug-reset.md
import { loadConfig } from "/utils/config.js";

/**
 * A second opinion on "reset now or keep going?", next to the reset rule in buy-augs.js. Run it by hand:
 *   run /singularity/reset-compare.js
 * Reads the plan (data/aug-plan.json, written by buy-augs.js --plan) and this run's income samples in it. 0 NS calls beyond
 * reading files, so it is small and safe to run any time. It changes nothing.
 *
 * Both rules maximise the same thing: augmentation value gained per hour of play, because augmentations carry into every later
 * run (that is the point of resetting). The difference is the cost of a reset:
 *   Plan rule:  value / (run age + the fixed reset overhead).
 *   This one:   value / (run age + the overhead + the REBUILD cost measured from this run's own income samples).
 * Rebuild cost = hours of full-speed income this run lost while it built up to today's income level,
 *   L = integral over the run of (1 - I(t) / I_now) dt;
 * the next run rebuilds m times faster (m = e^value of the augmentations installed), so it costs L / m.
 * Estimate only: hacking income, and the speed-up is one flat factor. Its value forecast is the plan's.
 * Ported from the other player's reset-compare.js, which has run in game (it read an income log; this reads the plan's samples).
 */
/** @param {NS} ns */
export async function main(ns) {
	const say = (message) => ns.tprint(message);
	let plan = null;
	try { plan = JSON.parse(ns.read("data/aug-plan.json")); } catch { /* none yet */ }
	if (!plan?.decision?.curve?.length) { say("No plan yet (data/aug-plan.json): run singularity/buy-augs.js --plan once."); return; }
	const decision = plan.decision;
	say(`Plan rule (plan ${Math.round((Date.now() - plan.checkedAt) / 60000)} min old): ${decision.reset ? "RESET" : "WAIT"} - ${decision.reason}`);

	const samples = plan.incomeHistory?.samples ?? []; // [ageMinutes, perSecond]
	const points = samples.map(([minutes, perSecond]) => ({ x: minutes / 60, y: perSecond }));
	if (points.length < 4 || points[points.length - 1].x - points[0].x < 1 / 3) {
		const span = points.length > 1 ? Math.round((points[points.length - 1].x - points[0].x) * 60) : 0;
		say(`Not enough income history yet: ${points.length} samples covering ${span} min; needs at least 4 covering 20 min. Try again in a few minutes.`);
		return;
	}
	const runHours = points[points.length - 1].x;
	const now = decision.curve[0];
	const speedup = Math.exp(Math.max(0, now.value));
	// Income level to measure the build-up against: the average of the last few samples
	const last = points.slice(-4);
	const incomeNow = last.reduce((sum, point) => sum + point.y, 0) / last.length;
	if (incomeNow <= 0) { say("No income logged yet (is the batcher running?)."); return; }
	// Trapezoids over the samples, from run start (income 0) to now
	let lost = 0;
	let previousX = 0;
	let previousY = 0;
	for (const point of points) {
		lost += (point.x - previousX) * (1 - (Math.min(previousY, incomeNow) + Math.min(point.y, incomeNow)) / 2 / incomeNow);
		previousX = point.x;
		previousY = point.y;
	}
	const rebuildHours = lost / Math.max(speedup, 1.0001);
	const rule = loadConfig(ns).augments?.resetRule ?? {};
	const overheadHours = (rule.overheadMinutes ?? 5) / 60 + rebuildHours;

	const rate = (point) => point.value / (runHours + point.inMinutes / 60 + overheadHours);
	const nowRate = rate(now);
	const maxWaitMinutes = Number(rule.maxWaitMinutes ?? 60);
	const later = decision.curve.slice(1).filter((point) => point.inMinutes <= maxWaitMinutes)
		.reduce((best, point) => (!best || rate(point) > rate(best) ? point : best), null);
	say(`This run built up its income over ${lost.toFixed(1)} h of lost output; the next run (x${speedup.toFixed(2)} faster) would lose about ${rebuildHours.toFixed(2)} h of it.`);
	say(`  Reset now: x${speedup.toFixed(2)} gained after a ${runHours.toFixed(1)} h run + ${overheadHours.toFixed(2)} h reset cost = ${nowRate.toFixed(3)} per hour.`);
	if (later) say(`  Best later moment: in ${later.inMinutes} min, x${Math.exp(later.value).toFixed(2)} = ${rate(later).toFixed(3)} per hour.`);
	// The same guarantee as the plan: an old run with a worthwhile batch resets
	const guaranteed = runHours >= (rule.maxRunHours ?? 4) && now.value >= Math.log(rule.guaranteeSpeed ?? 1.5);
	const wait = Boolean(!guaranteed && later && rate(later) > nowRate * 1.05);
	say(`  -> ${wait ? `WAIT (about ${later.inMinutes} min)` : "RESET"}${wait === Boolean(decision.reset) ? "  (differs from the plan rule)" : "  (agrees with the plan rule)"}`);
}
