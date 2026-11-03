# archive/

Old and replaced scripts, kept on purpose (they count toward the file-count achievement).
Nothing here is run by [`startup.js`](../startup.js). Filesync skips this folder, so these files only exist
in the game if they were copied there before.

Each line says what the file did and what its successor changed. "Next" is the next
-vX file, or the current script when it is the last archived version. When a working
script is replaced, it is saved here as name-vX.js and gets a line in this list.

## Hacking: from first scripts to the batcher

- [`hack/n00dles.js`](hack/n00dles.js): endless `hack("n00dles")` loop, the very first script. Next: [`hack/early-hack.js`](hack/early-hack.js) adds weaken/grow thresholds and a target argument.
- [`hack/early-hack.js`](hack/early-hack.js): the tutorial weaken/grow/hack loop against one target. Next: [`hack/deployer-v1.js`](hack/deployer-v1.js) copies it to servers and runs it there.
- [`pserv/purchase-server-8gb.js`](pserv/purchase-server-8gb.js): the tutorial script that buys 8GB cloud servers and runs the early-hack template on them. Next: [`pserv/purchase-servers-v1.js`](pserv/purchase-servers-v1.js).
- [`hack/deployer-v1.js`](hack/deployer-v1.js): roots the servers next to home and runs the early-hack template on n00dles with all their RAM. Next (v2): scans the whole network, uses [`utils/attempt-nuke.js`](utils/attempt-nuke.js), picks the best target.
- [`hack/deployer-v2.js`](hack/deployer-v2.js): as v1 over the whole network with the best target. Next (v3): uses separate hack/grow/weaken workers instead of one loop, and loops forever.
- [`hack/deployer-v3.js`](hack/deployer-v3.js): picks one action (weaken, grow or hack) for the best target and fills every rooted server with it. Next: [`hack/hack-manager-v1.js`](hack/hack-manager-v1.js) adds an "xp" mode and the shared worker pool.
- [`hack/hack-manager-v1.js`](hack/hack-manager-v1.js): deployer-v3 plus an "xp" mode (grow/weaken joesguns for exp) and [`utils/workpool.js`](utils/workpool.js). Next (v2): moves to the utils/ and workers/ folders and splits the pool across the top 3 targets.
- [`hack/hack-manager-v2.js`](hack/hack-manager-v2.js): one action per target, pool split across the top 3 targets. Next: [`hack/batch-manager.js`](hack/batch-manager.js) switches to HWGW batches.
- [`hack/batch-manager.js`](hack/batch-manager.js): first HWGW batcher. Preps one target, then sends 10% hack batches timed to land in order, waiting until the whole batch fits in free RAM. Next: [`hack/jit-batch-manager-v1.js`](hack/jit-batch-manager-v1.js) drops the RAM wait so a batch starts every second (pipelining).
- [`hack/jit-batch-manager-v1.js`](hack/jit-batch-manager-v1.js): pipelined HWGW against one target, one batch per second. Next (v2): rewritten around a CONFIG, all-or-nothing RAM placement split across servers, target switching with hysteresis, prep waves, many batches per tick.
- [`hack/jit-batch-manager-v2.js`](hack/jit-batch-manager-v2.js): see above. Next (v3): ops use live durations and pass their delay as `additionalMsec`; a launch horizon stops RAM being hoarded by far-future batches.
- [`hack/jit-batch-manager-v3.js`](hack/jit-batch-manager-v3.js): see above. Next (v4): workers get an absolute landing time and measure their own duration when they start, with a safety factor for higher security.
- [`hack/jit-batch-manager-v4.js`](hack/jit-batch-manager-v4.js): single-target JIT batcher. Next (v5): multi-target, ranked by [`utils/targets.js`](../utils/targets.js) and fed from one shared RAM pool, best target first.
- [`hack/jit-batch-manager-v5.js`](hack/jit-batch-manager-v5.js): multi-target batcher. Next (v6): uses Formulas.exe when owned (exact batch sizes, rank by money per GB per second, one combined prep wave) and reports income from port 22.
- [`hack/jit-batch-manager-v6.js`](hack/jit-batch-manager-v6.js): see above. Next: [`hack/batcher-v7.js`](hack/batcher-v7.js) (renamed) execs each worker just before it starts, so batches only hold RAM while running (about 2.4x more batches), and rate-limits targets by a RAM budget.
- [`hack/batcher-v7.js`](hack/batcher-v7.js): see above. Next: [`hack/batcher-v8.js`](hack/batcher-v8.js) sizes hack fraction per target with Formulas (up to 50%), measures targets with [`hack/workers/target-stats.js`](../hack/workers/target-stats.js) without Formulas, and drops the analyze calls (about 6GB less RAM).
- [`hack/batcher-v8.js`](hack/batcher-v8.js): see above. Next: [`batcher.js`](../hack/batcher.js) allows hack fractions up to 80% with or without Formulas.exe, lands batches 40ms apart (one per 160ms instead of 400ms), runs grow and weaken on home with fewer threads for its cores, trims grow and launch margins, and claims its planned RAM from share-manager on port 31.
- [`utils/attempt-nuke.js`](utils/attempt-nuke.js): opens ports and nukes one server. Replaced by [`utils/nuke-all.js`](../utils/nuke-all.js), which roots everything in one call.
- [`startup.js`](startup.js): BN1 startup that launched hacknet-manager, pserv-manager and hack-manager. Next: [`startup-v2.js`](startup-v2.js).
- [`startup-v2.js`](startup-v2.js): stage-tagged script list (early/mid/late by home RAM), home only. Next: [`startup-v3.js`](startup-v3.js) also runs scripts on rooted servers when home is too small, uses absolute paths, adds city factions, and prints the status screen when typed by hand.
- [`startup-v3.js`](startup-v3.js): see above; launched everything once and exited. Next: [`startup.js`](../startup.js) stays running, restarts scripts that stop, moves to the next stage by itself, and runs the home/program buyers, invites and backdoors as short one-shots gated on cash (about 29GB less home RAM held).

