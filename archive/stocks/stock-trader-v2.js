import { createPolicyTracker, getBudget, getCash, formatMoney } from "/utils/spending.js";

const CONFIG = {
	// Cash the trader leaves alone, by income stage (same idea as hacknet/pserv). Money in
	// stocks isn't spent, but it isn't available to the other managers either.
	//   reserve     - cash never put into stocks
	//   maxFraction - largest share of cash invested in one tick
	stages: [
		{ name: "early", minIncome: 0, reserve: 5e6, maxFraction: 0.9 },
		{ name: "growing", minIncome: 1e5, reserve: 50e6, maxFraction: 0.9 },
		{ name: "established", minIncome: 1e7, reserve: 500e6, maxFraction: 0.9 },
		{ name: "late", minIncome: 1e8, reserve: 2e9, maxFraction: 0.9 },
	],
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
		minHistory: 15, // ticks of history before trading on a stock
		buyForecast: 0.6,
		sellForecast: 0.45, // on the long window
		flipForecast: 0.35, // on the short window: sell even if the long window still looks fine
	},
	summaryEveryTicks: 10,
	// --promote: how many of the biggest longs get a promoteStock worker (threads split between them),
	// and how often (ticks) to re-pick them.
	promote: { script: "workers/promote-stock.js", host: "home", targets: 2, retargetEveryTicks: 10 },
};

/**
 * Stock trader. Uses the exact forecast and volatility from the 4S Market Data TIX API when you
 * own it, otherwise estimates both from price history. Checked every tick, so buying 4S
 * mid-run switches it to exact mode (like Formulas.exe in the other managers).
 *
 * Flags:
 *   --short       also short falling stocks (needs BitNode 8 or Source-File 8.2)
 *   --buy-4s      buy the 4S Market Data TIX API as soon as cash above the reserve covers it
 *   --liquidate   sell every position and exit
 *   --promote N   run N threads of ns.dnet.promoteStock on home against the biggest longs. That raises
 *                 their volatility (not their forecast), so with 4S each tick's expected gain grows.
 *                 Only useful with 4S: without it the estimates get noisier too.
 */
export async function main(ns) {
	ns.disableLog("ALL");
	const flags = ns.flags([
		["short", false],
		["buy-4s", false],
		["liquidate", false],
		["promote", 0],
	]);

	if (!ns.stock.hasTixApiAccess()) {
		ns.tprint("[stocks] no TIX API access; buy it at the WSE first.");
		return;
	}

	const symbols = ns.stock.getSymbols();
	if (flags.liquidate) {
		const proceeds = symbols.reduce((sum, sym) => sum + sellAll(ns, sym, "liquidate"), 0);
		ns.tprint(`[stocks] liquidated everything for ${formatMoney(ns, proceeds)}.`);
		return;
	}

	const constants = ns.stock.getConstants();
	const minTrade = constants.StockMarketCommission * CONFIG.minTradeCommissions;
	const getPolicy = createPolicyTracker(CONFIG.stages);
	const history = Object.fromEntries(symbols.map((sym) => [sym, []])); // relative price change per tick
	const lastPrice = Object.fromEntries(symbols.map((sym) => [sym, ns.stock.getPrice(sym)]));
	const stats = { realized: 0, trades: 0 };
	let exactWasOn = null; // null so the first tick always reports the mode
	let tick = 0;
	const promoters = {}; // sym -> { pid, threads }
	ns.atExit(() => Object.values(promoters).forEach((worker) => ns.kill(worker.pid)));

	while (true) {
		await ns.stock.nextUpdate();
		tick++;
		recordTick(ns, symbols, history, lastPrice);

		if (flags["buy-4s"] && !ns.stock.has4SDataTixApi()) maybeBuy4S(ns, constants, getPolicy(ns));
		const exactOn = ns.stock.has4SDataTixApi();
		if (exactOn !== exactWasOn) {
			exactWasOn = exactOn;
			ns.tprint(`[stocks] 4S TIX API ${exactOn ? "found: exact forecasts on" : "not owned: estimating from price history"}.`);
		}

		const outlooks = symbols.map((sym) => outlook(ns, sym, exactOn, history[sym]));
		for (const view of outlooks) sellIfTurned(ns, view, flags.short, stats);
		buyBest(ns, outlooks, getPolicy(ns), minTrade, flags.short, stats);

		if (flags.promote > 0 && tick % CONFIG.promote.retargetEveryTicks === 0) {
			retargetPromoters(ns, symbols, exactOn ? flags.promote : 0, promoters);
		}
		if (tick % CONFIG.summaryEveryTicks === 0) printSummary(ns, symbols, exactOn, stats, promoters);
	}
}

