// Design: docs/darknet.md
// @ts-check
import { STORM } from "/darknet/config.js";

// Library (0GB): decides when STORM_SEED.exe's webstorm pays. A storm deletes about 60% of the darknet servers that
// are not stasis-linked or stationary and restarts the rest, so it only pays when the current map has run dry. The
// decision is a break-even comparison built from live data, with no income level baked in: measured income and its
// noise, the RAM that is blocked and how fast it is being freed, which opened servers a storm could delete, how
// fast servers have been found, and how long the map took to fill. Pure: the manager gathers the inputs.

/**
 * @typedef {object} StormInput
 * @property {number} now ms
 * @property {number} startedAt ms the manager started
 * @property {number} lastStorm ms of the last storm we fired (0 = never)
 * @property {string | null} seedHost server that holds STORM_SEED.exe, or null when none is known
 * @property {{ t: number, money: number, blocked: number, usable: number }[]} samples oldest first: cumulative darknet money,
 *   GB still blocked on opened servers, GB usable on them (max minus blocked)
 * @property {number[]} discoveries ms of each new server or password, oldest first
 * @property {number} pending mapped servers without a password that no crawler has given up on yet
 * @property {number} blockedGb GB still blocked on opened servers
 * @property {number} atRiskShare share of the opened servers' RAM a storm could delete (not stasis-linked, not stationary)
 */

/**
 * @typedef {object} StormDecision
 * @property {boolean} fire
 * @property {string} reason why it fired, or the first check that said wait
 */

/** Average $/s between the samples from `from` to `to` (ms). */
export function rateBetween(samples, from, to) {
	const inside = samples.filter((sample) => sample.t >= from && sample.t <= to);
	if (inside.length < 2) return 0;
	const first = inside[0], last = inside[inside.length - 1];
	return last.t > first.t ? Math.max(0, (last.money - first.money) / ((last.t - first.t) / 1000)) : 0;
}

/** Best average $/s over any window of `windowMs` ending within the last `historyMs`. */
export function bestRate(samples, now, windowMs, historyMs) {
	let best = 0;
	for (const end of samples) {
		if (end.t < now - historyMs) continue;
		const start = samples.filter((sample) => sample.t >= end.t - windowMs && sample.t <= end.t);
		if (start.length < 2 || end.t - start[0].t < windowMs * 0.9) continue;
		best = Math.max(best, rateBetween(samples, end.t - windowMs, end.t));
	}
	return best;
}

