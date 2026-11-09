# tests/

Automated tests for the scripts, run on your PC with Node, never in game. Design: [`docs/testing.md`](../docs/testing.md).

```powershell
npm test
```

Needs Node 22 or later (`node --version`). It prints one line per test and ends with the pass and fail counts; a failing
test prints what it expected and what it got. To run one file: `node --import ./tests/support/register.mjs --test tests/batcher.test.mjs`.

These are `.mjs` files, so filesync never pushes them to the game, and they have no RAM cost or `Requires` tag. Tests
named `regression: ...` pin a bug that was fixed; if one fails, that bug is back.

| File | What it checks |
| --- | --- |
| [`reset-rule.test.mjs`](reset-rule.test.mjs) | [`singularity/buy-augs.js`](../singularity/buy-augs.js) reset rule: buy order and 1.9x markup, cheapest fill, favor formula, invite requirements, The Red Pill, minimum run age, `holdForQueued`, NeuroFlux-only resets, NeuroFlux at later moments (regression), waiting for a better batch and `maxWaitMinutes`, NeuroFlux-only reset held for a home upgrade (regression), Daedalus donations and favor, Daedalus off under Bladeburner (regression), Daedalus push, after The Red Pill |
| [`config.test.mjs`](config.test.mjs) | [`utils/config.js`](../utils/config.js) `loadConfig`: defaults, overrides merge (lists replace), `bitnodes` sections, broken `data/config.json`, the `bn1` challenge, Bladeburner route turning off the Daedalus chase (regression), stale or missing Bladeburner state, income mix |
| [`player-work.test.mjs`](player-work.test.mjs) | [`singularity/player-work.js`](../singularity/player-work.js) gym step: lowest stat, best affordable gym, keeping a running class, Iron Gym to Powerhouse once affordable (regression), flying to a gym city or holding for an invite; [`utils/study.js`](../utils/study.js) course choice |
| [`startup.test.mjs`](startup.test.mjs) | [`startup.js`](../startup.js) passes in a fake game: stage from home RAM, a fresh 8GB BitNode placing the batcher off home with its imports, Singularity scripts left out without the API, one one-shot at a time without starving any, `every`, ready checks, `startupSkip`, restart wait and its doubling, Go bot opponent swap on a new stage, `--restart`, old looping copies of one-shots, batcher stopped and stock trader early where hacking pays nothing |
| [`stock-trader.test.mjs`](stock-trader.test.mjs) | [`stocks/stock-trader.js`](../stocks/stock-trader.js) without 4S: a stock is bought only after the full 40 ticks of history (15 are enough to hold or sell it), and exact 4S forecasts need no history |
| [`reset-sequence.test.mjs`](reset-sequence.test.mjs) | The reset after RESET advice: [`singularity/auto-reset.js`](../singularity/auto-reset.js) order (clear home, stop every stock trader, sell, buy, install) and when it refuses to install; [`singularity/workers/aug-buyer.js`](../singularity/workers/aug-buyer.js) buy order, prerequisites, NeuroFlux against an affordable home upgrade, stale plans; [`singularity/install-augs.js`](../singularity/install-augs.js) safeguard, `--force`, home upgrades before the install, a refused install |
| [`batcher-formulas.test.mjs`](batcher-formulas.test.mjs) | [`hack/batcher.js`](../hack/batcher.js) with Formulas.exe: grow threads asked at min security from the money the hack leaves (and catch-up), timings at min security while security is a bit high, prep wave landing order and sizing, prep waves short of RAM |
| [`batcher.test.mjs`](batcher.test.mjs) | [`hack/batcher.js`](../hack/batcher.js) without Formulas.exe: weaken and grow threads cover each batch, catch-up growth, batch size against the RAM share, landing order and gaps, every op able to start, desync to prep, RAM-time per batch, grow on home's cores; [`utils/ram-pool.js`](../utils/ram-pool.js) all-or-nothing placement |
| [`income-curve.test.mjs`](income-curve.test.mjs) | [`utils/income-curve.js`](../utils/income-curve.js): flat and growing forecasts, fit from samples, cap, sample history across runs |
| [`aug-filter.test.mjs`](aug-filter.test.mjs) | [`utils/aug-filter.js`](../utils/aug-filter.js): which augments are wanted per route and income mix, their value, `never` and special augments |
| [`bitnode-route.test.mjs`](bitnode-route.test.mjs) | [`utils/bitnode-route.js`](../utils/bitnode-route.js): route steps counting this destroy, ease score, plan suggestion by tier and multipliers |
| [`buy-programs.test.mjs`](buy-programs.test.mjs) | [`singularity/buy-programs.js`](../singularity/buy-programs.js): the darknet program before SQLInject only on a home of `programs.darknetFirstHomeRam` GB or more, configurable threshold, what a pass buys at each size |
| [`darknet-stasis.test.mjs`](darknet-stasis.test.mjs) | [`darknet/dnet-manager.js`](../darknet/dnet-manager.js) stasis targets (usable RAM, cap, 1.5x keep edge, stationary and small servers skipped, no rewrite when unchanged), [`darknet/crawler.js`](../darknet/crawler.js) link and unlink step, [`stocks/stock-trader.js`](../stocks/stock-trader.js) promoter placement and stopping |
| [`darknet-hint.test.mjs`](darknet-hint.test.mjs) | [`darknet/hint-interpreter.js`](../darknet/hint-interpreter.js): PHP 5.4 anagram candidates (order, duplicates, limit) |
| [`darknet-migrate.test.mjs`](darknet-migrate.test.mjs) | Induced migration: [`darknet/dnet-manager.js`](../darknet/dnet-manager.js) waits for the map to stall, picks targets (not stationary, linked or unopened ones), rests and gives up on servers; [`darknet/crawler.js`](../darknet/crawler.js) pushes a neighbour target with all free RAM; [`darknet/migrate.js`](../darknet/migrate.js) stops when the target moves or after repeated refusals |
| [`go.test.mjs`](go.test.mjs) | [`go/go-plan.js`](../go/go-plan.js): plan signals (fresh, stale, Bladeburner states, open Daedalus goal), opponent order (boosts first, `--no-plan`, `--rotation`, `planAware` off, built-in rotation); [`go/choose-move.js`](../go/choose-move.js) on tiny boards: capture, legality, own eyes, superko, `play`, grid conversion |
| [`gang.test.mjs`](gang.test.mjs) | [`utils/gang.js`](../utils/gang.js) access rules and [`gang/ready.js`](../gang/ready.js); [`gang/gang-manager.js`](../gang/gang-manager.js): recruiting, ascension gain and respect share, training vs earning tasks per focus, wanted-level cooling, territory warfare conditions, clash hysteresis, equipment order and budget |
| [`stocks.test.mjs`](stocks.test.mjs) | [`stocks/stock-trader.js`](../stocks/stock-trader.js): price history, sell triggers (forecast, short-window flip, warm-up hold), commission-aware profit, buy order, per-stock cap, room, shorts and weak forecasts skipped, the influence port; [`stocks/stock-servers.js`](../stocks/stock-servers.js) map |
| [`bladeburner.test.mjs`](bladeburner.test.mjs) | [`bladeburner/state.js`](../bladeburner/state.js) port state (stale state and plan, train floor, Black Ops flag), ready checks, [`bladeburner/bb-manage.js`](../bladeburner/bb-manage.js) states (boot, train, hold, run, off) and skill spending, [`bladeburner/route-model.js`](../bladeburner/route-model.js) skill formulas, chances, rank model and route projection |
| [`repo.test.mjs`](repo.test.mjs) | Whole repo: imports and script paths exist, startup.js's scripts exist, every script is in its folder README, aliases use absolute paths, [`tools/status.js`](../tools/status.js) parses startup.js's list and the Go rotation |
| [`support/register.mjs`](support/register.mjs) | Not a test: loaded first; maps game import paths to the repo ([`support/game-path.mjs`](support/game-path.mjs), [`support/hooks.mjs`](support/hooks.mjs) for older Node) |
| [`support/fake-ns.mjs`](support/fake-ns.mjs) | Not a test: the fake `ns` (files, ports, cash, recorded calls; throws on anything not set up) |
| [`support/fake-world.mjs`](support/fake-world.mjs) | Not a test: a fake game world on top of it (servers with RAM and root, processes, files copied to servers, BitNode and Source-Files) for scripts that start and place other scripts |

## Writing a test

- Import the script by its game path (`import { gymStep } from "/singularity/player-work.js"`); export the function from
  the script if it isn't yet. Build `ns` with `fakeNs({ files, ports, money, overrides })`.
- Use the real config (`loadConfig(fakeNs())`) and change only what the test is about, so the test follows the defaults.
- For a bug fix, write the test first, see it fail, then fix. Name it `regression: <what went wrong>`.
