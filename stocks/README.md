# stocks/

Stock market trading. Design: [`docs/stocks.md`](../docs/stocks.md). RAM figures are approximate; `mem <script>` in game gives the exact cost. Figures follow the game's static RAM check (base 1.6GB plus each NS function named in the script and what it imports).

| Script | What it does | Flags | Requires | RAM |
| --- | --- | --- | --- | --- |
| [`stock-trader.js`](stock-trader.js) | Trades longs using TIX, with 4S data when available; caps any stock at 25% of net worth; can steer prices through the batcher | `--buy-4s`, `--liquidate`, `--promote N`, `--no-influence`, `--no-buy-tix` | TIX, 4S (opt) | 26.25GB |
| [`stock-servers.js`](stock-servers.js) | Library: which server belongs to which stock, and the influence port | import only | none | 0GB |
| [`workers/buy-market-access.js`](workers/buy-market-access.js) | One-shot: buys the TIX API and, if asked, 4S data | `--4s` | none | 6.8GB, for a moment |
| [`workers/promote-stock.js`](workers/promote-stock.js) | Keeps a stock's volatility raised with `ns.dnet.promoteStock`; runs on darknet servers | arg: symbol | Darknet | 3.6GB |