function median(values) {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

/** Time the map took to fill: from the first discovery to the one 90% of the way through, clamped. */
export function rampMs(discoveries, tune = STORM) {
	if (discoveries.length < 2) return tune.rampMinMs;
	const span = discoveries[Math.floor((discoveries.length - 1) * 0.9)] - discoveries[0];
	return Math.min(tune.rampMaxMs, Math.max(tune.rampMinMs, span));
}

/** How long without a discovery counts as stalled: a multiple of the usual gap, never under the floor. */
export function stallMs(discoveries, tune = STORM) {
	const gaps = [];
	for (let i = Math.max(1, discoveries.length - tune.gapSamples); i < discoveries.length; i++) gaps.push(discoveries[i] - discoveries[i - 1]);
	return Math.max(tune.stallFloorMs, tune.stallGapFactor * median(gaps));
}

/** Mean and coefficient of variation of the $/s in one-minute chunks over the last `windowMs`. */
export function rateNoise(samples, now, windowMs) {
	const chunk = 60 * 1000;
	const rates = [];
	for (let end = now; end - chunk >= now - windowMs; end -= chunk) rates.push(rateBetween(samples, end - chunk, end));
	if (rates.length < 2) return { mean: 0, cv: 0 };
	const mean = rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
	if (mean <= 0) return { mean: 0, cv: 0 };
	const variance = rates.reduce((sum, rate) => sum + (rate - mean) ** 2, 0) / rates.length;
	return { mean, cv: Math.min(1, Math.sqrt(variance) / mean) };
}

/** GB/s that blocked RAM is being freed at over the last `windowMs` (positive = falling), 0 when there is no trend. */
export function freeingRate(samples, now, windowMs) {
	const inside = samples.filter((sample) => sample.t >= now - windowMs);
	if (inside.length < 2) return 0;
	const first = inside[0], last = inside[inside.length - 1];
	return last.t > first.t ? (first.blocked - last.blocked) / ((last.t - first.t) / 1000) : 0;
}

/**
 * Should the manager tell the crawler holding STORM_SEED.exe to unleash it now? Returns the first check that says
 * wait, or the numbers behind a yes. Order: cheap facts first, then history, then the money comparison.
 * @param {StormInput} input
 * @returns {StormDecision}
 */
export function decideStorm(input, tune = STORM) {
	const { now, startedAt, lastStorm, seedHost, samples, discoveries, pending, blockedGb, atRiskShare } = input;
	if (!seedHost) return { fire: false, reason: "no STORM_SEED.exe found yet" };
	if (lastStorm && now - lastStorm < tune.cooldownMs) return { fire: false, reason: "cooling down after the last storm" };
	if (now - startedAt < tune.minHistoryMs || samples.length < tune.minSamples ||
		samples[samples.length - 1].t - samples[0].t < tune.minHistoryMs) {
		return { fire: false, reason: "not enough income history to judge yet" };
	}
	if (pending > 0) return { fire: false, reason: `${pending} server(s) still being cracked` };

	// Blocked RAM that crawlers are still freeing becomes phishing threads, so income is still on its way up. Wait
	// if the measured freeing rate would clear it within the horizon; blocked RAM that is not shrinking does not count.
	const freeing = freeingRate(samples, now, tune.rateWindowMs);
	if (blockedGb > 0 && freeing > 0 && blockedGb / freeing * 1000 < tune.horizonMs) {
		return { fire: false, reason: `${blockedGb.toFixed(0)}GB of RAM is still being freed (about ${Math.round(blockedGb / freeing / 60)}m), so income is still rising` };
	}
	const lastFound = discoveries.length ? discoveries[discoveries.length - 1] : startedAt;
	if (now - lastFound < stallMs(discoveries, tune)) return { fire: false, reason: "still finding servers" };

	const { mean: current, cv } = rateNoise(samples, now, tune.rateWindowMs);
	const best = bestRate(samples, now, tune.rateWindowMs, tune.historyMs);
	if (best <= 0) return { fire: false, reason: "no darknet income to compare" };
	// What a refilled map would earn: this run's best, or the income this much usable RAM earns per GB at the
	// efficiency measured now, whichever is higher (the map may simply have shrunk since the best window).
	const last = samples[samples.length - 1];
	const peakUsable = Math.max(...samples.map((sample) => sample.usable));
	const perGb = last.usable > 0 ? current / last.usable : 0;
	const potential = Math.max(best, perGb * peakUsable);

	// Gain: the missing income, for the horizon minus the time the map takes to refill. Loss: the servers a storm
	// can delete stop earning and the map refills linearly, so about half the ramp's income is lost. Income that
	// swings a lot makes both estimates less certain, so the gain must beat the loss by that noise.
	const ramp = rampMs(discoveries, tune);
	const gain = Math.max(0, potential - current) * Math.max(0, tune.horizonMs - ramp) / 1000;
	const loss = tune.deleteShare * atRiskShare * current * ramp / 2 / 1000;
	if (gain <= loss * (1 + 2 * cv)) return { fire: false, reason: "a storm would not bring back more income than it costs" };
	return {
		fire: true,
		reason: `no new server for ${Math.round((now - lastFound) / 60000)}m, income ${current.toFixed(0)}/s vs ${potential.toFixed(0)}/s possible, ` +
			`expected gain ${gain.toFixed(0)} vs loss ${loss.toFixed(0)} (noise ${Math.round(cv * 100)}%)`,
	};
}