## Workers

- [`hack/workers/hack-v1.js`](hack/workers/hack-v1.js), [`grow-v1.js`](hack/workers/grow-v1.js), [`weaken-v1.js`](hack/workers/weaken-v1.js): one call on `args[0]`. Next (v2): optional sleep delay in `args[1]`.
- [`hack/workers/hack-v2.js`](hack/workers/hack-v2.js), [`grow-v2.js`](hack/workers/grow-v2.js), [`weaken-v2.js`](hack/workers/weaken-v2.js): sleep, then act. Next (v3): the delay goes to the game as `additionalMsec`.
- [`hack/workers/hack-v3.js`](hack/workers/hack-v3.js), [`grow-v3.js`](hack/workers/grow-v3.js), [`weaken-v3.js`](hack/workers/weaken-v3.js): `additionalMsec` delay. Next (v4 for hack/grow, current [`weaken.js`](../hack/workers/weaken.js)): `args[1]` is an absolute landing time and the worker measures its own duration.
- [`hack/workers/hack-v4.js`](hack/workers/hack-v4.js), [`grow-v4.js`](hack/workers/grow-v4.js): absolute landing time. Next: [`hack.js`](../hack/workers/hack.js) adds the hacked total on port 22 and both pass `stock: true` for servers the stock trader posts on port 21.
- [`contracts/workers/contract-solver-v1.js`](contracts/workers/contract-solver-v1.js): solved 9 contract types. Next (v2): solves 30, catches solver crashes and wrong-format answers, and reports through [`utils/notify.js`](../utils/notify.js).
- [`contracts/workers/contract-solver-v2.js`](contracts/workers/contract-solver-v2.js): solved all 30 types and wrote wrong answers to a file on home. Next: [`contract-solver.js`](../contracts/workers/contract-solver.js) can run on any server (wrong answers go to port 32), skips contracts it can't read instead of stopping, warns once for a bad answer format, and says how to solve a contract by hand.
- [`stocks/workers/buy-4s.js`](stocks/workers/buy-4s.js): one-shot that bought the 4S Market Data TIX API for [`stock-trader.js --buy-4s`](../stocks/stock-trader.js). Replaced by [`stocks/workers/buy-market-access.js`](../stocks/workers/buy-market-access.js), which buys the TIX API and (with `--4s`) 4S, each only above the cash reserve.

## Utils and tools

