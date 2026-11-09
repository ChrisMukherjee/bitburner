// The stock trader's cost-aware rules, cycle clock, rotation, holding cash for other buyers, learning the 4S price,
// the measuring figures and the status lines (stocks/stock-math.js, stock-meter.js, stock-trader.js, tools/status.js).
// Numbers follow the game's market (src/StockMarket in v3.0.0): ticks of 6s, cycles of 75 ticks, spread per stock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import {
	spreadFraction, holdHorizon, netEdge, swapEdge, accessCostGuess, learnFactor, CycleClock, pendingClaim,
} from "/stocks/stock-math.js";
import { Meter, newStats, addTradeCost, accrueDrift } from "/stocks/stock-meter.js";
import {
	buyBest, snapshotHeld, absorbAccessResult, newAccessState, stockSettings, ACCESS_RESULT_FILE, main as traderMain,
} from "/stocks/stock-trader.js";
import { stockLines } from "/tools/status.js";

const COMMISSION = 1e5;
const policy = { reserve: 5e6, maxFraction: 0.9 };
const exactView = (sym, forecast, volatility = 0.01) =>
	({ sym, ready: true, buyReady: true, exact: true, forecast, nearForecast: forecast, volatility, expected: (forecast - 0.5) * volatility });

/**
 * A market: prices as { ask, bid } per symbol (default 100 both), positions sym -> [shares, avg, 0, 0].
 * Buying and selling update the positions and the cash, so a second pass sees the first.
 */
function market({ cash = 1e9, positions = {}, prices = {}, maxShares = 1e9 } = {}) {
	const book = { cash, positions: { ...positions }, bought: [], sold: [] };
	const priceOf = (sym) => prices[sym] ?? { ask: 100, bid: 100 };
	const ns = fakeNs({
		overrides: {
			getPlayer: () => ({ money: book.cash }),
			format: { percent: (value) => `${Math.round(value * 100)}%` },
			stock: {
				getConstants: () => ({ StockMarketCommission: COMMISSION, TicksPerCycle: 75, msPerStockUpdate: 6000 }),
				getPosition: (sym) => book.positions[sym] ?? [0, 0, 0, 0],
				getMaxShares: () => maxShares,
				getAskPrice: (sym) => priceOf(sym).ask,
				getBidPrice: (sym) => priceOf(sym).bid,
				buyStock: (sym, shares) => {
					const { ask } = priceOf(sym);
					book.cash -= shares * ask + COMMISSION;
					const [had] = book.positions[sym] ?? [0];
					book.positions[sym] = [had + shares, ask, 0, 0];
					book.bought.push([sym, shares]);
					return ask;
				},
				sellStock: (sym, shares) => {
					const { bid } = priceOf(sym);
					const [had, avg] = book.positions[sym] ?? [0, 0];
					const count = Math.min(had, shares);
					book.cash += count * bid - COMMISSION;
					book.positions[sym] = [had - count, avg, 0, 0];
					book.sold.push([sym, count]);
					return bid;
				},
			},
		},
	});
	return { ns, book };
}

test("spread: the gap between ask and bid as a share of the mid price", () => {
	assert.equal(spreadFraction(101, 99), 0.02);
	assert.equal(spreadFraction(100, 100), 0);
	assert.equal(spreadFraction(0, 0), 0);
});

test("horizon: ticks left minus the boundary update, or half a cycle while the clock is unknown", () => {
	assert.equal(holdHorizon(null, 75), 37.5);
	assert.equal(holdHorizon(75, 75), 74);
	assert.equal(holdHorizon(1, 75), 0, "the boundary update itself already uses the flipped forecast");
});

