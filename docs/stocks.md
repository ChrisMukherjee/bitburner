# Stocks

[`../stocks/stock-trader.js`](../stocks/stock-trader.js), with [`../stocks/workers/buy-market-access.js`](../stocks/workers/buy-market-access.js)
and [`../stocks/workers/promote-stock.js`](../stocks/workers/promote-stock.js).

## Decisions

- **Longs only.** Shorting needs BitNode 8 or Source-File 8.2, and the short calls cost 5GB even unused.
  The archived version with `--short` is the starting point when that's available.
- **4S when owned, estimates otherwise.** With 4S data the forecast is exact; without it, forecasts come
  from the share of recent ticks that went up (a long window to buy, a short one to catch a flip). Checked
  every tick, so buying 4S mid-run switches over.
- **No stock over 25% of net worth**, so one wrong estimate can't sink everything. Tiny trades are skipped
  because each one pays a flat commission.
- **Market access is bought by a one-shot helper**, so the purchase calls aren't held all run (see
  [`ram.md`](ram.md)).
- **Steering prices through the batcher.** The trader posts the servers of companies it holds on port 21;
  the batcher's grow workers then pass `stock: true` to push those prices up. `--no-influence` turns it off.
- **`--promote N`** raises volatility (not forecast) of the biggest longs. That only helps with exact 4S
  forecasts. `promoteStock` only runs on darknet servers, so it needs servers the darknet scripts opened.

- **First income where hacking is worthless.** Where the BitNode multipliers say hacking pays almost nothing (BitNode 8),
  startup.js starts the trader at the early stage (64GB home) instead of the late one (256GB). It needs about 26GB on
  home, so it still can't run on the 8GB a BitNode starts with; below 64GB nothing here earns until home grows.
  See [`bitnode-mults.md`](bitnode-mults.md).

## Open

Positions are lost when augs are installed; selling everything before a reset is planned with the reset rule.
