# Batcher

[`../hack/batcher.js`](../hack/batcher.js) with workers [`../hack/workers/hack.js`](../hack/workers/hack.js),
[`grow.js`](../hack/workers/grow.js), [`weaken.js`](../hack/workers/weaken.js) and, without Formulas.exe,
[`target-stats.js`](../hack/workers/target-stats.js).

## Decisions

- **Just-in-time launching.** Each batch's four ops (weaken, weaken, grow, hack) are exec'd just before
  they must start (`launchLeadMs`, 300ms), not all at once with delays. A sleeping hack or grow used to hold its
  RAM for most of a weaken time; launching late fits about 2.4x as many batches in the same RAM.
  The cost: an op can find no RAM when its turn comes. Then the rest of that batch is dropped, and since
  ops launch in start order a hack never lands without its weaken and grow.
- **Absolute land times.** Workers get the time they must finish as an absolute timestamp (`args[1]`),
  not a relative delay, so a late tick can't silently shift a landing. Don't go back to relative delays.
- **Many targets, one RAM pool.** Targets are ranked and each gets a share of `ramBudget` x network RAM
  in rank order; its batch spacing stretches until its batches fit that share. The best target always has
  first claim on freed RAM. A target that drops out just stops launching; nothing is killed.
- **Batches are rate-limited, not RAM-reserved.** Since RAM isn't claimed up front any more, spacing is
  what keeps total use in budget.
- **Ranking.** Money per unit of time at min security (with Formulas.exe: money per GB-second of real
  batch RAM), so prepped and unprepped servers compare fairly. Active targets get a `stickiness` bonus so
  the set doesn't churn. The score is scaled by `0.5 + 0.5 x money share`, so after a restart nearly
  full servers win over empty ones.
- **Batch from 50% money.** Batching starts once a target is at min security and half its max money,
  with each batch growing a bit extra (`catchUpPerBatch`) until money is back at max. Waiting for full prep
  made a fresh BitNode earn nothing for 15+ minutes.
- **Formulas.exe is optional.** Checked every tick, so buying it mid-run just switches over. With it,
  sizes and timings are exact even before prep. Without it, a one-shot helper measures targets every 30s and
  posts them on port 27; its grow rate rescales exactly to min security, so the same hack fractions are safe
  (grow keeps a 5% margin instead of 1%).
- **Hack fraction per target, up to 80%.** With little RAM, small batches earn the most per GB (fewer grow
  threads per dollar). With plenty, a top target steals up to 80% per batch instead of handing RAM to worse
  targets. It used to stop at 50% with Formulas.exe and 10% without, which left RAM idle.
- **Tight spacing.** Landings inside a batch are 40ms apart, so a target can take one batch every 160ms (it
  was 100ms and 400ms). That ceiling is what limits income when RAM is plentiful. Going tighter risks ops
  landing out of order when the game lags; the log's "dropped" and "worst" numbers show if it does.
  Long launch queues made this slow, so the queue is handled in one pass per tick and every server's
  process list is only re-read once a second (launches in between are counted as they happen).
- **Home cores.** Grow and weaken go on home first when the whole op fits there, with threads divided by
  1 + (cores - 1) / 16. Hack gets nothing from cores, so it goes elsewhere. The core count comes from the
  port 27 helper (`getServer` is 2GB), which therefore runs with Formulas.exe too.
- **Claiming RAM from share.** Ops are exec'd just before they start, so RAM the batcher has planned for
  looks free in between, and [`../share/share-manager.js`](../share/share-manager.js) used to fill it. Then
  batches were dropped and a target could fall into prep with no income. The batcher now posts the free RAM
  its planned batches still need on port 31, and share leaves at least that free.
- **No analyze functions in the batcher.** They cost 1GB each; hack/grow security use the game's
  per-thread constants and weaken per thread comes from formulas or the helper. See [`ram.md`](ram.md).
- **Home reserve** is the smaller of 64GB and a quarter of home, so a fresh 8GB home still helps while a
  big home keeps room for typed commands.

## Things that look wrong but aren't

- Lots of free RAM on a big network is normal: batching is limited by targets (`maxTargets` 25,
  hack fraction), not RAM.
- The batcher posts its 60-second income average on port 24 because `ns.getTotalScriptIncome` reads about
  $0 (hack workers exit on payout). Read income with [`../utils/income.js`](../utils/income.js).
- Edits to the workers only take effect after the batcher restarts.
