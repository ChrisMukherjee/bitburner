// Design: docs/stocks.md
// @ts-check
import { loadConfig } from "/utils/config.js";
import { notify } from "/utils/notify.js";
import { readIncomeRate } from "/utils/income.js";
import { bitnodeMults } from "/utils/bitnode-mults.js";
import { createPolicyTracker, getBudget, getCash, formatMoney } from "/utils/spending.js";
import { readGates } from "/singularity/ready.js"; // the buyers' "I need this much cash" notes (port 33)
import { STOCK_INFLUENCE_PORT, SYMBOL_SERVERS } from "/stocks/stock-servers.js";
import { HOME_PASSWORD_FILE, PHISH_SCRIPT } from "/darknet/config.js"; // constants only, no RAM
import {
	spreadFraction, holdHorizon, netEdge, swapEdge, accessCostGuess, learnFactor, CycleClock, pendingClaim,
} from "/stocks/stock-math.js";
import { Meter, newStats, addTradeCost, accrueDrift } from "/stocks/stock-meter.js";
// tools/status.js peeks a one-line summary here (ports: 20 darknet ... 25 city plan).
const STOCK_SUMMARY_PORT = 26;
/** The access helper (workers/buy-market-access.js) leaves what it did here; this script learns from it. */
export const ACCESS_RESULT_FILE = "data/stock-access.json";

const CONFIG = {
	// Spending stages (reserve, maxFraction, ... by income) are `stockTrading` in the config
	// (config.js, data/config.json). The decisions below (cost-aware buying, the cycle clock, rotation, holding
	// cash back for other buyers) can each be switched off with `stocks` in the same file; all are on by default.
	// Each buy and sell costs a flat commission (~$100k), so tiny trades lose money.
	// A buy smaller than this many commissions is skipped.
	minTradeCommissions: 50,
	// Most of (cash + stocks) one stock may hold, so one wrong estimate can't sink everything.
	maxPerStock: 0.25,
	// With 4S data (exact forecasts): buy above buyForecast, sell once it drops below sellForecast.
	exact: { buyForecast: 0.55, sellForecast: 0.5 },
	// Without 4S, the forecast is estimated from the share of recent ticks that went up.
	// longWindow decides buys; shortWindow catches a forecast flip quickly.
	estimated: {
		longWindow: 40,
		shortWindow: 10,
		minHistory: 15, // ticks of history before a stock may be SOLD on its estimate
		buyHistory: 40, // ticks before it may be BOUGHT: the buy threshold's 90% bound assumes the full long window
		buyForecast: 0.6,
		sellForecast: 0.45, // on the long window
		flipForecast: 0.35, // on the short window: sell even if the long window still looks fine
	},
	summaryEveryTicks: 10,
	// Rotation: at most this many sell-to-fund-a-better-stock swaps in one tick.
	maxSwapsPerTick: 3,
	// Holding cash back for another buyer: a note counts for 2 market cycles (the buyers repost after every pass, so an
	// older one is from a buyer that is not running), and only when income closes the gap within one cycle.
	claimMaxAgeCycles: 2,
	claimWindowCycles: 1,
	// --promote: how many of the biggest longs get a promoteStock worker (threads split between them),
	// and how often (ticks) to re-pick them. promoteStock only runs ON a darknet server, so workers go to
	// darkweb and the stasis-linked servers (the only darknet servers home can exec on), using the passwords
	// darknet/dnet-manager.js saved. Phishing workers there are stopped as needed to make room; the crawler
	// refills whatever RAM is left with phishing again.
	promote: { script: "stocks/workers/promote-stock.js", targets: 2, retargetEveryTicks: 10 },
	// Buys the TIX API (and 4S with --buy-4s) in a one-shot helper, so the 2.5GB purchase calls
	// aren't held by the trader all run.
	accessScript: "stocks/workers/buy-market-access.js",
	// Without the TIX API, how often (ms) to check whether cash above the reserve covers it.
	waitForTixMs: 10000,
};

/** The switches in `stocks` in the config, all on unless the player turned one off. */
export function stockSettings(config) {
	return { costAware: true, cycleClock: true, rotate: true, holdBackForBuyers: true, ...(config?.stocks ?? {}) };
}

