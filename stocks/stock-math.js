// Design: docs/stocks.md
// @ts-check
// Decision math for stock-trader.js. Pure functions on numbers, no ns calls, so importing it costs no RAM and the
// tests run it as is.

/** Bid/ask gap as a share of the mid price: what one buy-then-sell loses to the spread (the game's spreadPerc is per stock). */
export function spreadFraction(ask, bid) {
	const mid = (ask + bid) / 2;
	return mid > 0 ? Math.max(0, (ask - bid) / mid) : 0;
}

/**
 * Ticks a position bought now can count on its forecast to last. In the game a stock's forecast only changes by a
 * tiny drift inside a market cycle; every TicksPerCycle ticks each stock flips to the mirror forecast with 45%
 * chance (StockMarket.ts stockMarketCycle), all on the same tick. So:
 *   - with the cycle clock running (`ticksLeft` = ticks until the next boundary update): the updates before the
 *     boundary, `ticksLeft - 1` of them, since the boundary update itself already uses the flipped forecast;
 *   - without it: half a cycle, the average wait until a boundary. That ignores the 55% chance the forecast
 *     also survives the boundary, so it errs on the cautious side.
 * @param {number|null} ticksLeft
 * @param {number} perCycle TicksPerCycle from ns.stock.getConstants()
 */
export function holdHorizon(ticksLeft, perCycle) {
	if (ticksLeft === null || ticksLeft === undefined) return perCycle / 2;
	return Math.max(0, ticksLeft - 1);
}

/**
 * Expected profit of putting `value` dollars into a stock whose price is expected to drift `expected` (fraction) per tick,
 * held for `horizon` ticks, after the spread (buy at ask, sell at bid) and the commission on both trades.
 */
export function netEdge({ expected, horizon, spread, value, commission }) {
	return value * (expected * horizon - spread) - 2 * commission;
}

/**
 * Expected gain per tick from a swap: dollars moved out of `held` and into `candidate` (both per-tick drifts), over the
 * horizon, after the candidate's round trip. The held position's own exit is not charged: it would be sold at some point
 * anyway, so selling it now only moves the cost earlier.
 */
export function swapEdge({ heldExpected, candidateExpected, horizon, candidateSpread, value, commission }) {
	return value * ((candidateExpected - heldExpected) * horizon - candidateSpread) - 2 * commission;
}

/**
 * Cost of a learned guess of an access price. The 4S price is the base price times a BitNode multiplier (x2 in BitNode 7,
 * x4 in BitNode 9, 1 elsewhere), which ns.stock.getConstants() does not show. `known` is that multiplier when the saved
 * BitNode multipliers have it (null otherwise); `factor` is what earlier refusals taught us.
 */
export function accessCostGuess(base, known, factor) {
	return base * (known ?? 1) * factor;
}

/**
 * What a refused purchase teaches: the price was higher than guessed even though the cash covered the guess, so double
 * the factor (capped, so a purchase the game refuses for another reason cannot grow the guess without bound).
 */
export function learnFactor(factor, cap = 64) {
	return Math.min(cap, factor * 2);
}

/**
 * Knows when the market's cycle boundaries happen. At a boundary each stock flips its forecast to the mirror image with
 * 45% chance, so a tick on which many stocks cross 0.5 at once marks one, and the next is exactly `perCycle` ticks later.
 * Only works with exact forecasts (4S). The signal is strong (about 15 of 33 stocks flip, an ordinary tick has none), so
 * a clear majority of the expected flips re-syncs the clock; between detections it just counts.
 */
export class CycleClock {
	/**
	 * @param {number} perCycle ticks between boundaries (TicksPerCycle)
	 * @param {number} minShare share of the stocks that must cross 0.5 on one tick to call it a boundary
	 */
	constructor(perCycle, minShare = 0.25) {
		this.perCycle = perCycle;
		this.minShare = minShare;
		/** @type {number[]|null} */
		this.previous = null;
		/** @type {number|null} tick of the last boundary seen */
		this.last = null;
	}

	/** Feed this tick's forecasts of every stock (same order each call). Returns true when it saw a boundary. */
	observe(tick, forecasts) {
		const before = this.previous;
		this.previous = forecasts.slice();
		if (!before || before.length !== forecasts.length || forecasts.length === 0) return false;
		let crossed = 0;
		for (let index = 0; index < forecasts.length; index++) {
			const was = before[index] - 0.5;
			const now = forecasts[index] - 0.5;
			// Ignore stocks hovering at 0.5: ordinary drift can cross there without any flip.
			if (Math.abs(was) >= 0.01 && Math.abs(now) >= 0.01 && was * now < 0) crossed++;
		}
		if (crossed < Math.max(3, Math.ceil(this.minShare * forecasts.length))) return false;
		this.last = tick;
		return true;
	}

	/** Ticks until the next boundary update (perCycle right at a boundary), or null before the first one was seen. */
	ticksLeft(tick) {
		if (this.last === null) return null;
		return this.perCycle - ((tick - this.last) % this.perCycle);
	}
}

/**
 * The cash another buyer is about to need, if holding back for it is cheap: the smallest `needCash` among the one-shot
 * notes on the gate port (singularity/ready.js: home RAM, cores, programs, donations) that are fresh and that income
 * will cover within `windowMs`. Anything further away is not waited for. 0 when there is none.
 * @param {Record<string, any>} gates readGates() result
 * @param {{ now: number, cash: number, perSecond: number, windowMs: number, maxAgeMs: number }} when
 */
export function pendingClaim(gates, { now, cash, perSecond, windowMs, maxAgeMs }) {
	let claim = 0;
	for (const note of Object.values(gates ?? {})) {
		if (!note || note.done || !Number.isFinite(note.needCash) || note.needCash <= 0) continue;
		if (now - (note.time ?? 0) > maxAgeMs) continue;
		const gap = note.needCash - cash;
		if (gap > Math.max(0, perSecond) * (windowMs / 1000)) continue; // too far away to be worth idling cash for
		if (claim === 0 || note.needCash < claim) claim = note.needCash;
	}
	return claim;
}
