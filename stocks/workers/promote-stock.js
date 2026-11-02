/** @param {NS} ns */
// Keeps a stock's volatility raised with ns.dnet.promoteStock (the effect fades if left alone).
// Started and stopped by stock-trader.js --promote; more threads = stronger effect.
// promoteStock only works on a darknet server, so stock-trader.js runs this on darkweb or a stasis-linked server.
export async function main(ns) {
	const sym = ns.args[0];
	while (true) {
		const result = await ns.dnet.promoteStock(sym);
		if (!result.success) await ns.sleep(1000); // don't spin if it fails at once
	}
}