test("edge: drift over the horizon must beat the spread and both commissions", () => {
	// 0.1% a tick for 40 ticks is 4%; a 1% spread leaves 3% of $10m = $300k, minus $200k of commission.
	const base = { expected: 0.001, horizon: 40, spread: 0.01, value: 10e6, commission: COMMISSION };
	assert.equal(Math.round(netEdge(base)), 100_000);
	assert.ok(netEdge({ ...base, horizon: 10 }) < 0, "10 ticks of drift is 1%: just the spread, nothing left for commission");
	assert.ok(swapEdge({ heldExpected: 0.0004, candidateExpected: 0.001, horizon: 40, candidateSpread: 0.01, value: 10e6, commission: COMMISSION }) < 0);
	assert.ok(swapEdge({ heldExpected: 0, candidateExpected: 0.002, horizon: 40, candidateSpread: 0.01, value: 10e6, commission: COMMISSION }) > 0);
});

test("4S price: BitNode multiplier when known, else learned by doubling after each refusal, capped", () => {
	assert.equal(accessCostGuess(25e9, null, 1), 25e9);
	assert.equal(accessCostGuess(25e9, 2, 1), 50e9);
	assert.equal(accessCostGuess(25e9, null, learnFactor(1)), 50e9);
	assert.equal(learnFactor(64), 64);
});

// ---- cycle clock ----

const calm = (count) => Array.from({ length: count }, (_, i) => (i % 2 ? 0.62 : 0.38));
const flipped = (forecasts, which) => forecasts.map((f, i) => (which.includes(i) ? 1 - f : f));

test("clock: a tick on which a quarter of the stocks cross 0.5 is a cycle boundary; the next is 75 ticks later", () => {
	const clock = new CycleClock(75);
	const first = calm(20);
	assert.equal(clock.observe(1, first), false);
	assert.equal(clock.ticksLeft(1), null, "unknown until the first boundary");
	assert.equal(clock.observe(2, flipped(first, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])), true);
	assert.equal(clock.ticksLeft(2), 75);
	assert.equal(clock.ticksLeft(3), 74);
	assert.equal(clock.ticksLeft(76), 1);
	assert.equal(clock.ticksLeft(77), 75, "wraps to the next cycle without a new sighting");
});

test("clock: a few stocks drifting across 0.5, or sitting near it, are not a boundary", () => {
	const clock = new CycleClock(75);
	const base = calm(20);
	clock.observe(1, base);
	assert.equal(clock.observe(2, flipped(base, [0, 1])), false);
	const hovering = base.map((_, i) => (i < 12 ? 0.504 : base[i]));
	clock.observe(3, hovering);
	assert.equal(clock.observe(4, hovering.map((f, i) => (i < 12 ? 0.496 : f))), false, "inside the 0.01 dead zone");
	assert.equal(clock.last, null);
});

test("clock: a later clear sighting re-syncs it", () => {
	const clock = new CycleClock(75);
	const a = calm(20);
	clock.observe(1, a);
	clock.observe(2, flipped(a, [0, 1, 2, 3, 4, 5, 6, 7]));
	const b = flipped(a, [0, 1, 2, 3, 4, 5, 6, 7]);
	clock.observe(80, b); // a missed tick shifted the count by 3
	clock.observe(81, flipped(b, [10, 11, 12, 13, 14, 15, 16, 17]));
	assert.equal(clock.ticksLeft(81), 75);
});

// ---- buying with costs ----

test("buying: without options the plain rule applies (a thin edge is still bought)", () => {
	const { ns, book } = market({ prices: { AAA: { ask: 101, bid: 99 } } });
	buyBest(ns, [exactView("AAA", 0.56, 0.003)], policy, COMMISSION * 50, newStats());
	assert.equal(book.bought.length, 1);
});

test("buying: cost-aware skips an edge the spread would eat, and buys one that pays", () => {
	const wide = { AAA: { ask: 101, bid: 99 } }; // 2% round trip
	const thin = market({ prices: wide });
	// 0.56 at 0.3% volatility: 0.018% a tick, 37 ticks = 0.67%, under the 2% spread.
	buyBest(thin.ns, [exactView("AAA", 0.56, 0.003)], policy, COMMISSION * 50, newStats(), { costAware: true, horizon: 37 });
	assert.equal(thin.book.bought.length, 0);
	const rich = market({ prices: wide });
	// 0.70 at 1% volatility: 0.2% a tick, 37 ticks = 7.4%.
	buyBest(rich.ns, [exactView("AAA", 0.7, 0.01)], policy, COMMISSION * 50, newStats(), { costAware: true, horizon: 37 });
	assert.equal(rich.book.bought.length, 1);
});

