# Stocks

[`../stocks/stock-trader.js`](../stocks/stock-trader.js), with its pure helpers [`../stocks/stock-math.js`](../stocks/stock-math.js)
(decision math, the cycle clock) and [`../stocks/stock-meter.js`](../stocks/stock-meter.js) (measuring), and the one-shots
[`../stocks/workers/buy-market-access.js`](../stocks/workers/buy-market-access.js) and
[`../stocks/workers/promote-stock.js`](../stocks/workers/promote-stock.js).

## How the game's market works (v3.0.0, `src/StockMarket`)

The rules below follow from this, so it is written down once:

- A tick is 6 seconds (4 with stored bonus time). Each stock moves up with probability equal to its **forecast**, by a size
  of `random x volatility` (one random number per tick, shared by every stock; `getVolatility` is the largest it can be, so the
  average move is half of it). The expected drift per tick is therefore `(forecast - 0.5) x volatility`.
- The forecast barely moves inside a **cycle** of `TicksPerCycle` (75) ticks. At each cycle boundary, all on the same tick, every
  stock flips to its mirror forecast (0.7 becomes 0.3) with 45% chance. The flip is only visible with 4S, after it happened.
- Buying is at the ask, selling at the bid, a per-stock spread of 0.1 to 2% each way (so a round trip costs 0.2 to 4%), plus a flat $100k commission each time. Volatility runs from 0.4% to 4% a tick, so on a quiet, wide-spread stock the drift of a 0.6 forecast (0.05% a tick) needs a whole cycle just to pay the spread.
- Our trades barely move anything: the forecast shifts 0.006 points per `shareTxForMovement` (12k to 216k) shares and never below 55% / 45%.
  Even a position of 20 million shares moves it about a point. Large positions cost spread and commission, not price impact. A stock holds at most 20% of its shares (`getMaxShares`).
- Hacks and grows on a company's server shift its **second-order** forecast (which the forecast drifts toward) by 0.1 with a
  chance equal to the share of the server's money moved. Slow, but the batcher moves a lot of money.
- 4S Market Data TIX API costs 25b times a BitNode multiplier (x2 in BitNode 7, x4 in BitNode 9, 1 elsewhere); the TIX API is a flat
  5b and needs no WSE account. The BitNode options can turn 4S off. Shorting needs BitNode 8 or Source-File 8.2; limit and stop
  orders need 8.3 (useless for a tick-by-tick trader).

## Decisions

- **Longs only.** The short calls cost 5GB of RAM even unused (see Open).
- **4S when owned, estimates otherwise.** With 4S data the forecast is exact; without it, forecasts come
  from the share of recent ticks that went up (a long window to buy, a short one to catch a flip). Checked
  every tick, so buying 4S mid-run switches over.
  The thresholds are not arbitrary: the up-share over 40 ticks has a standard deviation of about 0.08 around the true
  forecast, so a buy at 0.60 is roughly a 90% one-sided bound against a stock that is really at 0.50. With ~30
  stocks some false buys still happen, which the 0.45 sell line, the 10-tick flip check and the 25% cap contain.
  A stock is only bought once it has the full 40 ticks (`buyHistory`), since the 90% bound above assumes the whole window (with 15 ticks the spread
  is about 0.13, and a 0.60 reading is not much evidence); it may be sold on 15 ticks (`minHistory`). A restart empties the history, so
  buying resumes a few minutes later. The estimated volatility is twice the average move seen, so both modes put the same number on a stock.
- **Buy only when the edge pays for the costs (`stocks.costAware`).** A buy has to beat its round trip: expected drift per tick
  times the **holding horizon**, minus the spread, must exceed the two commissions (`netEdge`). The horizon is the number of ticks the
  forecast can be counted on: with the cycle clock, the updates before the next boundary; without it, half a cycle (the average wait
  to a boundary, ignoring the 55% chance the forecast survives it, so it errs cautious). Spread comes from the live ask and bid.
  Before this a 0.55 forecast on a low-volatility stock was bought and the spread took the gain.
- **Cycle clock (`stocks.cycleClock`, 4S only).** When a quarter of the stocks cross 0.5 on one tick, that is a boundary, and the next
  is exactly 75 ticks later. So the trader knows how many ticks a fresh forecast is good for: it buys freely right after a boundary
  and not in the last ticks before one. Exits are not gated: selling a stock whose forecast turned down is right whenever (the sale's
  spread and commission are paid anyway, only earlier). Not available without 4S: the estimates are too noisy to see the flips.
- **Rotation (`stocks.rotate`, 4S only).** With all cash invested and a clearly better stock waiting (below its 25% cap), the weakest
  holding is sold, in part, to fund it when the extra drift over the horizon pays for the new stock's round trip (`swapEdge`), at
  most 3 swaps a tick. The sold stock's own exit is not charged: it would be sold at some point anyway. Not used with estimates,
  where small differences between stocks are noise.
