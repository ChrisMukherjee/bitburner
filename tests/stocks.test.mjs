// stocks/stock-trader.js beyond the no-4S buy gate: selling, buying order and caps, price history, the influence post.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { SYMBOL_SERVERS, STOCK_INFLUENCE_PORT } from "/stocks/stock-servers.js";
import { outlook, buyBest, sellIfTurned, sellAll, postInfluence, recordTick, upShare } from "/stocks/stock-trader.js";

const COMMISSION = 1e5;
/** positions: sym -> [longShares, longAvg, shortShares, shortAvg]; prices: sym -> price. */
function market({ positions = {}, prices = {}, cash = 1e9, maxShares = 1e6 } = {}) {
	const sold = [];
	const bought = [];
	const ns = fakeNs({
		overrides: {
			getPlayer: () => ({ money: cash }),
			format: { percent: (v) => `${Math.round(v * 100)}%` },
			stock: {
				getConstants: () => ({ StockMarketCommission: COMMISSION }),
				getPosition: (sym) => positions[sym] ?? [0, 0, 0, 0],
				getMaxShares: () => maxShares,
				getAskPrice: (sym) => prices[sym] ?? 100,
				getBidPrice: (sym) => prices[sym] ?? 100,
				sellStock: (sym, shares) => { sold.push([sym, shares]); return prices[sym] ?? 100; },
				buyStock: (sym, shares) => { bought.push([sym, shares]); return prices[sym] ?? 100; },
			},
		},
	});
	return { ns, sold, bought };
}
const exactView = (sym, forecast, volatility = 0.01, near = forecast) =>
	({ sym, ready: true, buyReady: true, exact: true, forecast, nearForecast: near, volatility, expected: (forecast - 0.5) * volatility });
const guessView = (sym, forecast, near = forecast, volatility = 0.01) =>
	({ sym, ready: true, buyReady: true, exact: false, forecast, nearForecast: near, volatility, expected: (forecast - 0.5) * volatility });
const policy = { reserve: 5e6, maxFraction: 0.9 };
const fresh = () => ({ realized: 0, trades: 0 });

test("upShare counts the share of up moves in the last span only", () => {
	assert.equal(upShare([-1, -1, 1, 1], 2), 1);
	assert.equal(upShare([1, 1, -1, -1], 2), 0);
	assert.equal(upShare([1, -1, 1, -1], 10), 0.5);
});

test("recordTick appends relative changes, skips unchanged prices and keeps the long window", () => {
	const prices = { AAA: 110, BBB: 50 };
	const { ns } = market({ prices });
	const history = { AAA: [], BBB: [] };
	const last = { AAA: 100, BBB: 50 };
	recordTick(ns, ["AAA", "BBB"], history, last);
	assert.ok(Math.abs(history.AAA[0] - 0.1) < 1e-9);
	assert.deepEqual(history.BBB, [], "an unchanged price says nothing");
	assert.equal(last.AAA, 110);
	history.AAA = Array.from({ length: 40 }, () => 0.01);
	prices.AAA = 120;
	recordTick(ns, ["AAA"], history, last);
	assert.equal(history.AAA.length, 40, "oldest tick dropped");
	assert.ok(history.AAA[39] > 0.05);
});

test("selling: a held stock goes when its long-window forecast falls below sellForecast", () => {
	const { ns, sold } = market({ positions: { AAA: [1000, 90, 0, 0] } });
	sellIfTurned(ns, exactView("AAA", 0.45), fresh());
	assert.deepEqual(sold, [["AAA", 1000]]);
});

test("selling: a stock above the sell line is kept, and nothing is sold that isn't held", () => {
	const keep = market({ positions: { AAA: [1000, 90, 0, 0] } });
	sellIfTurned(keep.ns, exactView("AAA", 0.55), fresh());
	assert.deepEqual(keep.sold, []);
	const empty = market({});
	sellIfTurned(empty.ns, exactView("AAA", 0.2), fresh());
	assert.deepEqual(empty.sold, []);
});

test("estimating: a flip on the short window sells even though the long window still looks fine", () => {
	const { ns, sold } = market({ positions: { AAA: [500, 90, 0, 0] } });
	sellIfTurned(ns, guessView("AAA", 0.62, 0.3), fresh());
	assert.deepEqual(sold, [["AAA", 500]]);
	const calm = market({ positions: { AAA: [500, 90, 0, 0] } });
	sellIfTurned(calm.ns, guessView("AAA", 0.62, 0.5), fresh());
	assert.deepEqual(calm.sold, []);
});

test("a stock still warming up after a restart is held, not sold on a guess", () => {
	const { ns, sold } = market({ positions: { AAA: [500, 90, 0, 0] } });
	sellIfTurned(ns, { ...guessView("AAA", 0.5, 0.1), ready: false }, fresh());
	assert.deepEqual(sold, []);
});