/**
 * Stock trader. Uses the exact forecast and volatility from the 4S Market Data TIX API when you
 * own it, otherwise estimates both from price history. Checked every tick, so buying 4S
 * mid-run switches it to exact mode (like Formulas.exe in the other managers).
 *
 * How the game's market works (src/StockMarket in v3.0.0), which the rules below follow: every tick (6s) each stock
 * moves up with probability = its forecast, by the same random size scaled by its volatility. The forecast barely
 * drifts inside a cycle of TicksPerCycle (75) ticks; at each cycle boundary every stock flips to its mirror forecast
 * with 45% chance, all on the same tick. Buying and selling cost the spread plus a flat commission. Our own trades
 * hardly move anything (they nudge the forecast 0.006 points per ~tens of thousands of shares, never below 55%).
 *
 * Every tick it also posts the servers of the companies it holds on a port, so the batcher's grow
 * workers push held longs up with { stock: true }.
 *
 * Longs only: shorting needs BitNode 8 or Source-File 8.2, and its buyShort/sellShort calls cost 5GB
 * even when unused. stock-trader-v3.js still has --short for when that's available.
 *
 * Without the TIX API it waits and buys it (through the helper) once cash above the reserve covers it.
 *
 * Flags:
 *   --buy-4s      buy the 4S Market Data TIX API as soon as cash above the reserve covers it
 *   --no-buy-tix  exit without the TIX API instead of waiting to buy it
 *   --liquidate   sell every position and exit
 *   --no-influence  don't post held companies (batcher hacks and grows leave the market alone)
 *   --promote N   run N threads of ns.dnet.promoteStock against the biggest longs. That raises
 *                 their volatility (not their forecast), so with 4S each tick's expected gain grows.
 *                 Only useful with 4S: without it the estimates get noisier too. The workers run on
 *                 darkweb and stasis-linked darknet servers (needs darknet/dnet-manager.js to have
 *                 opened them); with none reachable, promotion is skipped with a log note.
 */
