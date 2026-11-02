/** @param {NS} ns */
export async function main(ns) {
	const target = ns.args[0];
	const landTime = ns.args[1] || 0; // absolute Date.now() timestamp to land at; 0 = no delay

	// The action's duration depends on the target's security at the instant it starts, so measure it
	// here, synchronously right before the call, and wait just long enough to land at landTime.
	const duration = ns.getHackTime(target);
	const additionalMsec = Math.max(0, landTime - Date.now() - duration);
	const earned = await ns.hack(target, { additionalMsec, stock: influencesStock(ns, target) });
	if (earned > 0) addToIncomeTotal(ns, earned);
}

/**
 * Running total of money hacked, kept on port 22 (INCOME_PORT in batcher.js), so the batcher
 * can report real income: these workers exit as soon as they pay out, so getTotalScriptIncome never
 * sees them. Port calls are 0GB and synchronous, so the read-replace can't race another worker.
 */
function addToIncomeTotal(ns, earned) {
	const total = Number(ns.peek(22)) || 0; // "NULL PORT DATA" before the first hack
	ns.clearPort(22);
	ns.writePort(22, total + earned);
}

/**
 * True if stock-trader.js wants hacks on this server to push its stock down (we hold it short).
 * It posts { grow: [hosts], hack: [hosts] } on port 21 (STOCK_INFLUENCE_PORT in stocks/stock-servers.js;
 * not imported, so workers stay a single file). peek is 0GB, so this adds no RAM.
 */
function influencesStock(ns, target) {
	try {
		return JSON.parse(ns.peek(21)).hack.includes(target);
	} catch {
		return false; // nothing posted (trader not running): leave the market alone
	}
}
