/** @param {NS} ns */
export async function main(ns) {
	const target = ns.args[0];
	const landTime = ns.args[1] || 0; // absolute Date.now() timestamp to land at; 0 = no delay

	// The action's duration depends on the target's security at the instant it starts, so measure it
	// here, synchronously right before the call, and wait just long enough to land at landTime.
	const duration = ns.getGrowTime(target);
	const additionalMsec = Math.max(0, landTime - Date.now() - duration);
	await ns.grow(target, { additionalMsec, stock: influencesStock(ns, target) });
}

/**
 * True if stock-trader.js wants grows on this server to push its stock up (we hold it long).
 * It posts { grow: [hosts], hack: [hosts] } on port 21 (STOCK_INFLUENCE_PORT in utils/stock-servers.js;
 * not imported, so workers stay a single file). peek is 0GB, so this adds no RAM.
 */
function influencesStock(ns, target) {
	try {
		return JSON.parse(ns.peek(21)).grow.includes(target);
	} catch {
		return false; // nothing posted (trader not running): leave the market alone
	}
}
