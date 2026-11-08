// stocks/stock-trader.js without 4S data: when a stock may be bought on its price history.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { outlook, buyBest } from "/stocks/stock-trader.js";

// An upward run: three of every four ticks up (an up-share of 0.75, well past the 0.60 buy line).
const upMoves = (count) => Array.from({ length: count }, (_, i) => (i % 4 === 3 ? -0.01 : 0.01));

/** A trader's world: cash, and one stock priced $100 that nothing is held in yet. */
function market() {
	const bought = [];
	const ns = fakeNs({
		overrides: {
			getPlayer: () => ({ money: 1e9 }),
			format: { percent: (value) => `${Math.round(value * 100)}%` },
			stock: {
				getConstants: () => ({ StockMarketCommission: 1e5 }),
				getPosition: () => [0, 0, 0, 0],
				getMaxShares: () => 1e6,
				getAskPrice: () => 100,
				getBidPrice: () => 100,
				buyStock: (sym, shares) => { bought.push([sym, shares]); return 100; },
			},
		},
	});
	return { ns, bought };
}
const policy = { reserve: 5e6, maxFraction: 0.9 };

test("a stock needs the full history before it is bought, but 15 ticks are enough to hold or sell it", () => {
	const young = outlook(null, "AAA", false, upMoves(20));
	assert.equal(young.ready, true);
	assert.equal(young.buyReady, false);
	assert.ok(young.forecast >= 0.6, "the short history looks bullish, which is exactly the trap");
	const full = outlook(null, "AAA", false, upMoves(40));
	assert.equal(full.buyReady, true);
	assert.equal(outlook(null, "AAA", false, upMoves(10)).ready, false);
});

test("regression: a bullish stock with only 20 ticks of history is not bought; with 40 it is", () => {
	const early = market();
	buyBest(early.ns, [outlook(early.ns, "AAA", false, upMoves(20))], policy, 5e6, { realized: 0, trades: 0 });
	assert.deepEqual(early.bought, []);
	const late = market();
	buyBest(late.ns, [outlook(late.ns, "AAA", false, upMoves(40))], policy, 5e6, { realized: 0, trades: 0 });
	assert.equal(late.bought.length, 1);
	assert.equal(late.bought[0][0], "AAA");
});

test("with 4S data the forecast is exact, so no history is needed", () => {
	const view = outlook(fakeNs({ overrides: { stock: { getForecast: () => 0.7, getVolatility: () => 0.01 } } }), "AAA", true, []);
	assert.equal(view.buyReady, true);
	assert.equal(view.forecast, 0.7);
});