- [`utils/dispatch-threads.js`](utils/dispatch-threads.js), [`utils/prep-target.js`](utils/prep-target.js), [`utils/get-available-ram.js`](utils/get-available-ram.js): early helpers for spreading threads and prepping one target. Folded into [`utils/workpool.js`](utils/workpool.js) and the batch managers.
- [`utils/workpool.js`](utils/workpool.js): worker pool used by hack-manager and the early batch managers. Replaced by [`utils/ram-pool.js`](../utils/ram-pool.js) when the batcher started placing ops itself.
- [`utils/get-best-target-v1.js`](utils/get-best-target-v1.js): best target by money x money ratio / (hack time x security penalty), using current state. Next (v2): scores by max money x hack chance / weaken time, skipping servers above half your hacking level.
- [`utils/get-best-target-v2.js`](utils/get-best-target-v2.js): see above. Next: [`utils/targets-v1.js`](utils/targets-v1.js) (renamed) estimates every target at min security so prepped and unprepped servers compare fairly.
- [`utils/get-top-targets.js`](utils/get-top-targets.js): get-best-target-v1's score returning the top N, for hack-manager-v2. Replaced by [`utils/targets.js`](../utils/targets.js) ranking in the batcher.
- [`utils/targets-v1.js`](utils/targets-v1.js): see above. Next: [`targets.js`](../utils/targets.js) drops `ns.getServer` (2GB) for cheap single getters.
- [`utils/spending-v1.js`](utils/spending-v1.js): one fixed reserve and max fraction per manager. Next: [`spending.js`](../utils/spending.js) adds income stages that only tighten during a run.
- [`tools/track-income-v1.js`](tools/track-income-v1.js): prints the change in home money every 10s. Next: [`track-income.js`](../tools/track-income.js) also shows hacking income from `getMoneySources`.
- [`tools/list-backdoors-v1.js`](tools/list-backdoors-v1.js): lists servers without a backdoor. Next: [`list-backdoors.js`](../tools/list-backdoors.js) ranks them by what the backdoor actually unlocks (faction invites, company rep, class discounts) and hides useless ones unless `--all`.
- [`tools/status-v1.js`](tools/status-v1.js): one-screen run summary (stage, cash/income, work, faction goals with ETAs, reset advice, Go, city plan, stocks, scripts running). Next: [`status.js`](../tools/status.js) adds a BitNode section (Daedalus invite needs and rep against The Red Pill, `w0r1d_d43m0n` hacking level and root, next BitNode on the route).
- [`tools/serverinfo.js`](tools/serverinfo.js): printed one server's details. Uses functions that no longer exist; no replacement.
- [`contracts/solve-contracts-v1.js`](contracts/solve-contracts-v1.js): found and solved contracts itself (about 22GB all the time). Next (v2): only finds them every 15 minutes (3.5GB) and launches the solver briefly to solve them.
- [`contracts/solve-contracts-v2.js`](contracts/solve-contracts-v2.js): scanned only the normal network and ran the solver on home only. Next: [`solve-contracts.js`](../contracts/solve-contracts.js) also scans darknet servers from the darknet map, runs the solver on another server when home is short, and prunes the failed list.

## Servers and hacknet

- [`pserv/purchase-servers-v1.js`](pserv/purchase-servers-v1.js): buys 8GB servers until the limit. Next (v2): keeps doubling RAM by deleting and re-buying servers.
- [`pserv/purchase-servers-v2.js`](pserv/purchase-servers-v2.js): see above. Next: [`pserv/pserv-manager-v1.js`](pserv/pserv-manager-v1.js).
- [`pserv/pserv-manager-v1.js`](pserv/pserv-manager-v1.js): buys and upgrades servers to the biggest tier with a 2x cash buffer. Next (v2): upgrades in place, smallest first, one per pass, within the shared spending budget; never deletes.
- [`pserv/pserv-manager-v2.js`](pserv/pserv-manager-v2.js): see above. Next: [`pserv-manager.js`](../pserv/pserv-manager.js) also buys new servers in free slots (after a reset) and uses income stages.
- [`hacknet/hacknet-manager-v1.js`](hacknet/hacknet-manager-v1.js): bought the best gain/cost upgrade, capped at 12 nodes. Next (v2): buys by shortest payback from real production, within a budget and max payback time.
- [`hacknet/hacknet-manager-v2.js`](hacknet/hacknet-manager-v2.js): see above. Next (v3): income stages for reserve and payback; exact new-node value with Formulas.exe.
- [`hacknet/hacknet-manager-v3.js`](hacknet/hacknet-manager-v3.js): see above. Next (v4): prices a new node as a package with the upgrades worth putting on it, so new nodes actually get bought.
- [`hacknet/hacknet-manager-v4.js`](hacknet/hacknet-manager-v4.js): see above. Next: [`hacknet-manager.js`](../hacknet/hacknet-manager.js) uses shorter payback limits (suited to short runs between aug installs; the stages are now `hacknetBuying` in [`config.js`](../config.js)) and stops once hacknet is under 1% of income.

## Stocks

