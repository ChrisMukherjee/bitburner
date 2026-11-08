# go/

IPvGO bot. Design: [`docs/go-bot.md`](../docs/go-bot.md). The in-game record is in the [root README](../README.md). `mem <script>` in game gives the exact RAM cost.

| Script | What it does | Flags | RAM |
| --- | --- | --- | --- |
| [`ipvgo-bot.js`](ipvgo-bot.js) | Plays IPvGO, rotating opponents as their bonuses level off; history in `data/go-bonus.json` | `--opponent NAME`, `--size N`, `--illuminati-size N`, `--think MS`, `--games N`, `--debug`, `--no-rotate`, `--no-plan`, `--rotation A,B,..`, `--span N`, `--level-off N`, `--min-win-rate N`, `--status`, `--reset` | 9.6GB |
| [`choose-move.js`](choose-move.js) | Library: Monte Carlo tree search (UCT + RAVE) | import only | 0GB |
| [`go-plan.js`](go-plan.js) | Library: which opponents the running plan (gang, Bladeburner, open Daedalus rep goal) wants first; reads `go` in [`config.js`](../config.js) and ports 28, 36 and 23. Also used by `tools/status.js` | import only | 0GB |