test("sellAll books the profit net of both commissions and returns the proceeds", () => {
	const { ns } = market({ positions: { AAA: [1000, 90, 0, 0] }, prices: { AAA: 100 } });
	const stats = fresh();
	const proceeds = sellAll(ns, "AAA", "test", stats);
	assert.equal(stats.trades, 1);
	assert.equal(stats.realized, 1000 * 10 - 2 * COMMISSION);
	assert.equal(proceeds, 1000 * 100 - COMMISSION);
	assert.equal(sellAll(ns, "BBB", "nothing held", stats), 0);
	assert.equal(stats.trades, 1);
});

test("buying: the best expected gain goes first, and weak forecasts are not bought", () => {
	const { ns, bought } = market({ cash: 1e9 });
	buyBest(ns, [exactView("LOW", 0.58), exactView("TOP", 0.75), exactView("MEH", 0.52)], policy, 5e6, fresh());
	assert.equal(bought[0][0], "TOP");
	assert.ok(bought.some(([sym]) => sym === "LOW"));
	assert.ok(!bought.some(([sym]) => sym === "MEH"), "0.52 is under buyForecast 0.55");
});

test("buying: one stock may hold at most maxPerStock of cash plus holdings", () => {
	const { ns, bought } = market({ cash: 1e9 });
	buyBest(ns, [exactView("TOP", 0.8)], { reserve: 0, maxFraction: 1 }, 5e6, fresh());
	assert.equal(bought.length, 1);
	assert.ok(bought[0][1] * 100 <= 0.25 * 1e9 + 1, `bought ${bought[0][1] * 100} of 1e9`);
});

test("buying: room under the share limit is respected, and a stock with an open short is skipped", () => {
	const room = market({ cash: 1e9, maxShares: 1000, positions: { TOP: [900, 100, 0, 0] } });
	buyBest(room.ns, [exactView("TOP", 0.8)], { reserve: 0, maxFraction: 1 }, 1e3, fresh());
	assert.deepEqual(room.bought, [["TOP", 100]]);
	const shorted = market({ cash: 1e9, positions: { TOP: [0, 0, 500, 100] } });
	buyBest(shorted.ns, [exactView("TOP", 0.8)], { reserve: 0, maxFraction: 1 }, 1e3, fresh());
	assert.deepEqual(shorted.bought, []);
});

test("buying: nothing happens when the budget is under the minimum trade", () => {
	const { ns, bought } = market({ cash: 6e6 }); // 1m above the reserve, minTrade 5m
	buyBest(ns, [exactView("TOP", 0.8)], policy, 5e6, fresh());
	assert.deepEqual(bought, []);
});

test("buying: a stock whose last ticks already point down is skipped", () => {
	const { ns, bought } = market({ cash: 1e9 });
	buyBest(ns, [guessView("DIP", 0.7, 0.4)], policy, 5e6, fresh());
	assert.deepEqual(bought, []);
});

test("influence port lists the company servers of held longs only", () => {
	const { ns } = market({ positions: { ECP: [10, 1, 0, 0], MGCP: [0, 0, 0, 0], WDS: [10, 1, 0, 0] } });
	postInfluence(ns, ["ECP", "MGCP", "WDS"]);
	assert.deepEqual(ns.portJson(STOCK_INFLUENCE_PORT), { grow: ["ecorp"], hack: [] });
});

test("influence port is emptied of old hosts when nothing is held any more", () => {
	const { ns } = market({});
	ns.writePort(STOCK_INFLUENCE_PORT, JSON.stringify({ grow: ["ecorp"], hack: [] }));
	postInfluence(ns, ["ECP"]);
	assert.deepEqual(ns.portJson(STOCK_INFLUENCE_PORT), { grow: [], hack: [] });
});

test("stock-servers: every symbol maps to one distinct server", () => {
	const hosts = Object.values(SYMBOL_SERVERS);
	assert.equal(new Set(hosts).size, hosts.length);
	assert.ok(Object.keys(SYMBOL_SERVERS).every((sym) => /^[A-Z]{2,5}$/.test(sym)));
	assert.equal(SYMBOL_SERVERS.WDS, undefined, "Watchdog Security has no server");
});

test("outlook with estimates: expected gain is signed by direction and zero on an unready history", () => {
	const down = outlook(null, "AAA", false, Array.from({ length: 40 }, (_, i) => (i % 4 === 3 ? 0.01 : -0.01)));
	assert.ok(down.expected < 0 && down.forecast < 0.5);
	const young = outlook(null, "AAA", false, [0.01, 0.01]);
	assert.equal(young.ready, false);
	assert.equal(young.expected, 0);
});