- [`stocks/stock-trader-v1.js`](stocks/stock-trader-v1.js): long and short (`--short`) trader using 4S data or price-history estimates. Next (v2): `--promote N` runs promoteStock workers on the biggest longs.
- [`stocks/stock-trader-v2.js`](stocks/stock-trader-v2.js): see above. Next (v3): posts held companies on port 21 so batcher grows push longs up and hacks push shorts down.
- [`stocks/stock-trader-v3.js`](stocks/stock-trader-v3.js): see above, last version with `--short`. Next (v4): longs only (shorts need BN8/SF8.2 and cost 5GB), buys 4S through a one-shot helper, cheaper price reads.
- [`stocks/stock-trader-v4.js`](stocks/stock-trader-v4.js): see above. Next (v5): buys the TIX API itself through the helper when cash allows (`--no-buy-tix` to skip).
- [`stocks/stock-trader-v5.js`](stocks/stock-trader-v5.js): see above. Next: [`stock-trader.js`](../stocks/stock-trader.js) runs promote workers on darkweb and stasis-linked darknet servers and posts a summary on port 26.

## Singularity

- [`singularity/auto-study.js`](singularity/auto-study.js): studied Algorithms until a hacking level, then stopped the class. Next: [`singularity/study.js`](singularity/study.js) takes the free course to 75 and leaves the class running.
- [`singularity/buy-augs-v1.js`](singularity/buy-augs-v1.js): bought every affordable augment, most expensive first, then NeuroFlux. Next (v2): `--plan` writes data/aug-plan.json for auto-reset.
- [`singularity/buy-augs-v2.js`](singularity/buy-augs-v2.js): see above. Next (v3): only buys useful augments (hacking, hacknet, darknet, rep), `--all` for everything.
- [`singularity/buy-augs-v3.js`](singularity/buy-augs-v3.js): see above. Next (v4): `--dry` shows the running cost of the whole set and whether to wait for locked augments.
- [`singularity/buy-augs-v4.js`](singularity/buy-augs-v4.js): see above. Next (v5): one shared reset rule (`decideReset`) for `--dry`, `--plan` and auto-reset, with rep-rate estimates.
- [`singularity/buy-augs-v5.js`](singularity/buy-augs-v5.js): see above. Next (v6): only waits for upcoming augments you could still afford, and caps waiting with timers kept in the plan file.
- [`singularity/buy-augs-v6.js`](singularity/buy-augs-v6.js): reset rule by augment count (5 ready, wait up to 60 min for affordable unlocks within 30 min, smaller resets after 3h). Next: [`buy-augs.js`](../singularity/buy-augs.js) resets at the moment with the most augment value per hour of run (weighted log multipliers, NeuroFlux, favor), plus a Daedalus favor rule ([`docs/aug-reset.md`](../docs/aug-reset.md)).
- [`singularity/buy-augs-v7.js`](singularity/buy-augs-v7.js): see above (value per hour of run), with income taken as flat. Next: [`buy-augs.js`](../singularity/buy-augs.js) forecasts cash along an income curve fitted to this run's income history, capped by the last run ([`utils/income-curve.js`](../utils/income-curve.js)).
- [`singularity/buy-augs-v8.js`](singularity/buy-augs-v8.js): see above (income curve), planned and bought in one script (about 36GB). Next: [`buy-augs.js`](../singularity/buy-augs.js) only plans (30.4GB) and hands the buying to [`singularity/workers/aug-buyer.js`](../singularity/workers/aug-buyer.js) (9.2GB), so a 32GB home can reset; the plan also remembers when RESET advice started, so it is announced once.
- [`singularity/auto-reset-v1.js`](singularity/auto-reset-v1.js): reset once 5 augments (or a key one) were affordable. Next: [`auto-reset.js`](../singularity/auto-reset.js) uses the buy-augs reset rule, so `augs` and auto-reset always agree.
- [`singularity/faction-work-v1.js`](singularity/faction-work-v1.js): worked factions in order to fixed rep goals. Next (v2): takes goals from [`workers/faction-goals.js`](../singularity/workers/faction-goals.js) (highest rep still needed for useful augments) and adds joined city factions last.
- [`singularity/faction-work-v2.js`](singularity/faction-work-v2.js): see above. Next: [`player-work.js`](../singularity/player-work.js) does faction work the same way, as one of the parts of the single player-work script.
- [`singularity/workers/faction-goals-v1.js`](singularity/workers/faction-goals-v1.js): rep goal per faction = highest rep of any wanted augment there, whatever its price. Next: [`faction-goals.js`](../singularity/workers/faction-goals.js) only counts augments the run can afford (with the 1.9x markup) and reach in rep time within the reset rule's horizon.
- [`singularity/player-work-v1.js`](singularity/player-work-v1.js): moved the player (study, gang-invite crimes, faction and company work, Tian Di Hui, city factions) in a loop that held 29.4GB all run. Next: [`player-work.js`](../singularity/player-work.js) runs as a short `--once` pass every minute from startup.js, keeping its state on port 35.
- [`singularity/study.js`](singularity/study.js): free CS course until hacking 75, then left the class running. Merged into [`player-work.js`](../singularity/player-work.js), which starts the class once and then leaves it alone.
- [`singularity/company-work.js`](singularity/company-work.js): megacorp Software jobs until their faction invites, waiting while faction work ran. Merged into [`player-work.js`](../singularity/player-work.js), which takes the jobs only when no faction needs rep.
- [`singularity/get-tian-di-hui.js`](singularity/get-tian-di-hui.js): flew to Chongqing at hacking 50 and $1.2m and waited for the Tian Di Hui invite (join-factions accepted it). Merged into [`player-work.js`](../singularity/player-work.js), which also joins on the invite itself.
- [`singularity/city-factions.js`](singularity/city-factions.js): flew to and joined the one city-faction group whose augments were still wanted, waiting for get-tian-di-hui first. Merged into [`player-work.js`](../singularity/player-work.js) (same plan from [`workers/city-plan.js`](../singularity/workers/city-plan.js); `--dry` became `--plan`), so study, travel and work no longer fight over the player.

