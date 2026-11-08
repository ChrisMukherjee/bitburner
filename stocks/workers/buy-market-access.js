// @ts-check
import { notify } from "/utils/notify.js";
/** @param {NS} ns */
// One-shot: buys the TIX API, then (with --4s) the 4S Market Data TIX API, each only if cash above
// the reserve covers it, then exits. Run by stock-trader.js, so the 2.5GB purchase calls are only
// held for a moment instead of all run. No WSE account: in v3 the TIX API doesn't need one (it only
// unlocks trading by hand in the Stock Market UI).
//   args: [reserve = 0] [--4s]
export async function main(ns) {
	const flags = ns.flags([["4s", false]]);
	const reserve = Number(flags._[0] ?? 0);
	const constants = ns.stock.getConstants();
	const spare = () => ns.getServerMoneyAvailable("home") - reserve;

	if (!ns.stock.hasTixApiAccess()) {
		if (spare() < constants.TixApiCost) return;
		if (!ns.stock.purchaseTixApi()) {
			notify(ns, "[stocks]", "couldn't buy the TIX API.", "warning");
			return;
		}
		notify(ns, "[stocks]", `bought the TIX API for $${ns.format.number(constants.TixApiCost)}.`, "success");
	}

	if (!flags["4s"] || ns.stock.has4SDataTixApi()) return;
	if (spare() < constants.MarketDataTixApi4SCost) return;
	if (ns.stock.purchase4SMarketDataTixApi()) {
		notify(ns, "[stocks]", `bought the 4S Market Data TIX API for $${ns.format.number(constants.MarketDataTixApi4SCost)}.`, "success");
	} else {
		notify(ns, "[stocks]", "couldn't buy the 4S Market Data TIX API.", "warning");
	}
}
