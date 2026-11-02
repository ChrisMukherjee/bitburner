# utils/

Shared helpers, plus one capability check per API. None of them run on their own. Listed RAM is what importing adds on top of the 1.6GB base.

| File | What it does | RAM |
| --- | --- | --- |
| [`config.js`](config.js) | `loadConfig`: defaults, per-BitNode section and `data/config.json` merged. Design: [`docs/config.md`](../docs/config.md) | 0GB |
| [`aug-filter.js`](aug-filter.js) | `wantedBoosts`: the one "worth buying" rule for augments. Design: [`docs/config.md`](../docs/config.md) | 0GB |
| [`bitnode-route.js`](bitnode-route.js) | Next BitNode from `bitnodeRoute` | 1GB |
| [`singularity.js`](singularity.js) | Whether this run can use the Singularity API | 1GB |
| [`gang.js`](gang.js) | What this run can do with gangs; the one place with per-BitNode gang rules | 1GB |
| [`get-all-servers.js`](get-all-servers.js) | Every reachable server | 0.2GB |
| [`find-path.js`](find-path.js) | Route from home to a server | 0.2GB |
| [`nuke-all.js`](nuke-all.js) | Roots every server it can | 0.75GB |
| [`ram-pool.js`](ram-pool.js) | Free RAM across rooted servers, all-or-nothing thread placement | 0.15GB |
| [`targets.js`](targets.js) | Hacking target scoring | 3.35GB |
| [`income.js`](income.js) | Real money income rate on port 24; use it instead of `ns.getTotalScriptIncome` | 0GB |
| [`spending.js`](spending.js) | Spending stages and budgets | 0.6GB |
| [`notify.js`](notify.js) | Toast, terminal and log alerts | 0GB |
| [`start-helper.js`](start-helper.js) | Starts a one-shot helper on home or a rooted server. Design: [`docs/ram.md`](../docs/ram.md) | 2.5GB |