## Darknet

- [`darknet/dnet-manager-v1.js`](darknet/dnet-manager-v1.js): the tutorial self-spreading probe and authenticate loop. Next (v2): runs on home, seeds a crawler on darkweb and collects the map, passwords, earnings and stasis links, with `--once`, `--recon`, `--no-stasis`.
- [`darknet/dnet-manager-v2.js`](darknet/dnet-manager-v2.js): see above. Next: [`dnet-manager.js`](../darknet/dnet-manager.js) reports through [`utils/notify.js`](../utils/notify.js) and uses `ps` + kill by pid to save RAM.
- [`darknet/factorios.js`](darknet/factorios.js): Factori-Os password solver for the crawler. Replaced by [`darknet/feedback-solvers.js`](../darknet/feedback-solvers.js), which logs in through [`darknet/auth.js`](../darknet/auth.js) and stops on timeouts or vanished servers instead of silently dropping a prime factor.

## Go

- [`go/random-move.js`](go/random-move.js): tutorial random-move helper for ipvgo-bot-v1.
- [`go/ipvgo-bot-v1.js`](go/ipvgo-bot-v1.js): tutorial bot, random moves, one game. Next (v2): loops games against Netburners on 5x5, playing the first valid move.
- [`go/ipvgo-bot-v2.js`](go/ipvgo-bot-v2.js): see above. Next (v3): uses [`choose-move.js`](../go/choose-move.js), rotates opponents by win rate, retries on ko.
- [`go/ipvgo-debug.js`](go/ipvgo-debug.js): one-off check that `resetBoardState` works.
- [`go/ipvgo-bot-v3.js`](go/ipvgo-bot-v3.js): see above. Next (v4): rewritten with `--opponent`, `--size`, `--games` flags, resumes a game in progress, passes to take a won game.
- [`go/ipvgo-bot-v4.js`](go/ipvgo-bot-v4.js): see above. Next (v5): rotates opponents when their bonus gain levels off (data/go-bonus.json, `--status`, `--no-rotate`).
- [`go/ipvgo-bot-v5.js`](go/ipvgo-bot-v5.js): see above. Next: [`ipvgo-bot.js`](../go/ipvgo-bot.js) plays Illuminati on 5x5 (x8 multiplier) and passes `--think` to the Monte Carlo search.
- [`go/choose-move-v1.js`](go/choose-move-v1.js): scored moves by position, skipped obvious suicides. Next (v2): group and liberty analysis, captures, saves and atari first.
- [`go/choose-move-v2.js`](go/choose-move-v2.js): see above. Next (v3): plays each move out on a board copy with a 2-ply search and scores territory and safety; 0GB.
- [`go/choose-move-v3.js`](go/choose-move-v3.js): see above. Next: [`choose-move.js`](../go/choose-move.js) is a Monte Carlo tree search (UCT with RAVE) with exact v3.0.0 scoring.
