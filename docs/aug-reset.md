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
resets when no later moment within `maxWaitMinutes` (180) beats now by more than `waitMargin` (5%).

On top of that:

- The Red Pill ready: reset at once (`keyAugs`).
- No reset in the first `minRunMinutes` (30), and none before rep rates are measured.
- Daedalus rule (`daedalusFavor`), see below.
- Guarantee (off by default, `maxRunHours: null`): a run at least `maxRunHours` old resets once the
  batch is worth at least x`guaranteeSpeed`, whatever the forecast says.

The window and the guarantee came from an earlier version of this rule: with a growing income
the forecast can keep promising a slightly better moment a little further on, so the reset recedes for
hours. They started as a 60 min window and a 4 h guarantee. An offline simulation of BitNode 4 (below)
showed both cut runs short and cost 5-25% of the time to The Red Pill, with no receding resets once the
forecast bug below was fixed, so the window is now 180 min and the guarantee is off.

## Checked offline (2026-11)

A Node simulation of BitNode 4 ran the planner's own `decideReset` against the game's v3.0.0 data
(augment prices, rep, stats and factions; servers; BitNode 4 multipliers) and formulas (hack time,
percent, chance and exp, grow, skill level, faction rep, favor, donations), with a simple model of the
batcher, server and home buying and player work. It found:

- **A forecast bug made most resets too early.** The forecast left NeuroFlux out of any moment whose
  leftover cash passed the next home upgrade's price (the buyer's "NeuroFlux waits for home" rule).
  Resetting now counted NeuroFlux and later moments, with more cash, didn't, so waiting looked worse: the rule
  reset every 1-2 hours, mostly for a level or two of NeuroFlux. Now the forecast counts NeuroFlux at
  every moment (the buyer still gives a home upgrade the cash first at reset time).
- Fixing it took The Red Pill from about 83 h to 54 h in the base case, and 44 resets to 14 before it
  (median run 1.5 h to 2.7 h). Widening the window and dropping the guarantee took it to about 48 h.
  The gain held with income at 0.1x to 3x the base, with or without megacorp factions.
- Not worth changing: overhead, wait margin, horizon, income-curve settings, favor weight, picking the
  batch by value per dollar instead of most expensive first, and the after-Red-Pill rebuild factor.
- Small resets are fine when the batch is worth its run: the rule still resets with 1-2 augments when
  a run is short and they are strong. What cost time was resetting for NeuroFlux alone, over and over.

The model's income and rep numbers are rough, so the hours are only good for comparing rules.

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

## Income mix (which augments count)

**The decision:** money stats count by where this run's money actually comes from. Each stat listed in
`augments.incomeMix.stats` belongs to one money source (`hacking_money` and `hacking_grow` to hacking, the hacknet
stats to hacknet, `dnet_money` to darknet, `crime_money` to crime, `work_money` to work). Its weight is the value when that source earns
everything, multiplied by the source's portion of the money earned. Below `minPortion` (5%) the stat stops making
an augment worth buying at all. So hacknet augments count once hacknet pays a real part of the bills, and
hacking-money augments count for less while a gang earns most of the money.

**Why:** a +10% money multiplier on a source that earns 20% of the money is +2% income, not +10%. The old fixed
weights assumed a hacking run (hacknet at 0.2 whatever it earned), which is wrong in a hacknet-heavy BitNode and
in BitNode 2 once the gang pays. The rest (hacking level, exp, speed, faction and company rep, combat for
Bladeburner) keeps its full weight: those speed up progress whatever pays for it (hack level for Daedalus and
w0r1d_d43m0n, rep for every augment).

**Gangs raise no player augment stat.** Gang members have their own stats and multipliers; checked in the v3.0.0 source,
gang money and respect never read the player's multipliers. The one exception is faction rep: the gang faction's rep
from respect is multiplied by the player's `faction_rep`, already a full-weight stat. So strength or defense augments
do nothing for a gang, and a big gang income only lowers the money stats' share. Combat augments count when
Bladeburner is the route (`routeAdjust` in [`utils/config.js`](../utils/config.js)), not because of a gang.

**How:** [`singularity/buy-augs.js`](../singularity/buy-augs.js) reads `getMoneySources()` (1GB) at the start of every
check and posts the positive amounts on port 38 ([`utils/income-mix.js`](../utils/income-mix.js)). `loadConfig` reads
the port (0GB) and sets `augments.incomeFactors`, so faction-goals, city-plan and aug-dataset use the same weights
without paying the 1GB. Portions come from this run once it has earned `minEarned` ($100m), from the whole BitNode
before that, and default to a hacking run (`unknownPortions`) when nothing fresh is posted. `augs` prints the mix.
Stocks, the gang, contracts and the rest count in the total but raise no stat.

