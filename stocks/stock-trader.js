// Design: docs/stocks.md
// @ts-check
import { loadConfig } from "/utils/config.js";
import { notify } from "/utils/notify.js";
import { createPolicyTracker, getBudget, getCash, formatMoney } from "/utils/spending.js";
import { STOCK_INFLUENCE_PORT, SYMBOL_SERVERS } from "/stocks/stock-servers.js";
import { HOME_PASSWORD_FILE, PHISH_SCRIPT } from "/darknet/config.js"; // constants only, no RAM
// tools/status.js peeks a one-line summary here (ports: 20 darknet ... 25 city plan).
const STOCK_SUMMARY_PORT = 26;

const CONFIG = {
	// Spending stages (reserve, maxFraction, ... by income) are `stockTrading` in the config
	// (config.js, data/config.json).
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

/**
 * Stock trader. Uses the exact forecast and volatility from the 4S Market Data TIX API when you
 * own it, otherwise estimates both from price history. Checked every tick, so buying 4S
 * mid-run switches it to exact mode (like Formulas.exe in the other managers).
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
	const getPolicy = createPolicyTracker(loadConfig(ns).stockTrading);
	if (!ns.stock.hasTixApiAccess()) {
		if (flags["no-buy-tix"]) {
			ns.tprint("[stocks] no TIX API access; buy it at the WSE first.");
			return;
		}
		ns.tprint(`[stocks] no TIX API access; buying it once cash above the reserve covers ${formatMoney(ns, constants.TixApiCost)}.`);
		while (!ns.stock.hasTixApiAccess()) {
			maybeBuyAccess(ns, constants.TixApiCost, getPolicy(ns), false);
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
	const stats = { realized: 0, trades: 0 };
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
		recordTick(ns, symbols, history, lastPrice);

		if (flags["buy-4s"] && !ns.stock.has4SDataTixApi()) maybeBuyAccess(ns, constants.MarketDataTixApi4SCost, getPolicy(ns), true);
		const exactOn = ns.stock.has4SDataTixApi();
		if (exactOn !== exactWasOn) {
			const mode = `4S TIX API ${exactOn ? "found: exact forecasts on" : "not owned: estimating from price history"}.`;
			if (exactWasOn === null) ns.print(`[stocks] ${mode}`); // first tick: routine
			else notify(ns, "[stocks]", mode, "info"); // the mode changed mid-run: toast only
			exactWasOn = exactOn;
		}

		const outlooks = symbols.map((sym) => outlook(ns, sym, exactOn, history[sym]));
		for (const view of outlooks) sellIfTurned(ns, view, stats);
		buyBest(ns, outlooks, getPolicy(ns), minTrade, stats);
		if (!flags["no-influence"]) postInfluence(ns, symbols);

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
function upShare(moves, span) {
	const recent = moves.slice(-span);
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

/** Sells a long once the outlook turns down. */
function sellIfTurned(ns, view, stats) {
	if (!view.ready) return; // still warming up after a restart: hold what we have
	const [longShares] = ns.stock.getPosition(view.sym);
	const limits = thresholds(view);
	const flip = view.exact ? limits.sellForecast : limits.flipForecast;

	if (longShares > 0 && (view.forecast < limits.sellForecast || view.nearForecast < flip)) {
		sellAll(ns, view.sym, `forecast ${ns.format.percent(view.forecast)}`, stats);
	}
}

/** Sells every long share of a stock. Returns the cash it brought in. */
function sellAll(ns, sym, reason, stats) {
	const [longShares, longAvg] = ns.stock.getPosition(sym);
	let proceeds = 0;
	if (longShares > 0) {
		const price = ns.stock.sellStock(sym, longShares);
		if (price > 0) proceeds += report(ns, sym, "long", longShares, longAvg, price - longAvg, price, reason, stats);
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
function buyBest(ns, outlooks, policy, minTrade, stats) {
	let budget = getBudget(ns, policy);
	if (budget < minTrade) return;
	const commission = ns.stock.getConstants().StockMarketCommission;
	const perStockCap = CONFIG.maxPerStock * (getCash(ns) + portfolioValue(ns, outlooks.map((view) => view.sym)));

	const candidates = outlooks
		.filter((view) => view.ready)
		.filter((view) => {
			const limits = thresholds(view);
			// Without 4S, skip a stock whose last few ticks already point the other way (it may have flipped).
			return view.forecast >= limits.buyForecast && view.nearForecast >= 0.5;
		})
		.sort((first, second) => second.expected - first.expected);

	for (const view of candidates) {
		const [longShares, , shortShares] = ns.stock.getPosition(view.sym);
		if (shortShares > 0) continue; // a short left from stock-trader-v3.js --short: sell it by hand or with v3
		const room = ns.stock.getMaxShares(view.sym) - longShares;
		const price = ns.stock.getAskPrice(view.sym);
		const held = longShares * price;
		const shares = Math.floor(Math.min(room, (budget - commission) / price, (perStockCap - held) / price));
		if (shares <= 0 || shares * price < minTrade) continue;

		const paid = ns.stock.buyStock(view.sym, shares);
		if (paid <= 0) continue;
		budget -= shares * paid + commission;
		ns.print(
			`[stocks] bought long ${view.sym} x${ns.format.number(shares)} for ` +
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
 * Tells the batcher's workers which company servers to steer: grows on servers of stocks we hold
 * long push the price up. Every other hack/grow leaves the market alone, so hacking a company
 * we're long on can't hurt us. (The hack list stays for the worker format; it's empty without shorts.)
 */
function postInfluence(ns, symbols) {
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
	ns.clearPort(STOCK_SUMMARY_PORT);
	ns.writePort(STOCK_SUMMARY_PORT, JSON.stringify({
		time: Date.now(), mode: exactOn ? "4S" : "estimating", positions, value, unrealized: value - invested,
		realized: stats.realized, trades: stats.trades, earned,
	}));
	ns.print(
		`[stocks] ${exactOn ? "4S" : "estimating"} | ${positions} positions, ` +
		`${formatMoney(ns, value)} (unrealized ${formatMoney(ns, value - invested)}) | ` +
		`realized this run ${formatMoney(ns, stats.realized)} over ${stats.trades} sells | ` +
		`stock profit since install ${formatMoney(ns, earned)} | cash ${formatMoney(ns, getCash(ns))}`
	);
	// So you can see whether promoting works: volatility of each promoted stock right now.
	const promoted = Object.entries(promoters).map(
		([sym, entry]) => `${sym} vol ${ns.format.percent(ns.stock.getVolatility(sym), 2)} (${entry.threads}t)`
	);
	if (exactOn && promoted.length > 0) ns.print(`[stocks] promoting: ${promoted.join(", ")}`);
}
