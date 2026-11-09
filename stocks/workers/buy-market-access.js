// @ts-check
import { notify } from "/utils/notify.js";
/** @param {NS} ns */
// One-shot: buys the TIX API, then (with --4s) the 4S Market Data TIX API, each only if cash above
// the reserve covers it, then exits. Run by stock-trader.js, so the 2.5GB purchase calls are only
// held for a moment instead of all run. No WSE account: in v3 the TIX API doesn't need one (it only
// unlocks trading by hand in the Stock Market UI).
//   args: [reserve = 0] [--4s]
// It leaves what happened in data/stock-access.json ({ time, what, cash }) for the trader to learn from, because the
// game's refusals are silent otherwise:
//   "4s-poor"      the game refused for lack of money. The 4S price is the listed one times a BitNode multiplier
//                  (2x in BitNode 7, 4x in BitNode 9) that getConstants() does not show, so cash that covers the
//                  listed price can still be short; the trader raises its guess and tries again later.
//   "4s-disabled"  the BitNode options turned 4S off, so there is nothing to buy.
//   "4s-bought", "tix-bought", "tix-poor", "owned"
export async function main(ns) {
	const flags = ns.flags([["4s", false]]);
	const reserve = Number(flags._[0] ?? 0);
	const constants = ns.stock.getConstants();
	const spare = () => ns.getServerMoneyAvailable("home") - reserve;
	/** @param {string} what */
	const leave = (what) => ns.write("data/stock-access.json", JSON.stringify({ time: Date.now(), what, cash: ns.getServerMoneyAvailable("home") }), "w");

	if (!ns.stock.hasTixApiAccess()) {
		if (spare() < constants.TixApiCost) return;
		if (!ns.stock.purchaseTixApi()) {
			leave("tix-poor");
			notify(ns, "[stocks]", "couldn't buy the TIX API.", "warning");
			return;
		}
		leave("tix-bought");
		notify(ns, "[stocks]", `bought the TIX API for $${ns.format.number(constants.TixApiCost)}.`, "success");
	}

	if (!flags["4s"]) return;
	if (ns.stock.has4SDataTixApi()) {
		leave("owned");
		return;
	}
	if (ns.getResetInfo().bitNodeOptions.disable4SData) {
		leave("4s-disabled");
		return;
	}
	if (spare() < constants.MarketDataTixApi4SCost) return;
	if (ns.stock.purchase4SMarketDataTixApi()) {
		leave("4s-bought");
		notify(ns, "[stocks]", "bought the 4S Market Data TIX API.", "success");
	} else {
		// Not a warning toast: with a BitNode price multiplier this is expected until the cash catches up.
		leave("4s-poor");
		ns.print("[stocks] the game refused the 4S Market Data TIX API purchase (not enough money at its real price).");
	}
}
