# corp/

Corporation manager. Design: [`docs/corporation.md`](../docs/corporation.md). RAM figures follow the game's static RAM check (base 1.6GB plus each NS function named in the script and what it imports); `mem <script>` in game gives the exact cost.

Requires column: see the [requirement tags](../README.md#requirements). The Corporation API (`SF3`) works in BitNode 3, or anywhere with Source-File 3. In BitNode 3 the corporation starts free on seed money; elsewhere it costs $150b of your cash, which the manager spends once you have `corp.selfFundCash` (2) times that. Below Source-File 3.3, outside BitNode 3, the Office and Warehouse APIs are $50b unlocks out of the corporation's own $150b, so that start is slow. Without the API the manager prints the advice once and exits; a BitNode that disables corporations gets one line with the game's reason, and so does `challenge bn3` (no corporation in BitNode 3, [`achievements/bn3-challenge.md`](../achievements/bn3-challenge.md)). Settings are `corp` in the config (`corp.enabled: false` stops it).

The corporation's functions cost 10GB (reads) and 20GB (actions) each, so the manager names none of them: every call goes through the call worker, started with exactly the RAM its batch needs, in as few batches as the largest free block allows. The manager's summary is on port 48 (`status` shows it); tail `corp/corp-manager.js` for every pass.

| Script | What it does | Flags | Requires | RAM |
| --- | --- | --- | --- | --- |
| [`corp-manager.js`](corp-manager.js) | Runs the corporation: creates it, divisions and cities, offices and jobs, warehouses and boost materials, products and prices, research, the four investment rounds, going public, dividends and bribes; summary on port 48 | none | SF3, SF4 (opt) for bribes | 5.9GB, plus its call workers |
| [`plan.js`](plan.js) | Library: the manager's decisions as pure functions (setup, upkeep, growth, offers, dividends, bribes, the read calls, batch packing) | import only | none | 1.6GB |
| [`formulas.js`](formulas.js) | Library: the game's corporation prices and formulas (upgrades, offices, warehouses, adverts, boost-material optimum, party cost, offers, dividends) | import only | none | 1.6GB |
| [`ready.js`](ready.js) | Library: tells [`startup.js`](../startup.js) when the manager has work (a corporation exists or can be made now) | import only | none | 2.7GB |
| [`workers/call.js`](workers/call.js) | One-shot: runs a list of corporation calls by name and posts the results on port 49; started with `ramOverride` = 1.6GB + each distinct function's cost | arg: JSON | SF3 | 1.6GB static; runs with 11.6GB to a few hundred GB, for a moment |

[`startup.js`](../startup.js) starts the manager once there's work: the Corporation API works, `corp.enabled` is on, and a corporation exists or can be made (on seed money in BitNode 3, or self-funded with the cash at `selfFundCash` x $150b).