/** Appends this tick's relative price change for each stock. Unchanged prices are skipped, they say nothing. */
function recordTick(ns, symbols, history, lastPrice) {
	const keep = CONFIG.estimated.longWindow;
	for (const sym of symbols) {
		const price = ns.stock.getPrice(sym);
		if (price !== lastPrice[sym]) {
			history[sym].push(price / lastPrice[sym] - 1);
			if (history[sym].length > keep) history[sym].shift();
		}
		lastPrice[sym] = price;
	}
}

/** Share of the last `window` moves that went up. */
function upShare(moves, window) {
	const recent = moves.slice(-window);
	return recent.filter((move) => move > 0).length / recent.length;
}

/** Average size of a move. Only used to rank stocks against each other, so its scale doesn't matter. */
function averageMove(moves) {
	return moves.reduce((sum, move) => sum + Math.abs(move), 0) / moves.length;
}

/**
 * What we think a stock will do: forecast (chance of going up next tick), how sure we are of it,
 * and expected gain per tick as a fraction of price. Exact with 4S; estimated otherwise.
 */
function outlook(ns, sym, exactOn, moves) {
	const view = { sym, ready: true, forecast: 0.5, nearForecast: 0.5 };
	if (exactOn) {
		view.forecast = ns.stock.getForecast(sym);
		view.nearForecast = view.forecast;
		view.volatility = ns.stock.getVolatility(sym);
	} else {
		const settings = CONFIG.estimated;
		view.ready = moves.length >= settings.minHistory;
		if (view.ready) {
			view.forecast = upShare(moves, settings.longWindow);
			view.nearForecast = upShare(moves, settings.shortWindow);
		}
		view.volatility = moves.length > 0 ? averageMove(moves) : 0;
	}
	view.exact = exactOn;
	// Expected move per tick: |forecast - 0.5| * volatility, signed by direction.
	view.expected = (view.forecast - 0.5) * view.volatility;
	return view;
}

function thresholds(view) {
	return view.exact ? CONFIG.exact : CONFIG.estimated;
}

/** Sells a long once the outlook turns down, a short once it turns up. */
function sellIfTurned(ns, view, shortsOn, stats) {
	if (!view.ready) return; // still warming up after a restart: hold what we have
	const [longShares, , shortShares] = ns.stock.getPosition(view.sym);
	const limits = thresholds(view);
	const flip = view.exact ? limits.sellForecast : limits.flipForecast;

	if (longShares > 0 && (view.forecast < limits.sellForecast || view.nearForecast < flip)) {
		sellAll(ns, view.sym, `forecast ${ns.format.percent(view.forecast)}`, stats);
	}
	if (shortsOn && shortShares > 0 && (view.forecast > 1 - limits.sellForecast || view.nearForecast > 1 - flip)) {
		sellAll(ns, view.sym, `forecast ${ns.format.percent(view.forecast)}`, stats);
	}
}

/** Sells every long and short share of a stock. Returns the cash it brought in. */
function sellAll(ns, sym, reason, stats) {
	const [longShares, longAvg, shortShares, shortAvg] = ns.stock.getPosition(sym);
	let proceeds = 0;
	if (longShares > 0) {
		const price = ns.stock.sellStock(sym, longShares);
		if (price > 0) proceeds += report(ns, sym, "long", longShares, longAvg, price - longAvg, price, reason, stats);
	}
	if (shortShares > 0) {
		const price = ns.stock.sellShort(sym, shortShares);
		if (price > 0) proceeds += report(ns, sym, "short", shortShares, shortAvg, shortAvg - price, shortAvg + (shortAvg - price), reason, stats);
	}
	return proceeds;
}

function report(ns, sym, side, shares, average, gainPerShare, valuePerShare, reason, stats) {
	const commission = ns.stock.getConstants().StockMarketCommission;
	const profit = shares * gainPerShare - 2 * commission; // buy + sell commission
	if (stats) {
		stats.realized += profit;
		stats.trades++;
	}
	ns.print(`[stocks] sold ${side} ${sym} x${ns.format.number(shares)} (${reason}): profit ${formatMoney(ns, profit)}`);
	return shares * valuePerShare - commission;
}

