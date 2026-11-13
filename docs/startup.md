# Startup

[`../startup.js`](../startup.js). Type `run /startup.js` once per BitNode (or let a reset or
[`../singularity/next-bitnode.js`](../singularity/next-bitnode.js) do it). It stays running after that.

## Decisions

- **One list in priority order.** Every script is one entry tagged with the stage it starts in. Earlier
  entries get RAM first. It skips anything already running, and running it again replaces the running copy.
- **Stays running (about 7GB) instead of launching once and exiting.** Every 10 seconds it re-reads the stage,
  starts what has become ready and restarts what stopped. Before, nothing restarted a crashed script until the
  next home upgrade, port opener or reset, and once those were maxed a crash late in a run stayed down. A script
  that stops soon after starting is retried after 30 seconds, doubling up to an hour, because many stop on purpose
  (nothing left to buy, no API, all done); one that stopped after 10 minutes or more gets a toast.
  A daemon with a `ready` check that says no is left alone instead: no retry timer, no toast. pserv-manager uses
  this: once every slot is filled and every server is at the RAM limit it posts `done` under `pserv` on port 33
  ([`../pserv/ready.js`](../pserv/ready.js)) and exits, so its 6GB is free and its "all at limit" toast no longer
  repeats. Like the one-shot notes, that is cleared when startup.js starts (a reset, a new BitNode or `--restart`),
  when the servers are gone and it has work again.
- **Singularity buyers, invites and backdoors are one-shots.** Upgrade-home-ram, upgrade-home-cores,
  buy-programs, join-factions and auto-backdoor used to loop on home, holding about 36GB in BitNode 4 (about
  390GB at SF4.1) to wake up every 10 to 60 seconds. Now they run `--once` for a moment. The buyers post the cash
  their next purchase needs on port 33 ([`../singularity/ready.js`](../singularity/ready.js)), and startup.js only
  runs one again once that cash is there, so it never pays 7GB to learn nothing is affordable. Invites run every
  minute, backdoors every 2 minutes until all are done. Only one one-shot runs at a time, and the one that waited
  longest goes first, so their RAM never stacks up and one that is always ready can't starve the rest. The notes
  are cleared when startup.js starts (after each reset), because programs are lost on an aug install.
  **A fresh run's queue is drained in seconds.** On a new run every one-shot is due at once and only one runs per
  pass, so with 10-second passes the last of them (the player's study/crime pass) used to start after 30 to 60 seconds,
  with the player idle meanwhile. Now `runPass` returns `queued` (a one-shot is in flight and others are due behind it)
  and the loop sleeps `queueMs` (1 second) instead of `passMs` until the queue is through; it goes back to 10 seconds
  when nothing is waiting, so a one-shot that cannot start for lack of room never makes it poll. Among one-shots that
  have never run, those tagged `first` (the player-work passes) go before the purchases and invites, so the player moves
  first. Rejected: starting several one-shots per pass (their RAM would stack, which is what the one-at-a-time rule
  prevents) and shortening `passMs` for everything (a ps over every server every second all run long).
  Tradeoff: a one-shot buyer reads the current income each time instead of only moving up during a run, so a dip in
  income can briefly change what it keeps back.
- **`data/startup-why.txt`** says what could not start and why (no room, missing file, room being kept free), rewritten
  only when it changes: `cat data/startup-why.txt`. 
- **`--restart`** stops every script it manages once, so code synced since they started takes effect. The batcher's
  workers already in flight keep running.
- **Stages come from home RAM** (`startupStages` in [`../config.js`](../config.js): start below 64GB, early,
  mid at 128GB, late at 256GB), read again every pass, so a home upgrade moves to the next stage by itself.
  Home RAM is what decides what fits; `run /startup.js mid` forces one.
- **The `start` stage is lean on purpose.** In a fresh BitNode only the buyers, the batcher, invites,
  backdoors and player work run, so the batcher gets the free servers' RAM. Hacknet, servers, Go and the
  rest wait until home has grown.
- **Runs off home when home is full.** Scripts that don't read or write files on their own server go to
  rooted servers (at most 65% of off-home RAM, the rest stays for the batcher). That is what makes it work
  from an 8GB home. `homeOnly` marks the ones that must stay.
  A script that needs `CONFIG.heavyShare` (20%) of home's RAM or more (the gang manager, Bladeburner passes,
  player-work) tries the other servers first and uses home only when none has room, so a capped home (the BN1
  challenge) keeps room for the `homeOnly` scripts (stock trader, auto-reset) and for the reset planner that
  auto-reset runs on home (31.6GB). Rejected: reserving that room on home instead; the batcher already keeps
  `homeReservedRam` free, and moving the big scripts frees more than a reservation holds.
- **Skips what can't run instead of failing.** Without the Singularity API every [`../singularity/`](../singularity/)
  script is left out with one summary line, checked through [`../utils/singularity.js`](../utils/singularity.js).
  Each mechanic's manager (gang, Bladeburner, sleeves, darknet, purchased servers) starts only once its folder's ready check says there is work, so startup.js knows nothing of the mechanic.
  What each script needs (SF4, SF2, Formulas ...) is the `Requires` column of its folder README; startup.js only
  repeats that in code through the ready checks. It also runs [`../tools/api-advice.js`](../tools/api-advice.js) every 10
  minutes, which says once per BitNode run what is missing and what to do about it ([`api-advice.md`](api-advice.md)).
- **`restartOnNewArgs`** swaps a running copy when the args change (for example the Go bot's opponent per
  stage), so two copies never fight over the same thing.

Rejected: stopping lower-priority scripts to make room for a waiting higher one, or holding home RAM for it.
Stages already keep back what doesn't fit, and it would need the batcher to read a hold value. Instead, when the
highest-priority script that may run off home finds no room, startup.js reserves room for it on one server
([`ram.md`](ram.md)), one reservation at a time.
- **player-work.js is a one-shot too**, a pass every minute that keeps its state on a port
  ([`player-work.md`](player-work.md)), so its 32.5GB is no longer held all run. It starts at the early stage;
  below that an 8.35GB stand-in (study, gang invite, port openers, then crime) moves the player, since 32.5GB fits nowhere on a
  32GB home and network.
- **Buying order of programs.** The port openers come first (they root more servers for the batcher at no RAM cost);
  DarkscapeNavigator.exe ($50m) normally follows SQLInject ($250m). Once home has `programs.darknetFirstHomeRam` GB
  (default: `startupStages.mid`, where the darknet manager starts), `programOrder` in
  [`../singularity/buy-programs.js`](../singularity/buy-programs.js) buys it before SQLInject, so the darknet's income
  doesn't wait behind a $250m purchase. On a smaller home the darknet's RAM (manager and crawlers) would cost the
  batcher more than it earns. Rejected: buying it in Chongqing for $30m, since only a button in the game's UI sells
  it at that price and no Netscript function reaches it.

## Structure across BitNodes

The rules are in [`../AGENTS.md`](../AGENTS.md): one folder per mechanic with a manager that exits cleanly
when its API isn't available, capability checks rather than BitNode-number checks, per-BitNode tuning only
in the config, and a core that knows no mechanic's details. A new mechanic adds a folder and one line here.