test("buying: cost-aware buys nothing on the last tick before a cycle boundary", () => {
	const { ns, book } = market();
	buyBest(ns, [exactView("AAA", 0.9, 0.02)], policy, COMMISSION * 50, newStats(), { costAware: true, horizon: holdHorizon(1, 75) });
	assert.equal(book.bought.length, 0);
});

test("buying: a trade's spread and commission are counted", () => {
	const { ns } = market({ prices: { AAA: { ask: 101, bid: 99 } } });
	const stats = newStats();
	buyBest(ns, [exactView("AAA", 0.7, 0.01)], policy, COMMISSION * 50, stats, { costAware: true, horizon: 37 });
	assert.ok(stats.spreadPaid > 0 && stats.commissionPaid === COMMISSION);
});

// ---- cash held for other buyers ----

test("claim: cash another buyer needs is not spent on shares", () => {
	const held = market({ cash: 900e6 });
	buyBest(held.ns, [exactView("AAA", 0.7, 0.01)], policy, COMMISSION * 50, newStats(), { claim: 1e9 });
	assert.equal(held.book.bought.length, 0, "cash is under the claim");
	const spare = market({ cash: 1.5e9 });
	buyBest(spare.ns, [exactView("AAA", 0.7, 0.01)], policy, COMMISSION * 50, newStats(), { claim: 1e9 });
	const [, shares] = spare.book.bought[0];
	assert.ok(shares * 100 <= 0.5e9, "only what is above the claim is spent");
});

test("claim: the nearest fresh note within one cycle of income counts; stale, done and far ones do not", () => {
	const now = 1_000_000_000;
	const when = { now, cash: 4e9, perSecond: 1e7, windowMs: 450_000, maxAgeMs: 900_000 };
	const gates = {
		"home-ram": { needCash: 6e9, time: now - 1000 },
		"home-cores": { needCash: 20e9, time: now - 1000 }, // 16e9 short, income gives 4.5e9 in a cycle
		programs: { needCash: 5e9, time: now - 2_000_000 }, // older than two cycles
		donate: { done: true, time: now },
	};
	assert.equal(pendingClaim(gates, when), 6e9);
	assert.equal(pendingClaim({}, when), 0);
	assert.equal(pendingClaim({ a: { needCash: 3e9, time: now } }, when), 3e9, "cash already above the need still holds it for the buyer");
});

// ---- rotation ----

test("rotation: no cash left and a clearly better stock sells part of the weakest holding to buy it", () => {
	const { ns, book } = market({
		cash: 5e6,
		positions: { WEAK: [2e6, 100, 0, 0] }, // $200m held, cash at the reserve
	});
	const views = [exactView("WEAK", 0.56, 0.01), exactView("BEST", 0.8, 0.02)];
	buyBest(ns, views, policy, COMMISSION * 50, newStats(), { costAware: true, rotate: true, horizon: 37 });
	assert.ok(book.sold.some(([sym]) => sym === "WEAK"), "weak holding sold");
	assert.ok(book.bought.some(([sym]) => sym === "BEST"), "better stock bought with it");
});

test("rotation: a small improvement does not pay for the swap", () => {
	const { ns, book } = market({ cash: 5e6, positions: { WEAK: [2e6, 100, 0, 0] } });
	const views = [exactView("WEAK", 0.69, 0.01), exactView("BEST", 0.7, 0.01)];
	buyBest(ns, views, policy, COMMISSION * 50, newStats(), { costAware: true, rotate: true, horizon: 37 });
	assert.equal(book.sold.length, 0);
});