export async function main(ns) {
	ns.disableLog("ALL");
	const flags = ns.flags([
		["buy-4s", false],
		["liquidate", false],
		["promote", 0],
		["no-influence", false],
		["no-buy-tix", false],
	]);

	const constants = ns.stock.getConstants();
	const config = loadConfig(ns);
	const settings = stockSettings(config);
	const getPolicy = createPolicyTracker(config.stockTrading);
	const access = newAccessState(Date.now());
	if (!ns.stock.hasTixApiAccess()) {
		if (flags["no-buy-tix"]) {
			ns.tprint("[stocks] no TIX API access; buy it at the WSE first.");
			return;
		}
		ns.tprint(`[stocks] no TIX API access; buying it once cash above the reserve covers ${formatMoney(ns, constants.TixApiCost)}.`);
		while (!ns.stock.hasTixApiAccess()) {
			const policy = getPolicy(ns);
			absorbAccessResult(ns, access);
			maybeBuyAccess(ns, constants.TixApiCost, policy, false);
			postWaiting(ns, "TIX API", constants.TixApiCost, policy);
			await ns.sleep(CONFIG.waitForTixMs);
		}
	}

	const symbols = ns.stock.getSymbols();
	if (flags.liquidate) {
		const proceeds = symbols.reduce((sum, sym) => sum + sellAll(ns, sym, "liquidate"), 0);
		ns.clearPort(STOCK_INFLUENCE_PORT);
		ns.clearPort(STOCK_SUMMARY_PORT); // nothing held now: readers (buy-augs, aug-buyer) mustn't count the old value
		ns.tprint(`[stocks] liquidated everything for ${formatMoney(ns, proceeds)}.`);
		return;
	}

	const minTrade = constants.StockMarketCommission * CONFIG.minTradeCommissions;
	const history = Object.fromEntries(symbols.map((sym) => [sym, []])); // relative price change per tick
	const lastPrice = Object.fromEntries(symbols.map((sym) => [sym, midPrice(ns, sym)]));
	const clock = new CycleClock(constants.TicksPerCycle);
	const cycleMs = constants.TicksPerCycle * constants.msPerStockUpdate;
	const fourSMult = bitnodeMults(ns);
	let session = null; // { stats, meter }: restarted when 4S arrives, so each window is one mode
	/** @type {Record<string, {shares: number, bid: number, expected: number}>} */
	let held = {}; // positions at the end of the last tick, for the drift accounting
	let exactWasOn = null; // null so the first tick always reports the mode
	let tick = 0;
	const promoters = {}; // sym -> { workers: [{ pid, host, threads }], threads }
	ns.atExit(() => {
		Object.values(promoters).forEach((entry) => entry.workers.forEach((worker) => ns.kill(worker.pid)));
		ns.clearPort(STOCK_INFLUENCE_PORT); // no trader watching the positions: stop steering prices
		ns.clearPort(STOCK_SUMMARY_PORT);
	});

	while (true) {
		await ns.stock.nextUpdate();
		tick++;
		const now = Date.now();
		recordTick(ns, symbols, history, lastPrice);

		absorbAccessResult(ns, access);
		if (flags["buy-4s"] && !ns.stock.has4SDataTixApi() && !access.fourSOff) {
			const known = fourSMult.known ? fourSMult.get("FourSigmaMarketDataApiCost") : null;
			maybeBuyAccess(ns, accessCostGuess(constants.MarketDataTixApi4SCost, known, access.factor), getPolicy(ns), true);
		}
		const exactOn = ns.stock.has4SDataTixApi();
		const outlooks = symbols.map((sym) => outlook(ns, sym, exactOn, history[sym]));
		if (exactOn !== exactWasOn) {
			const mode = `4S TIX API ${exactOn ? "found: exact forecasts on" : "not owned: estimating from price history"}.`;
			if (exactWasOn === null) ns.print(`[stocks] ${mode}`); // first tick: routine
			else notify(ns, "[stocks]", mode, "info"); // the mode changed mid-run: toast only
			exactWasOn = exactOn;
			session = { stats: newStats(), meter: new Meter(now, earnedNow(ns, symbols)) }; // measure each mode on its own
			held = {};
		}
		const { stats, meter } = session;
		accrueDrift(stats, held, (sym) => ns.stock.getBidPrice(sym), exactOn);

		if (exactOn && settings.cycleClock) clock.observe(tick, outlooks.map((view) => view.forecast));
		const ticksLeft = exactOn && settings.cycleClock ? clock.ticksLeft(tick) : null;
		const policy = getPolicy(ns);
		const claim = settings.holdBackForBuyers ? buyerClaim(ns, cycleMs) : 0;
		const options = {
			costAware: settings.costAware,
			rotate: settings.rotate,
			horizon: holdHorizon(ticksLeft, constants.TicksPerCycle),
			claim,
		};

		for (const view of outlooks) sellIfTurned(ns, view, stats);
		buyBest(ns, outlooks, policy, minTrade, stats, options);
		if (!flags["no-influence"]) postInfluence(ns, symbols);

		held = snapshotHeld(ns, symbols, outlooks);
		const value = Object.values(held).reduce((sum, entry) => sum + entry.shares * entry.bid, 0);
		meter.record({
			now, value, idle: Math.max(0, getCash(ns) - policy.reserve), earned: earnedNow(ns, symbols),
			heldBack: claim > policy.reserve,
		});

		if (flags.promote > 0 && tick % CONFIG.promote.retargetEveryTicks === 0) {
			retargetPromoters(ns, symbols, exactOn ? flags.promote : 0, promoters);
		}
		// The first tick posts at once, so the status line never shows "no summary" for a trader that is trading.
		if (tick === 1 || tick % CONFIG.summaryEveryTicks === 0) {
			printSummary(ns, symbols, exactOn, session, promoters, { now, ticksLeft, policy, claim });
		}
	}
}

/** Appends this tick's relative price change for each stock. Unchanged prices are skipped, they say nothing. */
export function recordTick(ns, symbols, history, lastPrice) {
	const keep = CONFIG.estimated.longWindow;
	for (const sym of symbols) {
		const price = midPrice(ns, sym);
		if (price !== lastPrice[sym]) {
			history[sym].push(price / lastPrice[sym] - 1);
			if (history[sym].length > keep) history[sym].shift();
		}
		lastPrice[sym] = price;
	}
}

/**
 * Midpoint of ask and bid, i.e. the price getPrice reports, without its 2GB cost.
 * (The ask/bid spread is a fixed fraction of the price, so the midpoint moves exactly with it.)
 */
function midPrice(ns, sym) {
	return (ns.stock.getAskPrice(sym) + ns.stock.getBidPrice(sym)) / 2;
}

/** Share of the last `span` moves that went up. (Not "window": the RAM check charges that word 25GB.) */
export function upShare(moves, span) {
	const recent = moves.slice(-span);
	return recent.filter((move) => move > 0).length / recent.length;
}

/** Average size of a move (a fraction of the price). */
function averageMove(moves) {
	return moves.reduce((sum, move) => sum + Math.abs(move), 0) / moves.length;
}

