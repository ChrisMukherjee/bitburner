# When to install augments

Used by [`singularity/buy-augs.js`](../singularity/buy-augs.js) (`decideReset`, shown by `augs`),
[`singularity/auto-reset.js`](../singularity/auto-reset.js) and [`singularity/install-augs.js`](../singularity/install-augs.js).
Settings: `augments.resetRule` in [`config.js`](../config.js).

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

Stock positions count as cash: auto-reset sells them (`stock-trader.js --liquidate`) before
buying, because the reset wipes held shares.

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

- Income is taken as flat, so later moments are slightly undervalued (leans towards resetting).
- Rep rates are the current ones; when player-work moves to another faction the ETAs change.
- Weights are judgement calls for a hacking run; set `wantStats` and `weights` for other BitNodes.
- The favor formula is the game's (`favorToRep` = 25,000 x (1.02^favor - 1)); BitNode
  multipliers on donations aren't read (that needs Source-File 5).

Replaced (2026-11) a count-based rule: 5 ready augments, wait up to 60 min for affordable
unlocks within 30 min, smaller resets after 3 h. It treated a +1% and a +30% augment the
same and ignored favor and NeuroFlux.