test("rotation: off without the switch, and never on estimated forecasts", () => {
	const off = market({ cash: 5e6, positions: { WEAK: [2e6, 100, 0, 0] } });
	buyBest(off.ns, [exactView("WEAK", 0.56, 0.01), exactView("BEST", 0.8, 0.02)], policy, COMMISSION * 50, newStats(), { costAware: true, horizon: 37 });
	assert.equal(off.book.sold.length, 0);
	const guess = market({ cash: 5e6, positions: { WEAK: [2e6, 100, 0, 0] } });
	const estimated = (view) => ({ ...view, exact: false });
	buyBest(guess.ns, [estimated(exactView("WEAK", 0.56, 0.01)), estimated(exactView("BEST", 0.8, 0.02))], policy, COMMISSION * 50, newStats(), { costAware: true, rotate: true, horizon: 37 });
	assert.equal(guess.book.sold.length, 0);
});

test("rotation: a full stock is skipped for the next candidate that has room", () => {
	const { ns, book } = market({
		cash: 5e6,
		positions: { FULL: [2e6, 100, 0, 0], WEAK: [2e6, 100, 0, 0] }, // each $200m of a $405m book: FULL is over the 25% cap
	});
	const views = [exactView("FULL", 0.85, 0.02), exactView("OPEN", 0.75, 0.02), exactView("WEAK", 0.56, 0.01)];
	buyBest(ns, views, policy, COMMISSION * 50, newStats(), { costAware: true, rotate: true, horizon: 37 });
	assert.ok(book.sold.every(([sym]) => sym === "WEAK"));
	assert.ok(book.bought.every(([sym]) => sym === "OPEN"));
});

// ---- the settings switches ----

test("settings: everything is on unless the config turns it off", () => {
	assert.deepEqual(stockSettings({}), { costAware: true, cycleClock: true, rotate: true, holdBackForBuyers: true });
	assert.equal(stockSettings({ stocks: { rotate: false } }).rotate, false);
	assert.equal(stockSettings({ stocks: { rotate: false } }).costAware, true);
});

// ---- learning from the access helper ----

test("access: a refusal at our price guess doubles the guess once per report; old reports and repeats are ignored", () => {
	const access = newAccessState(1000);
	const ns = fakeNs({ files: { [ACCESS_RESULT_FILE]: JSON.stringify({ time: 2000, what: "4s-poor", cash: 30e9 }) }, overrides: { format: { number: String } } });
	absorbAccessResult(ns, access);
	assert.equal(access.factor, 2);
	absorbAccessResult(ns, access);
	assert.equal(access.factor, 2, "the same report is not counted twice");
	ns.write(ACCESS_RESULT_FILE, JSON.stringify({ time: 500, what: "4s-poor", cash: 1 }), "w");
	absorbAccessResult(ns, access);
	assert.equal(access.factor, 2, "a report from before this run");
	ns.write(ACCESS_RESULT_FILE, JSON.stringify({ time: 3000, what: "4s-poor", cash: 60e9 }), "w");
	absorbAccessResult(ns, access);
	assert.equal(access.factor, 4);
});

test("access: 4S turned off by the BitNode options stops the attempts", () => {
	const access = newAccessState(0);
	const ns = fakeNs({ files: { [ACCESS_RESULT_FILE]: JSON.stringify({ time: 5, what: "4s-disabled", cash: 1 }) } });
	absorbAccessResult(ns, access);
	assert.equal(access.fourSOff, true);
	assert.equal(ns.toasts.length, 1);
	absorbAccessResult(ns, access);
	assert.equal(ns.toasts.length, 1, "told once");
});

test("access: no report, or unreadable text, changes nothing", () => {
	const access = newAccessState(0);
	absorbAccessResult(fakeNs(), access);
	absorbAccessResult(fakeNs({ files: { [ACCESS_RESULT_FILE]: "{not json" } }), access);
	assert.deepEqual(access, newAccessState(0));
});

// ---- measuring ----

