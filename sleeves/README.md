# sleeves/

Sleeve manager. Design: [`docs/sleeves.md`](../docs/sleeves.md). RAM figures follow the game's static RAM check (base 1.6GB plus each NS function named in the script and what it imports); `mem <script>` in game gives the exact cost. Every Sleeve API call costs 4GB, so the work is split: the manager reads the sleeves, decides, and starts one small worker per kind of job.

Requires column: see the [requirement tags](../README.md#requirements). Everything here needs the Sleeve API (`SF10`), which works in BitNode 10 and anywhere with Source-File 10. Without it the scripts print the advice once and exit; [`startup.js`](../startup.js) only starts them when [`ready.js`](ready.js) says the API works. Buying sleeves and memory only works inside BitNode 10 (Source-File 10 elsewhere gives its sleeves for free and sells nothing). Set `sleeves.enabled` to `false` in `data/config.json` to switch it all off.

| Script | What it does | Flags | Requires | RAM |
| --- | --- | --- | --- | --- |
| [`sleeve-manager.js`](sleeve-manager.js) | One pass every minute (startup.js one-shot): gives each sleeve a job (shock recovery, synchronize, train, the gang's karma, Bladeburner contracts, faction rep, company rep, else cash crime), sends only what changed, falls back to a cash crime when the game refuses a job, and posts a summary on port 40 for `status`. Settings: `sleeves` in the config | none | SF10, SF4 (opt: the game's crime stats) | 17.8GB, plus the worker for a moment |
| [`sleeve-shop.js`](sleeve-shop.js) | One pass every minute (startup.js one-shot): buys a sleeve (BitNode 10), memory upgrades (BitNode 10), then sleeve augmentations, within the `sleeves.buying` stage for the current income | none | SF10, SF4 (opt: augmentation values at 1x or 4x RAM, else cheapest first) | 37.9GB, for a moment |
| [`plan.js`](plan.js) | Library: every decision as a pure function (shock and sync hysteresis, training, the job list, the game's crime chance, spending stage and next purchase) and the port numbers 40-43 | import only | none | 0GB added |
| [`ready.js`](ready.js) | Library: tells [`startup.js`](../startup.js) the Sleeve API works and `sleeves.enabled` is not off | import only | none | 0GB added |
| [`workers/recover.js`](workers/recover.js) | One-shot: shock recovery and synchronization | none | SF10 | 9.6GB, for a moment |
| [`workers/crime.js`](workers/crime.js) | One-shot: sets sleeves to commit a crime | none | SF10 | 5.6GB, for a moment |
| [`workers/train.js`](workers/train.js) | One-shot: gym workouts and university courses, flying the sleeve first when the plan says so | none | SF10 | 13.6GB, for a moment |
| [`workers/work.js`](workers/work.js) | One-shot: faction and company work; tries the next candidate when the game refuses | none | SF10 | 9.6GB, for a moment |
| [`workers/blade.js`](workers/blade.js) | One-shot: Bladeburner contracts | none | SF10 | 5.6GB, for a moment |
| [`workers/crime-stats.js`](workers/crime-stats.js) | One-shot, once per BitNode run: the game's own numbers for every crime, on port 43, so the manager can use the game's success formula | none | SF10, SF4 | 6.6GB (21.6GB at SF4.2, 81.6GB at SF4.1; not started above 4x) |
| [`workers/aug-values.js`](workers/aug-values.js) | One-shot for the shop: what each sleeve augmentation is worth for `sleeves.augments.wantStats`, on port 42 | none | SF10, SF4 | 6.6GB (21.6GB at SF4.2, 81.6GB at SF4.1; not started above 4x) |

## What a sleeve does

First match per sleeve, every pass (the list and its reasons are in [`docs/sleeves.md`](../docs/sleeves.md)):

1. **Shock recovery** from `sleeves.shock.enter` % until `exit` %, then **synchronize** below `sleeves.sync.enter` until `exit`.
2. **Training** where a stat is missing: combat toward what this run needs (Bladeburner's floor while it is the route, the gang invite's gym level), hacking toward the study target.
3. **The jobs the run needs**, one sleeve each: Homicide for the gang's karma while the invite needs it, Bladeburner contracts while Bladeburner is played, rep for each faction with an open goal that the player is not working on (`sleeves.factionShare`), a company where the player holds a job (`sleeves.companyShare`).
4. **Cash crime**: the crime with the most money per second at the sleeve's success chance (the game's formula, with the game's crime stats where Singularity allows, else `sleeves.crimeLadder`).

It never starts or stops the player's own work: [`singularity/player-work.js`](../singularity/player-work.js) owns that.
