# go/

IPvGO bot. Design: [`docs/go-bot.md`](../docs/go-bot.md). `mem <script>` in game gives the exact RAM cost.

| Script | What it does | Flags | Requires | RAM |
| --- | --- | --- | --- | --- |
| [`ipvgo-bot.js`](ipvgo-bot.js) | Plays IPvGO, rotating opponents as their bonuses level off; history in `data/go-bonus.json` | `--opponent NAME`, `--size N`, `--illuminati-size N`, `--think MS`, `--games N`, `--debug`, `--no-rotate`, `--no-plan`, `--rotation A,B,..`, `--span N`, `--level-off N`, `--min-win-rate N`, `--status`, `--reset` | none | 9.6GB |
| [`choose-move.js`](choose-move.js) | Library: Monte Carlo tree search (UCT + RAVE) | import only | none | 0GB |
| [`anticheat.js`](anticheat.js) | One-shot for the "IPvGO anticheat" achievement: plays cheat moves until the game ejects you from the subnet (kill the bot first) | `--yes` | SF14.2 | ~10GB |
| [`go-plan.js`](go-plan.js) | Library: which opponents the running plan (gang, Bladeburner, open Daedalus rep goal) wants first; reads `go` in [`config.js`](../config.js) and ports 28, 36 and 23. Also used by `tools/status.js` | import only | none | 0GB |

## In-game record

As of 2026-11-02, one player's run:

| Opponent | Wins | Best streak | Captured nodes | Bonus |
| --- | --- | --- | --- | --- |
| Netburners | 42 / 42 | 42 | 1202 | +17.97% hacknet production |
| Slum Snakes | 41 / 41 | 41 | 1162 | +22.0% crime success |
| The Black Hand | 52 / 53 | 44 | 1540 | +18.27% hacking money |
| Tetrads | 55 / 58 | 52 | 1541 | +16.90% combat stats |
| Daedalus | 196 / 198 | 171 | 5397 | +45.30% reputation gain |
| Illuminati (5x5) | 25 / 39 | 12 | 493 | +17.76% faster hack/grow/weaken |
