// Design: docs/aug-reset.md
/**
 * Income curve: how money income grows over a run, so the reset rule can forecast cash
 * instead of assuming today's $/s stays flat. 0GB (no NS calls).
 *
 * buy-augs.js --plan keeps a history in data/aug-plan.json (one sample every few minutes of
 * run age and $/s, plus the previous run's samples), turns it into a small model with
 * buildIncomeModel and stores that model too. faction-goals.js gets the model through
 * player-work.js. Both then ask earnedOver / timeToEarn.
 *
 * The model: income grows by `growth` (natural log per hour) right now, and that growth
 * fades with a half-life of `dampHours`, so the forecast levels off instead of running away.
 * The income multiplier never goes above `maxMult`. growth comes from a log-linear fit of
 * this run's last `fitHours` of samples, never more than the previous run grew from the same
 * run age onwards, and from that previous run alone while this run has too few samples.
 * Falling income is forecast as flat (growth is never below 0).
 *
 * Settings: `augments.resetRule.incomeCurve` in config.js.
 */

const MAX_SAMPLES = 150;

/**
 * Adds one income sample to the history and returns the new history:
 *   { lastReset, samples: [[ageMinutes, perSecond], ...], previous: [...] }
 * A history from before the last reset becomes `previous` and a new one starts.
 * Samples closer than curve.sampleMinutes to the last one are dropped; $0 is never stored.
 */
export function recordIncomeSample(history, lastReset, now, perSecond, curve) {
	let current = history && Array.isArray(history.samples) ? history : null;
	if (current && current.lastReset !== lastReset) {
		current = { lastReset, samples: [], previous: current.samples.length > 1 ? current.samples : (current.previous ?? []) };
	}
	if (!current) current = { lastReset, samples: [], previous: [] };
	const ageMinutes = (now - lastReset) / 60_000;
	const last = current.samples[current.samples.length - 1];
	if (perSecond > 0 && (!last || ageMinutes - last[0] >= curve.sampleMinutes)) {
		current.samples.push([round(ageMinutes, 1), Number(perSecond.toPrecision(4))]);
	}
	// Too many: thin the older half (every other one), keeping the recent ones dense.
	if (current.samples.length > MAX_SAMPLES) {
		const half = Math.floor(current.samples.length / 2);
		current.samples = [...current.samples.slice(0, half).filter((_, index) => index % 2 === 0), ...current.samples.slice(half)];
	}
	return current;
}

/**
 * The model for this run age: { growth, dampHours, maxMult, source, samples, time }.
 * growth is ln(income) per hour now; source says where it came from.
 */
export function buildIncomeModel(history, ageMs, curve, now = Date.now()) {
	const ageHours = ageMs / 3600_000;
	const model = { growth: 0, dampHours: curve.dampHours, maxMult: curve.maxMult, source: "flat", samples: 0, time: now };
	if (!curve.enabled || !history) return model;

	const recent = (history.samples ?? []).filter(([minutes]) => minutes / 60 >= ageHours - curve.fitHours);
	const span = recent.length > 1 ? recent[recent.length - 1][0] - recent[0][0] : 0;
	const own = recent.length >= curve.minSamples && span >= curve.minSpanMinutes ? slope(recent) : null;

	// What the previous run did next, from this run age on (it shows how a run's income grows).
	const ahead = (history.previous ?? []).filter(([minutes]) => minutes / 60 >= ageHours && minutes / 60 <= ageHours + curve.fitHours);
	const previous = ahead.length >= 2 ? slope(ahead) : null;

	let growth = 0;
	if (own !== null && previous !== null) {
		growth = Math.min(own, previous);
		model.source = own <= previous ? "this run" : "capped by last run";
	} else if (own !== null) {
		growth = own;
		model.source = "this run";
	} else if (previous !== null) {
		growth = previous;
		model.source = "last run";
	}
	model.growth = round(Math.max(0, Math.min(curve.maxGrowthPerHour, growth)), 4);
	model.samples = recent.length;
	return model;
}

/** Income multiplier after `hours` from now (1 at 0, levelling off, at most maxMult). */
export function incomeMultAt(model, hours) {
	if (!model || model.growth <= 0) return 1;
	const fade = model.dampHours / Math.LN2; // half-life -> time constant
	return Math.min(model.maxMult, Math.exp(model.growth * fade * (1 - Math.exp(-hours / fade))));
}

/** Money earned over the next `seconds` starting at perSecond and following the model. */
export function earnedOver(perSecond, model, seconds) {
	if (perSecond <= 0 || seconds <= 0) return 0;
	if (!model || model.growth <= 0) return perSecond * seconds;
	const steps = 60;
	const step = seconds / steps;
	let total = 0;
	for (let index = 0; index < steps; index++) {
		const middle = (index + 0.5) * step / 3600; // midpoint rule, in hours
		total += perSecond * incomeMultAt(model, middle) * step;
	}
	return total;
}

/** Seconds until `amount` is earned, following the model (Infinity with no income). */
export function timeToEarn(perSecond, model, amount) {
	if (amount <= 0) return 0;
	if (perSecond <= 0) return Infinity;
	if (!model || model.growth <= 0) return amount / perSecond;
	// The multiplier levels off at its limit, so walk minute by minute for up to 48 hours, then flat.
	let total = 0;
	for (let minute = 0; minute < 48 * 60; minute++) {
		const rate = perSecond * incomeMultAt(model, (minute + 0.5) / 60);
		if (total + rate * 60 >= amount) return minute * 60 + (amount - total) / rate;
		total += rate * 60;
	}
	return 48 * 3600 + (amount - total) / (perSecond * incomeMultAt(model, 48));
}

/** Least-squares slope of ln(perSecond) against run age, per hour. */
function slope(samples) {
	const points = samples.map(([minutes, perSecond]) => [minutes / 60, Math.log(perSecond)]);
	const meanX = points.reduce((sum, [x]) => sum + x, 0) / points.length;
	const meanY = points.reduce((sum, [, y]) => sum + y, 0) / points.length;
	let top = 0;
	let bottom = 0;
	for (const [x, y] of points) {
		top += (x - meanX) * (y - meanY);
		bottom += (x - meanX) ** 2;
	}
	return bottom > 0 ? top / bottom : null;
}

function round(number, places) {
	const scale = 10 ** places;
	return Math.round(number * scale) / scale;
}