/**
 * What we think a stock will do: forecast (chance of going up next tick), how sure we are of it,
 * and expected gain per tick as a fraction of price. Exact with 4S; estimated otherwise.
 *
 * Volatility is the game's getVolatility scale: the largest a tick's move can be. A tick's size is uniform up to that, so
 * the average move is half of it; the estimate doubles what it sees so both modes put the same number on a stock.
 */
export function outlook(ns, sym, exactOn, moves) {
	const view = { sym, ready: true, buyReady: true, forecast: 0.5, nearForecast: 0.5 };
	if (exactOn) {
		view.forecast = ns.stock.getForecast(sym);
		view.nearForecast = view.forecast;
		view.volatility = ns.stock.getVolatility(sym);
	} else {
		const settings = CONFIG.estimated;
		view.ready = moves.length >= settings.minHistory;
		view.buyReady = moves.length >= settings.buyHistory;
		if (view.ready) {
			view.forecast = upShare(moves, settings.longWindow);
			view.nearForecast = upShare(moves, settings.shortWindow);
		}
		view.volatility = moves.length > 0 ? 2 * averageMove(moves) : 0;
	}
	view.exact = exactOn;
	// Expected move per tick: (2 * forecast - 1) * average move = (forecast - 0.5) * volatility, signed by direction.
	view.expected = (view.forecast - 0.5) * view.volatility;
	return view;
}

function thresholds(view) {
	return view.exact ? CONFIG.exact : CONFIG.estimated;
}

/** Sells a long once the outlook turns down. */
export function sellIfTurned(ns, view, stats) {
	if (!view.ready) return; // still warming up after a restart: hold what we have
	const [longShares] = ns.stock.getPosition(view.sym);
	const limits = thresholds(view);
	const flip = view.exact ? limits.sellForecast : limits.flipForecast;

	if (longShares > 0 && (view.forecast < limits.sellForecast || view.nearForecast < flip)) {
		sellAll(ns, view.sym, `forecast ${ns.format.percent(view.forecast)}`, stats);
	}
}

/** Sells every long share of a stock. Returns the cash it brought in. */
export function sellAll(ns, sym, reason, stats) {
	const [longShares, longAvg] = ns.stock.getPosition(sym);
	let proceeds = 0;
	if (longShares > 0) {
		const price = ns.stock.sellStock(sym, longShares);
		if (price > 0) proceeds += report(ns, sym, "long", longShares, longAvg, price - longAvg, price, reason, stats);
	}
	return proceeds;
}

/** Sells `shares` of a long (for a swap into a better stock). Returns the cash it brought in. */
function sellPart(ns, sym, shares, reason, stats) {
	const [longShares, longAvg] = ns.stock.getPosition(sym);
	const count = Math.min(shares, longShares);
	if (count <= 0) return 0;
	const price = ns.stock.sellStock(sym, count);
	return price > 0 ? report(ns, sym, "long", count, longAvg, price - longAvg, price, reason, stats) : 0;
}

function report(ns, sym, side, shares, average, gainPerShare, valuePerShare, reason, stats) {
	const commission = ns.stock.getConstants().StockMarketCommission;
	const profit = shares * gainPerShare - 2 * commission; // buy + sell commission
	if (stats) {
		stats.realized += profit;
		stats.trades++;
		addTradeCost(stats, shares, ns.stock.getAskPrice(sym), valuePerShare, 0); // spread of the sale; commission below
		stats.commissionPaid = (stats.commissionPaid ?? 0) + commission;
	}
	ns.print(`[stocks] sold ${side} ${sym} x${ns.format.number(shares)} (${reason}): profit ${formatMoney(ns, profit)}`);
	return shares * valuePerShare - commission;
}

/**
 * Puts the budget into the stocks with the best expected gain per tick, best first.
 *
 * `options` (all off when left out, so callers that only want the plain rule get it):
 *   costAware - skip a buy whose expected drift over `horizon` ticks does not cover the spread and both commissions
 *   horizon   - ticks the forecast can be counted on (holdHorizon)
 *   rotate    - with exact forecasts and no cash left, sell the weakest holding to fund a clearly better stock
 *   claim     - cash another buyer is about to need; the reserve is at least this much
 */
export function buyBest(ns, outlooks, policy, minTrade, stats, options = {}) {
	const spend = { ...policy, reserve: Math.max(policy.reserve, options.claim ?? 0) };
	for (let swaps = 0; ; swaps++) {
		buyPass(ns, outlooks, spend, minTrade, stats, options);
		if (!options.rotate || !options.costAware || swaps >= CONFIG.maxSwapsPerTick) return;
		if (!fundBetterStock(ns, outlooks, spend, minTrade, stats, options)) return;
	}
}

