# When to install augments

Used by [`singularity/buy-augs.js`](../singularity/buy-augs.js) (`decideReset`, shown by `augs`),
[`singularity/workers/aug-buyer.js`](../singularity/workers/aug-buyer.js),
[`singularity/auto-reset.js`](../singularity/auto-reset.js) and [`singularity/install-augs.js`](../singularity/install-augs.js).
Settings: `augments.resetRule` in [`config.js`](../config.js). Income forecast:
[`utils/income-curve.js`](../utils/income-curve.js) (`resetRule.incomeCurve`).

## The rule

Reset at the moment that gives the most augment value **per hour of the run**. Every check
(10 min) works out the value of the batch you could install now and at moments up to
`horizonHours` (6 h) ahead, divides each by (run age at that moment + `overheadMinutes`), and
resets when no later moment beats now by more than `waitMargin` (5%).

On top of that:

- The Red Pill ready: reset at once (`keyAugs`).
- No reset in the first `minRunMinutes` (30), and none before rep rates are measured.
- Daedalus rule (`daedalusFavor`), see below.

## Why

**Value is a sum of logs.** A run's speed (money, hack level, rep) scales with the product of
the multipliers, so an augment's value is the weighted sum of ln(multiplier) over the stats
that matter (`weights`; `augValue` in [`utils/aug-filter.js`](../utils/aug-filter.js)), and e^value is
roughly how much faster the next run goes. Long-run progress grows by the value gained per
hour of play, so that's what the rule maximises. This is the marginal value theorem from
foraging: leave the patch once the next bit of waiting earns slower than the average so far.

**Waiting pays less and less.** Every purchase makes the rest 1.9x dearer, so k augments cost
about p(1.9^k - 1)/0.9 and, with steady income, the batch grows only with the log of run
time. Rep unlocks are lumpy on top. So each run has a best moment, and it moves.

**Rebuild time is already counted.** Run age is measured from the last reset, so the slow
start of a run is inside it; `overheadMinutes` covers the fixed cost of a reset.

**What goes into a batch's value** (forecast for each moment from income and rep rates):

- augments affordable then, most expensive first as buy-augs buys them, including locked
  ones whose rep ETA has passed;
- NeuroFlux levels from the leftover cash (1.14x dearer in money and rep per level);
- favor: rep this run turns into favor on reset, +1% rep per point next run. Counted only for
  factions still needed (unbought wanted augments, or Daedalus before The Red Pill), weighted
  by how much rep each still needs, times `favorWeight` (0.5, since rep only limits part of a run).

**Cash follows an income curve.** Income keeps climbing during a run (more RAM, better targets,
higher hack level), so a flat forecast undervalues waiting and resets early. Each check stores an
income sample (run age, $/s, every `sampleMinutes`) in `data/aug-plan.json`, next to the last run's
samples. Growth is a log-linear fit of the last `fitHours` of this run, never more than the last run
grew from the same run age onwards, and taken from the last run alone until this run has
`minSamples` over `minSpanMinutes`. Forecast growth halves every `dampHours` and income tops out at
`maxMult` x today's, so one lucky spike can't hold off a reset for hours; falling income counts as
flat. `augs` prints the growth, where it came from and the forecast. The same model (passed through
player-work) sets the money budget in faction-goals, so the two agree on what's affordable.
Rejected: fitting a fixed shape (log or power curve) to the whole run, which the early-run jumps
(batcher start, pserv waves) throw off; and the last run's curve as-is, which ignores this run's new
augments.

Stock positions count as cash: auto-reset sells them (`stock-trader.js --liquidate`) before
buying, because the reset wipes held shares.

## Planning, buying, installing

**Plan and buy are two scripts, so a 32GB home can reset.** buy-augs.js plans (about 30GB) and
writes the buy list into `data/aug-plan.json`; workers/aug-buyer.js (about 9GB) buys from it.
`buy-augs` hands over with `ns.spawn` (2GB, but the planner's RAM is free before the buyer starts);
auto-reset runs the buyer itself after its check. The buyer reads live prices and simply tries each
purchase, so it needs neither the stats nor the rep calls. Rejected: one script (about 36GB, which no
32GB home can run) and a buyer that re-plans (needs the planner's RAM again). Moving the planner off
home was also rejected for now: it keeps its income history in a home file.
A local property named `share` in the planner cost 2.4GB (the RAM check matches it to `ns.share`);
it's `repShare` now. next-bitnode.js stays about 34GB (`destroyW0r1dD43m0n` alone is 32GB), so the
last step of a BitNode needs a 64GB home, which every run has long before The Red Pill.

**A plan belongs to one run.** Readers ignore a plan checked before the last install
(`checkedAt` < `lastAugReset`). install-augs uses a plan from the last 5 minutes as it is (the buyer
moves what it bought from `affordable` to `queued`), so `buy-augs` then `install-augs` doesn't need
room for the planner twice; an older plan is made again first.

**RESET is announced once.** The plan keeps `resetSince`, when the advice turned RESET this run
(null while it says wait). auto-reset announces only when that's new in the check it just ran, so
restarting it (`startup --restart`, `--dry` runs) doesn't repeat the toast.

**Leftover cash goes into home before an install.** Home RAM and cores survive an install and
cash doesn't, so install-augs runs both home buyers with `--spend-all` (no reserve, no stage cap)
after augments and NeuroFlux are bought (`--keep-cash` skips it). Home RAM first: it's usually the
bigger help to the next run's start.

## Daedalus

The Red Pill needs 2.5m Daedalus rep. With 150 favor (`getFavorToDonate`) a later run can buy
that rep at $1m per point (divided by the rep multiplier), but only after earning the invite
again (hack level and money). While Daedalus is joined and can't take donations yet:

1. Red Pill by work sooner than (time this run took to get the invite + donation money /
   income): keep working, no reset.
2. Otherwise, if favor after a reset now reaches 150: reset.
3. Otherwise, if it reaches 150 within the horizon: wait for it, then reset.
4. Otherwise the normal rule decides.

## Known limits

- The income curve needs a few samples (about 20 min) before it uses this run; until then it borrows
  the last run's growth, or stays flat on the first run. Income spent by other scripts (servers,
  hacknet, home upgrades) isn't subtracted, here or before.
- Rep rates are the current ones; when player-work moves to another faction the ETAs change.
- Weights are judgement calls for a hacking run; set `wantStats` and `weights` for other BitNodes.
- The favor formula is the game's (`favorToRep` = 25,000 x (1.02^favor - 1)); BitNode
  multipliers on donations aren't read (that needs Source-File 5).

Income curve added 2026-11 (before: income taken as flat). Replaced (2026-11) a count-based rule: 5 ready augments, wait up to 60 min for affordable
unlocks within 30 min, smaller resets after 3 h. It treated a +1% and a +30% augment the
same and ignored favor and NeuroFlux.
