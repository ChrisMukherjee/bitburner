# hack/

The hacking engine. Design: [`docs/batcher.md`](../docs/batcher.md). RAM figures are approximate; `mem <script>` in game gives the exact cost, and `?` means none is recorded.

| Script | What it does | Flags | RAM |
| --- | --- | --- | --- |
| [`batcher.js`](batcher.js) | Multi-target JIT hack/grow/weaken batcher; picks the best hack fraction per target and posts its income rate on port 24 | none | ? |
| [`workers/hack.js`](workers/hack.js) | One timed hack; keeps the hacked-money total on port 22 and follows stock influence on port 21 | args: target, land time | 1.7GB |
| [`workers/grow.js`](workers/grow.js) | One timed grow; follows stock influence on port 21 | args: target, land time | 1.75GB |
| [`workers/weaken.js`](workers/weaken.js) | One timed weaken | args: target, land time | 1.75GB |
| [`workers/target-stats.js`](workers/target-stats.js) | One-shot without Formulas.exe: measures targets and reports on port 27 | args: hostnames | about 5.6GB, for a moment |

After editing a worker, restart the batcher.
