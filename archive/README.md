# archive/

Old and replaced scripts, kept on purpose (they count toward the file-count achievement).
Nothing here is run by startup.js. Filesync skips this folder, so these files only exist
in the game if they were copied there before.

Each line says what the file did and what its successor changed. "Next" is the next
-vX file, or the current script when it is the last archived version. When a working
script is replaced, it is saved here as name-vX.js and gets a line in this list.

## Hacking: from first scripts to the batcher

- `n00dles.js`: endless `hack("n00dles")` loop, the very first script. Next: `early-hack.js` adds weaken/grow thresholds and a target argument.
- `early-hack.js`: the tutorial weaken/grow/hack loop against one target. Next: `deployer-v1.js` copies it to servers and runs it there.
- `purchase-server-8gb.js`: the tutorial script that buys 8GB cloud servers and runs the early-hack template on them. Next: `purchase-servers-v1.js`.
- `deployer-v1.js`: roots the servers next to home and runs the early-hack template on n00dles with all their RAM. Next (v2): scans the whole network, uses `attempt-nuke.js`, picks the best target.
- `deployer-v2.js`: as v1 over the whole network with the best target. Next (v3): uses separate hack/grow/weaken workers instead of one loop, and loops forever.
- `deployer-v3.js`: picks one action (weaken, grow or hack) for the best target and fills every rooted server with it. Next: `hack-manager-v1.js` adds an "xp" mode and the shared worker pool.
- `hack-manager-v1.js`: deployer-v3 plus an "xp" mode (grow/weaken joesguns for exp) and `utils/workpool.js`. Next (v2): moves to the utils/ and workers/ folders and splits the pool across the top 3 targets.
- `hack-manager-v2.js`: one action per target, pool split across the top 3 targets. Next: `batch-manager.js` switches to HWGW batches.
- `batch-manager.js`: first HWGW batcher. Preps one target, then sends 10% hack batches timed to land in order, waiting until the whole batch fits in free RAM. Next: `jit-batch-manager-v1.js` drops the RAM wait so a batch starts every second (pipelining).
- `jit-batch-manager-v1.js`: pipelined HWGW against one target, one batch per second. Next (v2): rewritten around a CONFIG, all-or-nothing RAM placement split across servers, target switching with hysteresis, prep waves, many batches per tick.
- `jit-batch-manager-v2.js`: see above. Next (v3): ops use live durations and pass their delay as `additionalMsec`; a launch horizon stops RAM being hoarded by far-future batches.
- `jit-batch-manager-v3.js`: see above. Next (v4): workers get an absolute landing time and measure their own duration when they start, with a safety factor for higher security.
- `jit-batch-manager-v4.js`: single-target JIT batcher. Next (v5): multi-target, ranked by `utils/targets.js` and fed from one shared RAM pool, best target first.
- `jit-batch-manager-v5.js`: multi-target batcher. Next (v6): uses Formulas.exe when owned (exact batch sizes, rank by money per GB per second, one combined prep wave) and reports income from port 22.
- `jit-batch-manager-v6.js`: see above. Next: `batcher-v7.js` (renamed) execs each worker just before it starts, so batches only hold RAM while running (about 2.4x more batches), and rate-limits targets by a RAM budget.
- `batcher-v7.js`: see above. Next: `batcher.js` sizes hack fraction per target with Formulas (up to 50%), measures targets with `workers/target-stats.js` without Formulas, and drops the analyze calls (about 6GB less RAM).
- `attempt-nuke.js`: opens ports and nukes one server. Replaced by `utils/nuke-all.js`, which roots everything in one call.
- `startup.js`: BN1 startup that launched hacknet-manager, pserv-manager and hack-manager. Next: `startup-v2.js`.
- `startup-v2.js`: stage-tagged script list (early/mid/late by home RAM), home only. Next: `startup.js` also runs scripts on rooted servers when home is too small, uses absolute paths, adds city factions, and prints the status screen when typed by hand.

## Workers