/** The stocks worth buying now, best expected gain first. */
function buyCandidates(outlooks) {
	return outlooks
		.filter((view) => view.ready && view.buyReady)
		.filter((view) => {
			const limits = thresholds(view);
			// Without 4S, skip a stock whose last few ticks already point the other way (it may have flipped).
			return view.forecast >= limits.buyForecast && view.nearForecast >= 0.5;
		})
		.sort((first, second) => second.expected - first.expected);
}

/** How many shares of a stock the share limit, the budget and the per-stock cap allow. */
function sharesFor(ns, sym, budget, perStockCap) {
	const commission = ns.stock.getConstants().StockMarketCommission;
	const [longShares] = ns.stock.getPosition(sym);
	const room = ns.stock.getMaxShares(sym) - longShares;
	const price = ns.stock.getAskPrice(sym);
	const held = longShares * price;
	return Math.floor(Math.min(room, (budget - commission) / price, (perStockCap - held) / price));
}

function buyPass(ns, outlooks, policy, minTrade, stats, options) {
	let budget = getBudget(ns, policy);
	if (budget < minTrade) return;
	const commission = ns.stock.getConstants().StockMarketCommission;
	const perStockCap = CONFIG.maxPerStock * (getCash(ns) + portfolioValue(ns, outlooks.map((view) => view.sym)));

	for (const view of buyCandidates(outlooks)) {
		const [longShares, , shortShares] = ns.stock.getPosition(view.sym);
		if (shortShares > 0) continue; // a short left from stock-trader-v3.js --short: sell it by hand or with v3
		const price = ns.stock.getAskPrice(view.sym);
		const shares = sharesFor(ns, view.sym, budget, perStockCap);
		if (shares <= 0 || shares * price < minTrade) continue;
		if (options.costAware) {
			const edge = netEdge({
				expected: view.expected, horizon: options.horizon ?? 0, value: shares * price, commission,
				spread: spreadFraction(price, ns.stock.getBidPrice(view.sym)),
			});
			if (edge <= 0) continue; // the drift over the time the forecast lasts would not pay for getting in and out
		}

		const paid = ns.stock.buyStock(view.sym, shares);
		if (paid <= 0) continue;
		addTradeCost(stats, shares, paid, ns.stock.getBidPrice(view.sym), commission);
		budget -= shares * paid + commission;
		ns.print(
			`[stocks] bought long ${view.sym} x${ns.format.number(shares)} for ` +
			`${formatMoney(ns, shares * paid)} (forecast ${ns.format.percent(view.forecast)}` +
			`${view.exact ? "" : " est."}, vol ${ns.format.percent(view.volatility, 2)})`
		);
		if (budget < minTrade) break;
	}
}

/**
 * Cash is all invested but a clearly better stock is waiting: sell part of the weakest holding to fund it, when the
 * extra drift over the horizon pays for the new stock's spread and commissions. Exact forecasts only (estimates are too
 * noisy to trade on small differences). Returns true if it sold something, so the caller buys again.
 */
function fundBetterStock(ns, outlooks, policy, minTrade, stats, options) {
	if (getBudget(ns, policy) >= minTrade) return false; // cash left: buyPass had nothing it wanted
	const commission = ns.stock.getConstants().StockMarketCommission;
	const perStockCap = CONFIG.maxPerStock * (getCash(ns) + portfolioValue(ns, outlooks.map((view) => view.sym)));
	const holdings = outlooks
		.filter((view) => view.exact && view.ready && ns.stock.getPosition(view.sym)[0] > 0)
		.sort((first, second) => first.expected - second.expected); // weakest first
	for (const target of buyCandidates(outlooks).filter((view) => view.exact)) {
		const price = ns.stock.getAskPrice(target.sym);
		const [targetShares] = ns.stock.getPosition(target.sym);
		const roomValue = Math.min(
			(ns.stock.getMaxShares(target.sym) - targetShares) * price,
			perStockCap - targetShares * price,
		);
		if (roomValue < minTrade) continue; // this one is full; the next may have room
		const weakest = holdings.find((view) => view.sym !== target.sym && view.expected < target.expected);
		if (!weakest) return false;
		const bid = ns.stock.getBidPrice(weakest.sym);
		const [weakShares] = ns.stock.getPosition(weakest.sym);
		const value = Math.min(roomValue, weakShares * bid);
		if (value < minTrade) return false;
		const edge = swapEdge({
			heldExpected: weakest.expected, candidateExpected: target.expected, horizon: options.horizon ?? 0, value,
			candidateSpread: spreadFraction(price, ns.stock.getBidPrice(target.sym)), commission,
		});
		if (edge <= 0) return false;
		// A remainder too small to be worth its own commission goes with the rest.
		const wanted = Math.ceil(value / bid);
		const shares = (weakShares - wanted) * bid < minTrade ? weakShares : wanted;
		const proceeds = sellPart(
			ns, weakest.sym, shares,
			`swap into ${target.sym} (${ns.format.percent(weakest.forecast)} -> ${ns.format.percent(target.forecast)})`, stats,
		);
		return proceeds > 0;
	}
	return false;
}