/** Puts the budget into the stocks with the best expected gain per tick, best first. */
function buyBest(ns, outlooks, policy, minTrade, shortsOn, stats) {
	let budget = getBudget(ns, policy);
	if (budget < minTrade) return;
	const commission = ns.stock.getConstants().StockMarketCommission;
	const perStockCap = CONFIG.maxPerStock * (getCash(ns) + portfolioValue(ns, outlooks.map((view) => view.sym)));

	const candidates = outlooks
		.filter((view) => view.ready)
		.filter((view) => {
			const limits = thresholds(view);
			// Without 4S, skip a stock whose last few ticks already point the other way (it may have flipped).
			if (view.forecast >= limits.buyForecast) return view.nearForecast >= 0.5;
			return shortsOn && view.forecast <= 1 - limits.buyForecast && view.nearForecast <= 0.5;
		})
		.sort((first, second) => Math.abs(second.expected) - Math.abs(first.expected));

	for (const view of candidates) {
		const isLong = view.forecast > 0.5;
		const [longShares, , shortShares] = ns.stock.getPosition(view.sym);
		if ((isLong && shortShares > 0) || (!isLong && longShares > 0)) continue; // wait for the other side to be sold
		const room = ns.stock.getMaxShares(view.sym) - longShares - shortShares;
		const price = isLong ? ns.stock.getAskPrice(view.sym) : ns.stock.getBidPrice(view.sym);
		const held = (longShares + shortShares) * price;
		const shares = Math.floor(Math.min(room, (budget - commission) / price, (perStockCap - held) / price));
		if (shares <= 0 || shares * price < minTrade) continue;

		const paid = isLong ? ns.stock.buyStock(view.sym, shares) : ns.stock.buyShort(view.sym, shares);
		if (paid <= 0) continue;
		budget -= shares * paid + commission;
		ns.print(
			`[stocks] bought ${isLong ? "long" : "short"} ${view.sym} x${ns.format.number(shares)} for ` +
			`${formatMoney(ns, shares * paid)} (forecast ${ns.format.percent(view.forecast)}` +
			`${view.exact ? "" : " est."}, vol ${ns.format.percent(view.volatility, 2)})`
		);
		if (budget < minTrade) break;
	}
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

/**
 * Keeps promoteStock workers on the biggest long positions (by value), threads split evenly.
 * Workers on stocks that dropped out of the top are stopped. threads 0 stops them all.
 */
function retargetPromoters(ns, symbols, threads, promoters) {
	const settings = CONFIG.promote;
	const wanted = threads <= 0 ? [] : symbols
		.map((sym) => ({ sym, value: ns.stock.getPosition(sym)[0] * ns.stock.getBidPrice(sym) }))
		.filter((holding) => holding.value > 0)
		.sort((first, second) => second.value - first.value)
		.slice(0, settings.targets)
		.map((holding) => holding.sym);
	const perTarget = Math.floor(threads / Math.max(1, wanted.length));

	for (const sym of Object.keys(promoters)) {
		if (!wanted.includes(sym) || !ns.isRunning(promoters[sym].pid)) {
			ns.kill(promoters[sym].pid);
			delete promoters[sym];
		}
	}
	for (const sym of wanted) {
		if (promoters[sym] || perTarget <= 0) continue;
		const free = ns.getServerMaxRam(settings.host) - ns.getServerUsedRam(settings.host);
		const fit = Math.min(perTarget, Math.floor(free / ns.getScriptRam(settings.script, settings.host)));
		if (fit <= 0) continue;
		const pid = ns.exec(settings.script, settings.host, fit, sym);
		if (pid === 0) continue;
		promoters[sym] = { pid, threads: fit };
		ns.print(`[stocks] promoting ${sym} with ${fit} threads (volatility now ${ns.format.percent(ns.stock.getVolatility(sym), 2)})`);
	}
}

/** Buys the 4S Market Data TIX API once cash above the reserve covers it. */
function maybeBuy4S(ns, constants, policy) {
	if (getCash(ns) - policy.reserve < constants.MarketDataTixApi4SCost) return;
	if (ns.stock.purchase4SMarketDataTixApi()) {
		ns.tprint(`[stocks] bought the 4S Market Data TIX API for ${formatMoney(ns, constants.MarketDataTixApi4SCost)}.`);
	}
}

function printSummary(ns, symbols, exactOn, stats, promoters) {
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
	ns.print(
		`[stocks] ${exactOn ? "4S" : "estimating"} | ${positions} positions, ` +
		`${formatMoney(ns, value)} (unrealized ${formatMoney(ns, value - invested)}) | ` +
		`realized this run ${formatMoney(ns, stats.realized)} over ${stats.trades} sells | ` +
		`stock profit since install ${formatMoney(ns, earned)} | cash ${formatMoney(ns, getCash(ns))}`
	);
	// So you can see whether promoting works: volatility of each promoted stock right now.
	const promoted = Object.entries(promoters).map(
		([sym, worker]) => `${sym} vol ${ns.format.percent(ns.stock.getVolatility(sym), 2)} (${worker.threads}t)`
	);
	if (exactOn && promoted.length > 0) ns.print(`[stocks] promoting: ${promoted.join(", ")}`);
}