- `workers/hack-v1.js`, `grow-v1.js`, `weaken-v1.js`: one call on `args[0]`. Next (v2): optional sleep delay in `args[1]`.
- `workers/hack-v2.js`, `grow-v2.js`, `weaken-v2.js`: sleep, then act. Next (v3): the delay goes to the game as `additionalMsec`.
- `workers/hack-v3.js`, `grow-v3.js`, `weaken-v3.js`: `additionalMsec` delay. Next (v4 for hack/grow, current `weaken.js`): `args[1]` is an absolute landing time and the worker measures its own duration.
- `workers/hack-v4.js`, `grow-v4.js`: absolute landing time. Next: `hack.js` adds the hacked total on port 22 and both pass `stock: true` for servers the stock trader posts on port 21.
- `workers/contract-solver-v1.js`: solved 9 contract types. Next: `contract-solver.js` solves 30, catches solver crashes and wrong-format answers, and reports through `utils/notify.js`.
- `workers/buy-4s.js`: one-shot that bought the 4S Market Data TIX API for `stock-trader.js --buy-4s`. Replaced by `workers/buy-market-access.js`, which buys the TIX API and (with `--4s`) 4S, each only above the cash reserve.

## Utils and tools

- `utils/dispatch-threads.js`, `utils/prep-target.js`, `utils/get-available-ram.js`: early helpers for spreading threads and prepping one target. Folded into `utils/workpool.js` and the batch managers.
- `utils/workpool.js`: worker pool used by hack-manager and the early batch managers. Replaced by `utils/ram-pool.js` when the batcher started placing ops itself.
- `utils/get-best-target-v1.js`: best target by money x money ratio / (hack time x security penalty), using current state. Next (v2): scores by max money x hack chance / weaken time, skipping servers above half your hacking level.
- `utils/get-best-target-v2.js`: see above. Next: `utils/targets-v1.js` (renamed) estimates every target at min security so prepped and unprepped servers compare fairly.
- `utils/get-top-targets.js`: get-best-target-v1's score returning the top N, for hack-manager-v2. Replaced by `utils/targets.js` ranking in the batcher.
- `utils/targets-v1.js`: see above. Next: `targets.js` drops `ns.getServer` (2GB) for cheap single getters.
- `utils/spending-v1.js`: one fixed reserve and max fraction per manager. Next: `spending.js` adds income stages that only tighten during a run.
- `tools/track-income-v1.js`: prints the change in home money every 10s. Next: `track-income.js` also shows hacking income from `getMoneySources`.
- `tools/list-backdoors-v1.js`: lists servers without a backdoor. Next: `list-backdoors.js` ranks them by what the backdoor actually unlocks (faction invites, company rep, class discounts) and hides useless ones unless `--all`.
- `tools/serverinfo.js`: printed one server's details. Uses functions that no longer exist; no replacement.
- `solve-contracts-v1.js`: found and solved contracts itself (about 22GB all the time). Next: `solve-contracts.js` only finds them every 15 minutes (3.5GB) and launches `workers/contract-solver.js` briefly to solve them.

## Servers and hacknet

- `purchase-servers-v1.js`: buys 8GB servers until the limit. Next (v2): keeps doubling RAM by deleting and re-buying servers.
- `purchase-servers-v2.js`: see above. Next: `pserv-manager-v1.js`.
- `pserv-manager-v1.js`: buys and upgrades servers to the biggest tier with a 2x cash buffer. Next (v2): upgrades in place, smallest first, one per pass, within the shared spending budget; never deletes.
- `pserv-manager-v2.js`: see above. Next: `pserv-manager.js` also buys new servers in free slots (after a reset) and uses income stages.
- `hacknet-manager-v1.js`: bought the best gain/cost upgrade, capped at 12 nodes. Next (v2): buys by shortest payback from real production, within a budget and max payback time.
- `hacknet-manager-v2.js`: see above. Next (v3): income stages for reserve and payback; exact new-node value with Formulas.exe.
- `hacknet-manager-v3.js`: see above. Next (v4): prices a new node as a package with the upgrades worth putting on it, so new nodes actually get bought.
- `hacknet-manager-v4.js`: see above. Next: `hacknet-manager.js` shortens payback limits for BN4 and stops once hacknet is under 1% of income.

## Stocks