/** What every open position would sell for right now. */
function portfolioValue(ns, symbols) {
	let value = 0;
	for (const sym of symbols) {
		const [longShares, , shortShares, shortAvg] = ns.stock.getPosition(sym);
		value += longShares * ns.stock.getBidPrice(sym) + shortShares * (2 * shortAvg - ns.stock.getAskPrice(sym));
	}
	return value;
}

/** Each held long's shares, bid and expected drift, for the next tick's drift accounting. */
export function snapshotHeld(ns, symbols, outlooks) {
	const expected = Object.fromEntries(outlooks.map((view) => [view.sym, view.expected]));
	const snapshot = {};
	for (const sym of symbols) {
		const [shares] = ns.stock.getPosition(sym);
		if (shares > 0) snapshot[sym] = { shares, bid: ns.stock.getBidPrice(sym), expected: expected[sym] ?? 0 };
	}
	return snapshot;
}

/** Money made by stocks since the install, with what the holdings are worth (the game books a buy as money lost). */
function earnedNow(ns, symbols) {
	return ns.getMoneySources().sinceInstall.stock + portfolioValue(ns, symbols);
}

/**
 * Cash another buyer (home RAM or cores, programs, a faction donation) is about to need: reading its note on the gate
 * port. The trader keeps that much instead of spending it on shares, so income can reach the purchase; a buyer that
 * needs more than one market cycle of income is not waited for. 0 when nobody is waiting.
 */
function buyerClaim(ns, cycleMs) {
	return pendingClaim(readGates(ns), {
		now: Date.now(), cash: getCash(ns), perSecond: readIncomeRate(ns).perSecond,
		windowMs: CONFIG.claimWindowCycles * cycleMs, maxAgeMs: CONFIG.claimMaxAgeCycles * cycleMs,
	});
}

/**
 * Tells the batcher's workers which company servers to steer: grows on servers of stocks we hold
 * long push the price up. Every other hack/grow leaves the market alone, so hacking a company
 * we're long on can't hurt us. (The hack list stays for the worker format; it's empty without shorts.)
 */
export function postInfluence(ns, symbols) {
	const influence = { grow: [], hack: [] };
	for (const sym of symbols) {
		const host = SYMBOL_SERVERS[sym];
		if (!host) continue;
		const [longShares] = ns.stock.getPosition(sym);
		if (longShares > 0) influence["grow"].push(host);
	}
	ns.clearPort(STOCK_INFLUENCE_PORT);
	ns.writePort(STOCK_INFLUENCE_PORT, JSON.stringify(influence));
}

/**
 * Keeps promoteStock workers on the biggest long positions (by value), threads split evenly.
 * Workers on stocks that dropped out of the top (or whose server vanished) are stopped. threads 0 stops them all.
 * promoteStock only works on a darknet server, so workers are placed by promotionHosts().
 */
