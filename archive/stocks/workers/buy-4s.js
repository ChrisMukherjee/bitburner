import { notify } from "/utils/notify.js";
/** @param {NS} ns */
// One-shot: buys the 4S Market Data TIX API, then exits. Run by stock-trader.js --buy-4s,
// so the 2.5GB purchase call is only held for a moment instead of all run.
export async function main(ns) {
	if (ns.stock.has4SDataTixApi()) return;
	if (ns.stock.purchase4SMarketDataTixApi()) {
		notify(ns, "[stocks]", `bought the 4S Market Data TIX API for $${ns.format.number(ns.stock.getConstants().MarketDataTixApi4SCost)}.`, "success");
	} else {
		notify(ns, "[stocks]", "couldn't buy the 4S Market Data TIX API (not enough cash, or no TIX API account?).", "warning");
	}
}