- **Cash for other buyers (`stocks.holdBackForBuyers`).** The home RAM and cores buyers, the program buyer and the donation buyer post
  the cash their next purchase needs on port 33 ([`singularity/ready.js`](../singularity/ready.js)). The trader used to spend every coin
  above its reserve (2b late) each tick, so a purchase needing more than that (home upgrades keep 2 minutes of income as well) could
  never fire. Now the reserve is at least that need, when the note is fresh (under 2 market cycles old; the buyers repost after each pass)
  and income covers the gap within one cycle (7.5 minutes). A need farther away is not waited for, since idling cash for hours costs more
  than it saves. The time spent holding back is in the measuring figures.
- **No stock over 25% of net worth**, so one wrong estimate can't sink everything. Tiny trades are skipped
  because each one pays a flat commission.
- **Market access is bought by a one-shot helper**, so the purchase calls aren't held all run (see
  [`ram.md`](ram.md)). The 4S price is `getConstants().MarketDataTixApi4SCost` times a BitNode multiplier that the constants do not show.
  The trader uses the saved BitNode multiplier when it has one (Source-File 5, [`bitnode-mults.md`](bitnode-mults.md)); otherwise it starts at the
  listed price and the helper reports back in `data/stock-access.json` when the game refuses: the trader doubles its price guess and waits for
  the cash (at most six doublings), instead of starting the helper every tick with a warning toast each time. The helper also reports when the
  BitNode options turned 4S off (`disable4SData`), and the trader stops asking.
- **Steering prices through the batcher.** The trader posts the servers of companies it holds on port 21;
  the batcher's grow workers then pass `stock: true` to push those prices up. `--no-influence` turns it off.
- **`--promote N`** raises volatility (not forecast) of the biggest longs. That only helps with exact 4S
  forecasts. `promoteStock` only runs on darknet servers, so it needs servers the darknet scripts opened.
- **First income where hacking is worthless.** Where the BitNode multipliers say hacking pays almost nothing (BitNode 8),
  startup.js starts the trader at the early stage (64GB home) instead of the late one (256GB). It needs about 26GB on
  home, so it still can't run on the 8GB a BitNode starts with; below 64GB nothing here earns until home grows.
  See [`bitnode-mults.md`](bitnode-mults.md).
- Every switch above is `stocks` in [`../config.js`](../config.js) (all true); a player turns one off in `data/config.json`.

## Measuring it

The trader posts a summary on port 26 from its first tick and every 10 ticks (a minute) after, and prints it in its log. `tools/status.js`
shows the position line and, once the window is ten minutes old, the measuring line. All figures cover the current **window**, which starts
when the trader starts or when 4S arrives (so each mode is measured on its own):

- **profit per hour, and as a rate on working capital** (`returnPerHour`): money made by stocks since the window began (holdings included,
  access fees excluded because the window starts after them) over the time, and divided by the average capital that was invested or
  idle above the reserve. The yardstick for the home upgrades and the other places cash can go.
- **invested / idle / held back**: time-weighted share of capital in shares, share sitting as cash above the reserve, and share of the time
  buying was held back for another buyer. High idle means too few stocks pass the filters (check the thresholds or the 25% cap), not a slow tick.
- **max drawdown**: largest fall of the window's profit from its own peak.
- **trading costs**: spread (half the gap on each side of a trade) plus commissions paid.
- **drift captured** (4S only): the price change the held positions had, over what their forecasts promised. Near 100% means the model
  prices what happens; well under means flips and late exits eat the edge; 0 or negative over a long window means something is wrong.
- **next flip in N ticks**: the cycle clock, once it has seen a boundary.

Ranking the improvements by size is for the player's own logs: compare profit per hour and drift captured before and after a change, over
at least a few cycles (an hour). The raw summary is also in the debug report's port dump.

## Open

Positions are lost when augs are installed, so [`auto-reset.js`](../singularity/auto-reset.js) sells everything
(`stock-trader.js --liquidate`) before the buyer runs, and the reset rule counts stock value as cash
([`aug-reset.md`](aug-reset.md)). A manual install does not liquidate.

- **Shorts.** A stock below 45% is a short opportunity of the same size as the longs, which doubles what the trader can use, and in
  BitNode 8 it is the only income. `buyShort` and `sellShort` cost 2.5GB each in the static check, so the long-running trader cannot carry them.
  Plan: a one-shot worker that takes a batch of short orders (buy or sell, symbol, shares) and a capability helper `utils/stocks.js`
  (`canShort`: BitNode 8 or Source-File 8.2) so the trader uses it only when available; hacks on the company would also be posted on port 21
  for held shorts (the field already exists). The archived [`stock-trader-v3.js`](../archive/stocks/stock-trader-v3.js) has the old logic.
- **Selling to fund a purchase.** Holding back (above) lets income reach another buyer's need; it does not sell shares for it. A buyer that
  posted its payback with its need would let the trader compare it with its own measured return per hour and liquidate when the purchase wins.
- **Estimates.** Without 4S the forecast is a plain up-share. A Bayesian estimate with the 45%-per-cycle flip rate as a prior, and the cycle
  clock learned from the pooled flips of all 30 stocks, would catch flips faster; not built, since 4S is cheap compared with late income.
