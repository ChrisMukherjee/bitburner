# hack/

The hacking engine. Design: [`docs/batcher.md`](../docs/batcher.md). RAM figures are approximate; `mem <script>` in game gives the exact cost. Figures follow the game's static RAM check (base 1.6GB plus each NS function named in the script and what it imports).

| Script | What it does | Flags | Requires | RAM |
| --- | --- | --- | --- | --- |
| [`batcher.js`](batcher.js) | Multi-target JIT hack/grow/weaken batcher; picks the best hack fraction per target (up to 80%), runs grow and weaken on home's cores, posts its income rate on port 24 and its RAM claim on port 31 | none | Formulas (opt), SF5 (opt) | 6.05GB |
| [`ready.js`](ready.js) | Not run: startup.js's ready check for the batcher (and `hackIsWorthless`, which starts the stock trader earlier); false (batcher not started) where `ScriptHackMoney` x `ScriptHackMoneyGain` is below `hackWorth.minProduct`. Design: [`docs/bitnode-mults.md`](../docs/bitnode-mults.md) | none | SF5 (opt) | 1GB when imported |
| [`xp-farm.js`](xp-farm.js) | Fills RAM the batcher leaves free with weaken threads on the best XP target (`xpFarm.target`, `auto` by default) for hacking XP; stands down while share-manager shares. Design: [`docs/xp-farm.md`](../docs/xp-farm.md) | `--no-home`, `--target`, `--headroom`, `--max-threads` | SF4 (opt) | 5.2GB (12.7GB at SF4.1) |
| [`workers/hack.js`](workers/hack.js) | One timed hack; keeps the hacked-money total on port 22 and follows stock influence on port 21 | args: target, land time | none | 1.75GB |
| [`workers/grow.js`](workers/grow.js) | One timed grow; follows stock influence on port 21 | args: target, land time | none | 1.8GB |
| [`workers/weaken.js`](workers/weaken.js) | One timed weaken | args: target, land time | none | 1.8GB |
| [`workers/target-stats.js`](workers/target-stats.js) | One-shot every 30s: measures targets (without Formulas.exe) and home's cores, reports on port 27 | args: hostnames | none | about 7.7GB, for a moment |

After editing a worker, restart the batcher.
