# stocks/

Stock market trading. Design: [`docs/stocks.md`](../docs/stocks.md). RAM figures are approximate; `mem <script>` in game gives the exact cost. Figures follow the game's static RAM check (base 1.6GB plus each NS function named in the script and what it imports).

| Script | What it does | Flags | Requires | RAM |
| --- | --- | --- | --- | --- |
| [`stock-trader.js`](stock-trader.js) | Trades longs using TIX, with 4S data when available. Buys only when the drift over the time the forecast lasts beats the spread and commissions, tracks the market's cycle boundaries (4S), rotates into clearly better stocks, keeps cash another buyer is about to need, caps any stock at 25% of net worth, can steer prices through the batcher. Posts a summary with its own measuring figures (profit per hour, invested/idle share, drawdown, costs) on port 26 from its first tick. Switches: `stocks` in [`config.js`](../config.js) | `--buy-4s`, `--liquidate`, `--promote N`, `--no-influence`, `--no-buy-tix` | TIX, 4S (opt) | 26.35GB |
| [`stock-math.js`](stock-math.js) | Library: spread, holding horizon, expected edge and swap edge, the cycle clock, 4S price learning, the claim of other buyers | import only | none | 0GB |
| [`stock-meter.js`](stock-meter.js) | Library: the trader's time-weighted measuring (profit per hour, invested share, drawdown, costs, drift captured) | import only | none | 0GB |
| [`stock-servers.js`](stock-servers.js) | Library: which server belongs to which stock, and the influence port | import only | none | 0GB |
| [`workers/buy-market-access.js`](workers/buy-market-access.js) | One-shot: buys the TIX API and, if asked, 4S data; leaves what happened in `data/stock-access.json` so the trader can learn the real 4S price (BitNode 7 and 9 charge more) or that 4S is turned off | `--4s` | none | 7.8GB, for a moment |
| [`workers/promote-stock.js`](workers/promote-stock.js) | Keeps a stock's volatility raised with `ns.dnet.promoteStock`; runs on darknet servers | arg: symbol | Darknet | 3.6GB |