- `stock-trader-v1.js`: long and short (`--short`) trader using 4S data or price-history estimates. Next (v2): `--promote N` runs promoteStock workers on the biggest longs.
- `stock-trader-v2.js`: see above. Next (v3): posts held companies on port 21 so batcher grows push longs up and hacks push shorts down.
- `stock-trader-v3.js`: see above, last version with `--short`. Next (v4): longs only (shorts need BN8/SF8.2 and cost 5GB), buys 4S through a one-shot helper, cheaper price reads.
- `stock-trader-v4.js`: see above. Next (v5): buys the TIX API itself through the helper when cash allows (`--no-buy-tix` to skip).
- `stock-trader-v5.js`: see above. Next: `stock-trader.js` runs promote workers on darkweb and stasis-linked darknet servers and posts a summary on port 26.

## Singularity

- `singularity/auto-study.js`: studied Algorithms until a hacking level, then stopped the class. Next: `singularity/study.js` takes the free course to 75 and leaves the class running.
- `singularity/buy-augs-v1.js`: bought every affordable augment, most expensive first, then NeuroFlux. Next (v2): `--plan` writes data/aug-plan.json for auto-reset.
- `singularity/buy-augs-v2.js`: see above. Next (v3): only buys useful augments (hacking, hacknet, darknet, rep), `--all` for everything.
- `singularity/buy-augs-v3.js`: see above. Next (v4): `--dry` shows the running cost of the whole set and whether to wait for locked augments.
- `singularity/buy-augs-v4.js`: see above. Next (v5): one shared reset rule (`decideReset`) for `--dry`, `--plan` and auto-reset, with rep-rate estimates.
- `singularity/buy-augs-v5.js`: see above. Next: `buy-augs.js` only waits for upcoming augments you could still afford, and caps waiting with timers kept in the plan file.
- `singularity/auto-reset-v1.js`: reset once 5 augments (or a key one) were affordable. Next: `auto-reset.js` uses the buy-augs reset rule, so `augs` and auto-reset always agree.
- `singularity/faction-work-v1.js`: worked factions in order to fixed rep goals. Next: `faction-work.js` takes goals from `workers/faction-goals.js` (highest rep still needed for useful augments) and adds joined city factions last.

## Darknet

- `darknet/dnet-manager-v1.js`: the tutorial self-spreading probe and authenticate loop. Next (v2): runs on home, seeds a crawler on darkweb and collects the map, passwords, earnings and stasis links, with `--once`, `--recon`, `--no-stasis`.
- `darknet/dnet-manager-v2.js`: see above. Next: `dnet-manager.js` reports through `utils/notify.js` and uses `ps` + kill by pid to save RAM.
- `darknet/factorios.js`: Factori-Os password solver for the crawler. Replaced by `darknet/feedback-solvers.js`, which logs in through `darknet/auth.js` and stops on timeouts or vanished servers instead of silently dropping a prime factor.

## Go

- `go/random-move.js`: tutorial random-move helper for ipvgo-bot-v1.
- `go/ipvgo-bot-v1.js`: tutorial bot, random moves, one game. Next (v2): loops games against Netburners on 5x5, playing the first valid move.
- `go/ipvgo-bot-v2.js`: see above. Next (v3): uses `choose-move.js`, rotates opponents by win rate, retries on ko.
- `go/ipvgo-debug.js`: one-off check that `resetBoardState` works.
- `go/ipvgo-bot-v3.js`: see above. Next (v4): rewritten with `--opponent`, `--size`, `--games` flags, resumes a game in progress, passes to take a won game.
- `go/ipvgo-bot-v4.js`: see above. Next (v5): rotates opponents when their bonus gain levels off (data/go-bonus.json, `--status`, `--no-rotate`).
- `go/ipvgo-bot-v5.js`: see above. Next: `ipvgo-bot.js` plays Illuminati on 5x5 (x8 multiplier) and passes `--think` to the Monte Carlo search.
- `go/choose-move-v1.js`: scored moves by position, skipped obvious suicides. Next (v2): group and liberty analysis, captures, saves and atari first.
- `go/choose-move-v2.js`: see above. Next (v3): plays each move out on a board copy with a 2-ply search and scores territory and safety; 0GB.
- `go/choose-move-v3.js`: see above. Next: `choose-move.js` is a Monte Carlo tree search (UCT with RAVE) with exact v3.0.0 scoring.
