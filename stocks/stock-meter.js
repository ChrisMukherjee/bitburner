// Design: docs/stocks.md
// @ts-check
// How well is the trader doing? Time-weighted figures for stock-trader.js's summary (port 26, tools/status.js, the log).
// Pure bookkeeping on numbers, no ns calls, so importing it costs no RAM and the tests run it as is.

const HOUR_MS = 3_600_000;

/** Counters the trade functions add to. All dollars. */
export function newStats() {
	return { realized: 0, trades: 0, spreadPaid: 0, commissionPaid: 0, priceGain: 0, expectedGain: 0 };
}

/** Adds one trade's cost: `shares` bought at `ask` or sold at `bid`, around the mid price. */
export function addTradeCost(stats, shares, ask, bid, commission) {
	if (!stats) return;
	stats.spreadPaid = (stats.spreadPaid ?? 0) + shares * Math.max(0, ask - bid) / 2;
	stats.commissionPaid = (stats.commissionPaid ?? 0) + commission;
}

/**
 * What the positions held since the last tick did on this one: the price change they actually had, and the change the
 * model expected (forecast x volatility, only meaningful with exact forecasts). Their ratio says whether the model is
 * calibrated: well below 1 means the drift is being lost to flips and late exits.
 * @param {Record<string, {shares: number, bid: number, expected: number}>} held snapshot taken at the end of the last tick
 * @param {(sym: string) => number} bidNow
 * @param {boolean} exact
 */
export function accrueDrift(stats, held, bidNow, exact) {
	for (const [sym, was] of Object.entries(held)) {
		stats.priceGain += was.shares * (bidNow(sym) - was.bid);
		if (exact) stats.expectedGain += was.shares * was.bid * was.expected;
	}
}

/**
 * Time-weighted figures since `start`. Call record() once per tick after the trades.
 *   value   - what the positions would sell for
 *   idle    - cash above the reserve that is not invested (could be working but is not)
 *   earned  - money made by stocks since the install, holdings included (profit so far, access fees included)
 */
export class Meter {
	constructor(now, earned) {
		this.start = now;
		this.last = now;
		this.earned0 = earned;
		this.capitalMs = 0; // dollar-ms of capital that was working or could have been (value + idle)
		this.investedMs = 0;
		this.heldBackMs = 0; // time new buying was held back for another buyer
		this.pnl = 0;
		this.peak = 0;
		this.maxDrawdown = 0;
	}

	record({ now, value, idle, earned, heldBack = false }) {
		const dt = Math.max(0, now - this.last);
		this.last = now;
		this.capitalMs += (value + idle) * dt;
		this.investedMs += value * dt;
		if (heldBack) this.heldBackMs += dt;
		this.pnl = earned - this.earned0;
		this.peak = Math.max(this.peak, this.pnl);
		this.maxDrawdown = Math.max(this.maxDrawdown, this.peak - this.pnl);
	}

	/** The numbers the summary shows. Shares are 0-1; returnPerHour is profit per hour over the average capital. */
	snapshot(now, stats) {
		const elapsed = Math.max(0, now - this.start);
		const hours = elapsed / HOUR_MS;
		const averageCapital = elapsed > 0 ? this.capitalMs / elapsed : 0;
		return {
			sinceMs: elapsed,
			profit: this.pnl,
			perHour: hours > 0 ? this.pnl / hours : 0,
			returnPerHour: hours > 0 && averageCapital > 0 ? this.pnl / hours / averageCapital : 0,
			invested: this.capitalMs > 0 ? this.investedMs / this.capitalMs : 0,
			idle: this.capitalMs > 0 ? 1 - this.investedMs / this.capitalMs : 0,
			heldBack: elapsed > 0 ? this.heldBackMs / elapsed : 0,
			maxDrawdown: this.maxDrawdown,
			costs: (stats?.spreadPaid ?? 0) + (stats?.commissionPaid ?? 0),
			priceGain: stats?.priceGain ?? 0,
			expectedGain: stats?.expectedGain ?? 0,
			capture: stats && stats.expectedGain > 0 ? stats.priceGain / stats.expectedGain : null,
		};
	}
}
