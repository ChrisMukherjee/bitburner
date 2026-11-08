# utils/

Shared helpers, plus one capability check per API. None of them run on their own. Listed RAM is what importing adds on top of the 1.6GB base.

| File | What it does | RAM |
| --- | --- | --- |
| [`config.js`](config.js) | `loadConfig`: defaults, per-BitNode section and `data/config.json` merged. Design: [`docs/config.md`](../docs/config.md) | 0GB |
| [`aug-filter.js`](aug-filter.js) | `wantedBoosts`: the one "worth buying" rule for augments; `augValue` for the reset rule, with money stats weighed by the income mix. Design: [`docs/config.md`](../docs/config.md) | 0GB |
| [`bitnode-route.js`](bitnode-route.js) | Next BitNode: `routeStep` (your `bitnodeRoute`, else the `bitnodePlan` suggestion, easiest multipliers first with Source-File 5). Design: [`docs/bitnode-mults.md`](../docs/bitnode-mults.md) | 1GB |
| [`bitnode-mults.js`](bitnode-mults.js) | `bitnodeMults(ns).get(name)`: the BitNode multipliers saved this run, 1 each when unknown (no Source-File 5). Design: [`docs/bitnode-mults.md`](../docs/bitnode-mults.md) | 0GB |
| [`sf5.js`](sf5.js) | Whether this run can read the BitNode multipliers (BitNode 5 or Source-File 5), and the ready check for startup.js | 1GB |
| [`singularity.js`](singularity.js) | Whether this run can use the Singularity API | 1GB |
| [`gyms.js`](gyms.js) | Gym tables (stats, gyms per city, cost) shared by player-work.js and start-gang.js | 0GB |
| [`gang.js`](gang.js) | What this run can do with gangs; the one place with per-BitNode gang rules | 1GB |
| [`pass-log.js`](pass-log.js) | `postPass`: a one-shot keeps the lines of its last pass on port 37 for the debug report. Design: [`docs/debug-report.md`](../docs/debug-report.md) | 0GB |
| [`bladeburner.js`](bladeburner.js) | Whether this run can use the Bladeburner API (BitNode 6/7 or Source-File 6/7) | 1GB |
| [`get-all-servers.js`](get-all-servers.js) | Every reachable server | 0.2GB |
| [`find-path.js`](find-path.js) | Route from home to a server | 0.2GB |
| [`nuke-all.js`](nuke-all.js) | Roots every server it can | 0.75GB |
| [`ram-pool.js`](ram-pool.js) | Free RAM across rooted servers (minus reserved room), all-or-nothing thread placement | 0.15GB |
| [`ram-reserve.js`](ram-reserve.js) | Room kept free on another server for a script waiting to start, on port 34; the RAM pool leaves it out. Design: [`docs/ram.md`](../docs/ram.md) | 0.1GB |
| [`targets.js`](targets.js) | Hacking target scoring | 3.35GB |
| [`income.js`](income.js) | Real money income rate on port 24; use it instead of `ns.getTotalScriptIncome` | 0GB |
| [`income-mix.js`](income-mix.js) | `postIncomeMix`: this run's money by source on port 38; `loadConfig` weighs the money augment stats by it. Only buy-augs.js imports it. Design: [`docs/aug-reset.md`](../docs/aug-reset.md) | 1GB |
| [`income-curve.js`](income-curve.js) | Income history and growth forecast for the reset rule and faction goals. Design: [`docs/aug-reset.md`](../docs/aug-reset.md) | 0GB |
| [`spending.js`](spending.js) | Spending stages and budgets | 0.6GB |
| [`notify.js`](notify.js) | Toast, terminal and log alerts | 0GB |
| [`start-helper.js`](start-helper.js) | Starts a one-shot helper on home or a rooted server; reserves room for it when none has any. Design: [`docs/ram.md`](../docs/ram.md) | 2.6GB |