test("meter: profit per hour, return on working capital, invested and idle shares, drawdown", () => {
	const hour = 3_600_000;
	const meter = new Meter(0, 1000);
	meter.record({ now: hour / 2, value: 80, idle: 20, earned: 1010 }); // half an hour with $80 of $100 working
	meter.record({ now: hour, value: 100, idle: 0, earned: 1005 }); // peak +10 then back to +5
	const stats = newStats();
	const figures = meter.snapshot(hour, stats);
	assert.equal(figures.profit, 5);
	assert.equal(figures.perHour, 5);
	assert.equal(figures.maxDrawdown, 5);
	// capital: 100 the whole time; invested 80 for the first half and 100 for the second.
	assert.ok(Math.abs(figures.invested - 0.9) < 1e-9);
	assert.ok(Math.abs(figures.idle - 0.1) < 1e-9);
	assert.ok(Math.abs(figures.returnPerHour - 0.05) < 1e-9);
	assert.equal(figures.capture, null, "no expected drift recorded yet");
});

test("meter: time held back for another buyer is a share of the window", () => {
	const meter = new Meter(0, 0);
	meter.record({ now: 1000, value: 0, idle: 10, earned: 0, heldBack: true });
	meter.record({ now: 4000, value: 0, idle: 10, earned: 0, heldBack: false });
	assert.equal(meter.snapshot(4000, newStats()).heldBack, 0.25);
});

test("meter: drift captured is price gain over what the forecasts promised", () => {
	const stats = newStats();
	const held = { AAA: { shares: 1000, bid: 100, expected: 0.002 } }; // promised $200 on $100k
	accrueDrift(stats, held, () => 100.1, true); // went up 0.1%: $100
	assert.equal(Math.round(stats.priceGain), 100);
	assert.equal(Math.round(stats.expectedGain), 200);
	const figures = new Meter(0, 0).snapshot(1000, stats);
	assert.ok(Math.abs(figures.capture - 0.5) < 0.01);
	accrueDrift(stats, held, () => 100, false);
	assert.equal(Math.round(stats.expectedGain), 200, "estimated forecasts are not a promise worth measuring");
});

test("meter: a trade adds half the spread and the commission", () => {
	const stats = newStats();
	addTradeCost(stats, 1000, 101, 99, COMMISSION);
	assert.equal(stats.spreadPaid, 1000);
	assert.equal(stats.commissionPaid, COMMISSION);
	addTradeCost(undefined, 1, 1, 1, 1); // callers without stats are fine
});

test("held snapshot: shares, bid and the expected drift of each long", () => {
	const { ns } = market({ positions: { AAA: [10, 100, 0, 0] }, prices: { AAA: { ask: 101, bid: 99 } } });
	const held = snapshotHeld(ns, ["AAA", "BBB"], [exactView("AAA", 0.6, 0.01), exactView("BBB", 0.7, 0.01)]);
	assert.deepEqual(Object.keys(held), ["AAA"]);
	assert.equal(held.AAA.bid, 99);
	assert.ok(Math.abs(held.AAA.expected - 0.001) < 1e-12);
});

// ---- status lines ----

const fmt = {
	money: (n) => `$${n}`, percent: (n, digits = 0) => `${(n * 100).toFixed(digits)}%`, time: (ms) => `${Math.round(ms / 60000)}m`, ago: () => "5s ago",
};

test("status: not running, just started, and waiting for the TIX API each say so", () => {
	assert.deepEqual(stockLines(null, false, fmt), ["Stocks: stock-trader.js not running"]);
	assert.match(stockLines(null, true, fmt)[0], /just started/);
	const waiting = stockLines({ mode: "waiting", waitingFor: "TIX API", cost: 5e9, cash: 1e9, reserve: 5e6, time: 1 }, true, fmt);
	assert.match(waiting[0], /waiting for the TIX API, which costs \$5000000000/);
});