export function retargetPromoters(ns, symbols, threads, promoters) {
	const settings = CONFIG.promote;
	const wanted = threads <= 0 ? [] : symbols
		.map((sym) => ({ sym, value: ns.stock.getPosition(sym)[0] * ns.stock.getBidPrice(sym) }))
		.filter((holding) => holding.value > 0)
		.sort((first, second) => second.value - first.value)
		.slice(0, settings.targets)
		.map((holding) => holding.sym);
	const perTarget = Math.floor(threads / Math.max(1, wanted.length));

	for (const sym of Object.keys(promoters)) {
		const entry = promoters[sym];
		entry.workers = entry.workers.filter((worker) => ns.isRunning(worker.pid));
		if (!wanted.includes(sym) || entry.workers.length === 0) {
			entry.workers.forEach((worker) => ns.kill(worker.pid));
			delete promoters[sym];
		}
	}
	const missing = wanted.filter((sym) => !promoters[sym]);
	if (missing.length === 0 || perTarget <= 0) return;

	const hosts = promotionHosts(ns);
	if (hosts.length === 0) {
		ns.print(`[stocks] --promote skipped: no darknet server to run it on. It needs darkweb opened or a ` +
			`stasis-linked server, with passwords in ${HOME_PASSWORD_FILE} (run darknet/dnet-manager.js).`);
		return;
	}
	for (const sym of missing) {
		const workers = [];
		let left = perTarget;
		for (const host of hosts) {
			if (left <= 0) break;
			const worker = launchPromoter(ns, host, sym, left);
			if (!worker) continue;
			workers.push(worker);
			left -= worker.threads;
		}
		if (workers.length === 0) {
			ns.print(`[stocks] no room for a ${settings.script} thread on ${hosts.join(", ")}; skipping ${sym}.`);
			continue;
		}
		const total = workers.reduce((sum, worker) => sum + worker.threads, 0);
		promoters[sym] = { workers, threads: total };
		ns.print(`[stocks] promoting ${sym} with ${total} threads on ${workers.map((w) => w.host).join(", ")} ` +
			`(volatility now ${ns.format.percent(ns.stock.getVolatility(sym), 2)})`);
	}
}

/**
 * Darknet servers home can exec on: darkweb (a direct neighbour) and stasis-linked servers. Each needs a
 * session for this script (connectToSession with the password dnet-manager saved), then the worker is
 * copied there. Biggest first.
 */
function promotionHosts(ns) {
	let passwords = {};
	try { passwords = JSON.parse(ns.read(HOME_PASSWORD_FILE) || "{}"); } catch { /* no darknet run yet */ }
	const candidates = [...new Set(["darkweb", ...ns.dnet.getStasisLinkedServers()])];
	const hosts = [];
	for (const host of candidates) {
		const password = passwords[host];
		if (password === undefined) continue;
		try {
			if (!ns.dnet.connectToSession(host, password).success) continue;
			if (!ns.scp(CONFIG.promote.script, host, "home")) continue;
		} catch { continue; } // went offline or moved out of reach
		hosts.push(host);
	}
	return hosts.sort((a, b) => ns.getServerMaxRam(b) - ns.getServerMaxRam(a));
}

/**
 * Starts up to `want` promoter threads for `sym` on `host`. Phishing workers there are stopped one at a time
 * until the threads fit (the crawler relaunches phishing in what's left). Returns { pid, host, threads } or null.
 */
function launchPromoter(ns, host, sym, want) {
	const script = CONFIG.promote.script;
	try {
		const perThread = ns.getScriptRam(script, "home");
		const free = () => ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
		const phishers = ns.ps(host).filter((proc) => proc.filename === PHISH_SCRIPT);
		while (free() < want * perThread && phishers.length > 0) ns.kill(phishers.pop().pid);
		const fit = Math.min(want, Math.floor(free() / perThread));
		if (fit <= 0) return null;
		const pid = ns.exec(script, host, fit, sym);
		return pid === 0 ? null : { pid, host, threads: fit };
	} catch {
		return null; // went offline or moved out of reach
	}
}

/** What the trader has learned about buying market access in this process. */
export function newAccessState(startMs) {
	return { startMs, lastResult: 0, factor: 1, fourSOff: false };
}

/**
 * Reads what the access helper reported (data/stock-access.json) and learns from it, once per report:
 *   "4s-poor"     the game refused although cash covered our price guess, so the real price is higher (BitNode 7 and 9
 *                 charge 2x and 4x): double the guess, instead of starting the helper every tick;
 *   "4s-disabled" the BitNode options turned 4S off: stop trying for 4S.
 * Reports from before this run started are ignored.
 */
export function absorbAccessResult(ns, access) {
	let result = null;
	try { result = JSON.parse(ns.read(ACCESS_RESULT_FILE)); } catch { return; }
	if (!result || !(result.time > access.lastResult) || result.time < access.startMs) return;
	access.lastResult = result.time;
	if (result.what === "4s-poor") {
		access.factor = learnFactor(access.factor);
		ns.print(`[stocks] the game refused the 4S purchase at ${formatMoney(ns, result.cash)}; its price here is higher than listed. ` +
			`Trying again once cash above the reserve covers ${access.factor}x the listed price.`);
	} else if (result.what === "4s-disabled" && !access.fourSOff) {
		access.fourSOff = true;
		notify(ns, "[stocks]", "4S Market Data is turned off in this BitNode's options; estimating from price history.", "info");
	}
}