**Rejected:** a share of income per second (the last few minutes) instead of the run's total: it swings with the
batcher's prep and stock sales, and the run's total is what the augments would have multiplied. A BitNode table of
weights (`bitnodes` in the config): the measured mix already follows the BitNode, and also a player's own choices
within one. Separate per-source presets: same reason.

**Extending it:** a new money source or stat is one line in `incomeMix.stats` (and the stat's weight in `resetRule.weights`).
For example, if a BitNode makes charisma pay through a source, list `charisma` under that source and add `"charisma"`
to `wantStats`.

## Planning, buying, installing

**Plan and buy are two scripts, so a 32GB home can reset.** buy-augs.js plans (about 30GB) and
writes the buy list into `data/aug-plan.json`; workers/aug-buyer.js (about 9GB) buys from it.
`buy-augs` hands over with `ns.spawn` (2GB, but the planner's RAM is free before the buyer starts);
auto-reset runs the buyer itself after its check. The buyer reads live prices and simply tries each
purchase, so it needs neither the stats nor the rep calls. Rejected: one script (about 36GB, which no
32GB home can run) and a buyer that re-plans (needs the planner's RAM again). Moving the planner off
home was also rejected for now: it keeps its income history in a home file.
A local property named `share` in the planner cost 2.4GB (the RAM check matches it to `ns.share`);
it's `repShare` now. The destroy call (`destroyW0r1dD43m0n`, 32GB alone) lives in singularity/workers/destroy-daemon.js (33.6GB); next-bitnode.js only checks (4.8GB). So the
last step of a BitNode needs a 64GB home, which every run has long before The Red Pill.

**A plan belongs to one run.** Readers ignore a plan checked before the last install
(`checkedAt` < `lastAugReset`). install-augs uses a plan from the last 5 minutes as it is (the buyer
moves what it bought from `affordable` to `queued`), so `buy-augs` then `install-augs` doesn't need
room for the planner twice; an older plan is made again first.

**RESET is announced once.** The plan keeps `resetSince`, when the advice turned RESET this run
(null while it says wait). auto-reset announces only when that's new in the check it just ran, so
restarting it (`startup --restart`, `--dry` runs) doesn't repeat the toast.

**Leftover cash goes into home before an install.** Home RAM and cores survive an install and
cash doesn't, so install-augs runs both home buyers with `--spend-all` (no reserve, no cap)
after augments are bought (`--keep-cash` skips it). Home RAM first: it's usually the
bigger help to the next run's start.

**No install without a purchase.** auto-reset stops everything on home, sells stocks and runs the buyer,
which records what that pass bought in the plan (`lastBuy`). It installs only when something was bought, or
when every augment the advice counted was already queued. Otherwise it starts startup.js again (home is empty
by then), says why on the terminal, and ignores RESET advice for 30 minutes so it doesn't stop everything on
every check. install-augs also starts its after-reset script itself when the game refuses an install because
nothing is queued, so home is never left with nothing running.

**NeuroFlux comes from a faction that sells it.** The planner counts NeuroFlux levels at the joined faction
with the most rep among those that list it. A gang's faction sells no special augments (NeuroFlux is one), and
Bladeburners, Shadows of Anarchy and Church of the Machine God don't sell it either; picking the top-rep faction
regardless made the advice count levels the buyer could never get. The buyer says when a faction refuses
NeuroFlux, and reads the stock value for its "in stocks" note when it runs (port 26, which `--liquidate`
clears), not from the plan made before the sell-off.

**NeuroFlux waits for home.** While a home RAM or cores upgrade is affordable (the cash its buyer last posted
on port 33: cost plus its income reserve), the buyer leaves the leftover cash to it instead of buying
NeuroFlux levels, since the upgrade survives the install and raises income. This rule came from an earlier version, reading the buyers' notes instead of the files it used; with no note yet (a fresh run, or startup.js not running)
NeuroFlux is bought as before. The forecast doesn't apply it: it counts NeuroFlux from the leftover cash at
every moment, as a stand-in for whatever that cash buys (see "Checked offline").

## After The Red Pill

Once The Red Pill is installed, the BitNode ends as soon as hacking reaches w0r1d_d43m0n's level
([`auto-destroy.js`](../singularity/auto-destroy.js)), and every reset throws the hacking exp away. The
value-per-hour rule doesn't know that, so it kept resetting for small batches. Now, with The Red Pill
installed, the usual rule is replaced: reset only if exp needed for the daemon's level with the batch's
hacking multiplier, at today's exp rate x the batch's hacking-exp multiplier x `afterRedPill.rebuildFactor`
(0.5, a new run starts slower), plus `overheadMinutes`, beats the exp still missing at today's rate by
`waitMargin`. Never once the level is reached. The game's level formula, mult x (32 ln(exp + 534.6) - 200),
with the mult read back from the current level and exp, so BitNode multipliers count without Source-File 5.
Exp rate comes from snapshots in the plan, like rep rates; no reset until it is measured.

## Daedalus push (getting the invite)

The Daedalus invite needs a number of **installed** augments (30 by default) on top of hack level and
money, and NeuroFlux Governor counts as one augment whatever its level. The value-per-hour rule only
counts useful augments, so on its own it spends leftover cash on NeuroFlux levels and skips cheap
useless augments, and the count creeps up a few per reset long after hack level and money are there.

So once every other invite requirement is met (`daedalusPush`, read with getFactionInviteRequirements,
which the planner already pays for), the count is all that stands between the run and The Red Pill,
and any augment counts the same:

- buy-augs picks the cheapest augments any joined faction has the rep for, useful or not, that fit
  the cash with the 1.9x markup (bought most expensive first as usual), plus `daedalusPushSpare` (2)
  in case a purchase fails on a prerequisite the planner can't see;
- as soon as they cover the missing count (after the bought-but-not-installed ones) it resets,
  buying that list instead of the usual plan (NeuroFlux still gets what's left);
- until then faction-goals puts the augments closest to unlocking at joined factions first, so
  player-work earns the rep for the cheapest-to-reach ones.

Rejected: buying useless augments all along. Before the other requirements are met they only make
the useful ones dearer, and the value-per-hour rule is the right one then.

## Daedalus

The Red Pill needs 2.5m Daedalus rep. With 150 favor (`getFavorToDonate`) a later run can buy
that rep at $1m per point (divided by the rep multiplier), but only after earning the invite
again (hack level and money).

**The donation is made by [`singularity/donate-rep.js`](../singularity/donate-rep.js).** A one-shot that
startup.js runs every 2 minutes: once a joined seller of a key augment has the favor, it donates the
missing rep's worth of home cash (at $1m per rep over the rep multiplier, then topping up at the rate
it saw, since BitNode multipliers on donations can't be read without Source-File 5). The next
auto-reset check then finds The Red Pill ready and resets for it at once. Until this existed nothing
donated, so the run after a favor reset ground the full 2.5m rep by work (with the 150-favor bonus),
which is the slowest way to the end of the BitNode once money is plentiful. Kept out of player-work
(it spends money, it doesn't move the player) and out of aug-buyer (that only runs at reset time).

While Daedalus is joined and **can** take donations, the reset waits as long as the donation money
comes within the horizon (home cash only: donations can't use stocks), since a reset would mean
earning the invite again first. Before, the normal rule took over there and could reset mid-grind.

While Daedalus is joined and can't take donations yet:

1. Red Pill by work sooner than (time this run took to get the invite + donation money /
   income): keep working, no reset.
2. Otherwise, if favor after a reset now reaches 150: reset.
3. Otherwise, if it reaches 150 within the horizon: wait for it, then reset.
4. Otherwise the normal rule decides.

## Known limits

- Only key augments are bought with donations. Every other faction with 150 favor could be too
  (rep for money speeds up any run once money is plentiful); not done yet.

- The income curve needs a few samples (about 20 min) before it uses this run; until then it borrows
  the last run's growth, or stays flat on the first run. Income spent by other scripts (servers,
  hacknet, home upgrades) isn't subtracted, here or before.
- Rep rates are the current ones; when player-work moves to another faction the ETAs change.
- Weights are judgement calls; the money stats follow the income mix, the rest stays as set (`wantStats`, `weights`).
- The income mix is the run's total so far, so a source that only took off late (hacknet after a big upgrade)
  counts less than it will by the end of the run.
- The favor formula is the game's (`favorToRep` = 25,000 x (1.02^favor - 1)); BitNode
  multipliers on donations aren't read (that needs Source-File 5).

Income curve added 2026-11 (before: income taken as flat). Replaced (2026-11) a count-based rule: 5 ready augments, wait up to 60 min for affordable
unlocks within 30 min, smaller resets after 3 h. It treated a +1% and a +30% augment the
same and ignored favor and NeuroFlux.