test("status: the measuring line appears once the window is ten minutes long", () => {
	const summary = {
		mode: "4S", positions: 3, value: 100, unrealized: 5, earned: 50, time: 1,
		measure: { sinceMs: 120_000, perHour: 10, returnPerHour: 0.2, invested: 0.9, idle: 0.1, heldBack: 0, maxDrawdown: 4, costs: 2, capture: 0.8 },
	};
	assert.equal(stockLines(summary, true, fmt).length, 1);
	const longer = stockLines({ ...summary, measure: { ...summary.measure, sinceMs: 1_800_000 } }, true, fmt);
	assert.equal(longer.length, 2);
	assert.match(longer[1], /\$10\/h \(20\.0%\/h of working capital\), invested 90%, idle 10%, max drawdown \$4/);
	assert.match(longer[1], /drift captured 80%/);
	assert.doesNotMatch(longer[1], /held back/);
});

// ---- the main loop ----

/** Runs the trader for `ticks` market ticks in a fake game, then stops it. */
async function runTrader({ ticks, tix = true, fourS = false, cash = 20e9, config = {}, files = {}, stopOnSleep = false }) {
	let tickNo = 0;
	const base = market({ cash });
	const forecasts = { AAA: 0.8, BBB: 0.3 };
	const ns = fakeNs({
		files: { "data/config.json": JSON.stringify(config), ...files },
		overrides: {
			args: [], flags: () => ({ _: [], "buy-4s": false, liquidate: false, promote: 0, "no-influence": true, "no-buy-tix": false }),
			getPlayer: () => ({ money: base.book.cash }),
			getMoneySources: () => ({ sinceInstall: { stock: 0 } }),
			getTotalScriptIncome: () => [0, 0],
			atExit: () => {},
			format: { percent: (value) => `${Math.round(value * 100)}%`, number: String, time: (ms) => `${Math.round(ms / 1000)}s` },
			sleep: async () => { if (stopOnSleep) throw new Error("stop"); },
			exec: () => 0,
			isRunning: () => false,
			stock: {
				...base.ns.stock,
				hasTixApiAccess: () => tix,
				has4SDataTixApi: () => fourS,
				getSymbols: () => ["AAA", "BBB"],
				getForecast: (sym) => forecasts[sym],
				getVolatility: () => 0.01,
				nextUpdate: async () => { if (++tickNo > ticks) throw new Error("stop"); },
			},
		},
	});
	try { await traderMain(ns); } catch (error) { if (error.message !== "stop") throw error; }
	return { ns, book: base.book };
}

test("main: the first tick posts a summary at once, with the measuring figures and the cycle clock still unknown", async () => {
	const { ns } = await runTrader({ ticks: 1, fourS: true });
	const summary = ns.portJson(26);
	assert.equal(summary.mode, "4S");
	assert.equal(summary.nextBoundary, null);
	assert.equal(summary.measure.sinceMs, 0);
	assert.equal(summary.claim, 0);
});

test("main: it trades on a bullish stock and not on a bearish one, and the summary shows the position", async () => {
	const { ns, book } = await runTrader({ ticks: 10, fourS: true });
	assert.ok(book.positions.AAA[0] > 0, "AAA at 80% is held");
	assert.equal(book.positions.BBB, undefined, "BBB at 30% is not");
	const summary = ns.portJson(26);
	assert.equal(summary.positions, 1);
});

test("main: waiting for the TIX API posts what it is waiting for instead of nothing", async () => {
	const { ns } = await runTrader({ ticks: 1, tix: false, cash: 1e9, stopOnSleep: true });
	const summary = ns.portJson(26);
	assert.equal(summary.mode, "waiting");
	assert.equal(summary.waitingFor, "TIX API");
	assert.equal(summary.cash, 1e9);
});

test("main: with the switches off it buys on the plain rule", async () => {
	const { book } = await runTrader({ ticks: 3, fourS: true, config: { stocks: { costAware: false, cycleClock: false, rotate: false, holdBackForBuyers: false } } });
	assert.ok(book.positions.AAA[0] > 0);
});