/**
 * Runs the one-shot helper once cash above the reserve covers `cost`: it buys the TIX API if
 * missing, and with `with4S` the 4S Market Data TIX API too.
 */
function maybeBuyAccess(ns, cost, policy, with4S) {
	if (getCash(ns) - policy.reserve < cost) return;
	const script = CONFIG.accessScript;
	const args = with4S ? [policy.reserve, "--4s"] : [policy.reserve];
	if (ns.isRunning(script, "home", ...args)) return; // already buying
	if (ns.exec(script, "home", 1, ...args) === 0) {
		ns.print(`[stocks] can afford ${with4S ? "4S" : "the TIX API"} but there's no free home RAM for ${script} yet.`);
	}
}

/** While there is no TIX API yet there are no positions; say what the trader is waiting for so status doesn't guess. */
function postWaiting(ns, what, cost, policy) {
	ns.clearPort(STOCK_SUMMARY_PORT);
	ns.writePort(STOCK_SUMMARY_PORT, JSON.stringify({
		time: Date.now(), mode: "waiting", waitingFor: what, cost, cash: getCash(ns), reserve: policy.reserve,
		positions: 0, value: 0,
	}));
}

function printSummary(ns, symbols, exactOn, session, promoters, extra) {
	const { stats, meter } = session;
	let invested = 0;
	let value = 0;
	let positions = 0;
	for (const sym of symbols) {
		const [longShares, longAvg, shortShares, shortAvg] = ns.stock.getPosition(sym);
		if (longShares > 0) {
			invested += longShares * longAvg;
			value += longShares * ns.stock.getBidPrice(sym);
			positions++;
		}
		if (shortShares > 0) {
			invested += shortShares * shortAvg;
			value += shortShares * (2 * shortAvg - ns.stock.getAskPrice(sym));
			positions++;
		}
	}
	// The game books a buy as money lost until it's sold, so add back what the holdings are worth.
	const earned = ns.getMoneySources().sinceInstall.stock + value;
	const figures = meter.snapshot(extra.now, stats);
	ns.clearPort(STOCK_SUMMARY_PORT);
	ns.writePort(STOCK_SUMMARY_PORT, JSON.stringify({
		time: Date.now(), mode: exactOn ? "4S" : "estimating", positions, value, unrealized: value - invested,
		realized: stats.realized, trades: stats.trades, earned,
		// How well it is doing, since the window (mode) started: see docs/stocks.md "Measuring it".
		measure: figures,
		nextBoundary: extra.ticksLeft, // ticks until the market's next forecast flips (4S only), null while unknown
		claim: extra.claim, // cash being kept for another buyer (0 when none)
		reserve: extra.policy.reserve,
	}));
	ns.print(
		`[stocks] ${exactOn ? "4S" : "estimating"} | ${positions} positions, ` +
		`${formatMoney(ns, value)} (unrealized ${formatMoney(ns, value - invested)}) | ` +
		`realized this run ${formatMoney(ns, stats.realized)} over ${stats.trades} sells | ` +
		`stock profit since install ${formatMoney(ns, earned)} | cash ${formatMoney(ns, getCash(ns))}`
	);
	ns.print(
		`[stocks] measure (${ns.format.time(figures.sinceMs)}): ${formatMoney(ns, figures.perHour)}/h = ` +
		`${ns.format.percent(figures.returnPerHour, 1)}/h of working capital | invested ${ns.format.percent(figures.invested, 0)}, ` +
		`idle ${ns.format.percent(figures.idle, 0)}, held back ${ns.format.percent(figures.heldBack, 0)} | ` +
		`max drawdown ${formatMoney(ns, figures.maxDrawdown)} | costs ${formatMoney(ns, figures.costs)} | ` +
		`drift ${formatMoney(ns, figures.priceGain)}` +
		(figures.capture === null ? "" : ` vs ${formatMoney(ns, figures.expectedGain)} expected (${ns.format.percent(figures.capture, 0)})`) +
		(extra.ticksLeft === null ? "" : ` | next flip in ${extra.ticksLeft} ticks`)
	);
	// So you can see whether promoting works: volatility of each promoted stock right now.
	const promoted = Object.entries(promoters).map(
		([sym, entry]) => `${sym} vol ${ns.format.percent(ns.stock.getVolatility(sym), 2)} (${entry.threads}t)`
	);
	if (exactOn && promoted.length > 0) ns.print(`[stocks] promoting: ${promoted.join(", ")}`);
}
