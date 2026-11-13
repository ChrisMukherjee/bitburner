# What an install keeps

An augmentation install doesn't reset everything the same way. Some mechanics keep all their progress (a gang, Bladeburner),
some keep part of it (faction rep turns into favor), and some lose everything (money, servers). The scripts weigh a reset and
pick a route by what is really lost. This note lists what each mechanic keeps and what the scripts do about it. Settings:
`persistence` in [`config.js`](../config.js).

## What the game keeps (bitburner-src v3.0.0)

Read from `src/Prestige.ts` (`prestigeAugmentation`, `prestigeSourceFile`) and the `prestigeAugmentation` methods it calls.

| Mechanic | Augmentation install | BitNode destroyed |
| --- | --- | --- |
| Money | wiped (a small starting amount; augment start money; $250m in BitNode 8) | wiped |
| Hacking, combat, charisma skills and exp | wiped (intelligence kept) | wiped (intelligence kept) |
| Faction rep | turned into favor, rep back to 0; membership and invites end | favor gone too |
| Company rep and jobs | turned into favor, rep back to 0; jobs end | gone |
| Home RAM and cores | **kept** | back to the start |
| Purchased servers, hacknet nodes and hashes | wiped | wiped |
| Programs | wiped (BitFlume, augment programs and Formulas.exe with Source-File 5 come back) | wiped |
| Stock market | shares wiped (the market starts again); **TIX and 4S access kept** | access lost |
| Gang | **kept**: members, equipment, respect, land; ascension points x0.95 | gone |
| Bladeburner | **kept**: rank, skill points and skills, action counts and levels, cities; the running action stops; the Bladeburners faction is joined again at rank 25 (its rep restarts) | gone |
| Corporation | **kept** | gone |
| Sleeves | **kept** (stats, augments), set to synchronize or shock recovery | back to level 1 (the count stays) |
| Go (IPvGO) | node power and win/loss stats cleared, so **the bonuses restart at 0**; the favor from win streaks stays | cleared |
| Stanek's Gift | fragments kept, **charge cleared** | cleared |
| Darknet | state reset | reset |
| Karma, entropy | kept | reset |

## What the scripts do with it

**Already right before this note.**

- The reset rule ([`aug-reset.md`](aug-reset.md)) counts what carries over: augments and the favor this run's rep becomes.
  The run's age is its cost, so everything wiped (money, rep, servers, Go bonuses) is inside it. Stocks are sold before the
  install and home upgrades are bought with the cash first.
- The gang manager values equipment over the BitNode's age (`lastNodeReset`), not the run's, because the gang keeps its
  gear through an install; only ascension wipes non-augment gear, and that is counted per member ([`gang.md`](gang.md)).
- The route estimate ([`bladeburner.md`](bladeburner.md)) keeps rank, skill points and action counts and levels across its
  modelled installs, and retrains the combat stats in each run, as the game does.
- The stock trader buys TIX and 4S as soon as the cash covers them, with no "pays back this run" test, so access that
  outlives the run is never held back for that reason.
- Gang income raises no augment stat (members don't use the player's multipliers), so a big gang only lowers the weight
  of the money stats ([`aug-reset.md`](aug-reset.md), "Income mix").

**Changed with this note.**

- **Faction rep in the route estimate** (`persistence.routeRepResets`). The route model kept each faction's rep across its
  modelled installs, so an augment needing 1m rep unlocked after enough short runs, and Daedalus rep for The Red Pill added
  up the same way. Now rep restarts at 0 each run and turns into favor with the game's formula; favor makes the work
  (1 + favor/100) times faster and, at `getFavorToDonate()` (150), lets rep be bought with money. An augment needs its rep
  inside one run, and Daedalus has to invite again each run (hacking level and money) before its rep counts. `node-eta.js`
  passes today's favor and this run's rep for every faction (`getFactionFavor`, 1GB more at normal Singularity cost). The
  old model made the hacking route, which lives on faction rep, look shorter than it is next to Bladeburner, whose rank
  really does carry over; it also ignored favor speeding later runs up. `false` brings the old model back.
- **Leftover cash before an install** (`persistence.spendLeftover`). `install-augs.js` spent what was left after the
  augments on home RAM and cores only, and the rest was lost. Now it then buys the TIX and 4S Market Data TIX APIs (unless
  the stock trader is in `startupSkip`: the trader buys them anyway as soon as cash allows, so each dollar here is one the
  next run keeps), then gang equipment ([`../gang/workers/spend-leftover.js`](../gang/workers/spend-leftover.js)): anything
  that adds a member's pay, best payback first however long, since the alternative is losing the cash. Order: home first
  (the biggest help to the next run's start), then stock access (fixed prices the next run would pay), then the gang (takes
  any amount). `false` goes back to home upgrades only; `--keep-cash` still spends nothing.
- **Go bonuses restart at each install.** [`../go/go-bot.js`](../go/go-bot.js) already started an opponent's history over
  when its bonus fell; its comment and [`go-bot.md`](go-bot.md) said that happened only in a new BitNode.

**Rejected.** A per-mechanic "persistence weight" on augment values: the sum-of-logs value already measures how much faster
the next run goes, whatever pays for it, and the gang's progress doesn't depend on the player's augments at all.

## What is left

- **Reset timing on the Bladeburner route.** Rank carries over, so a run's hours aren't wasted the way a hacking run's are;
  what a reset costs is retraining the combat stats, which the Black Ops' chances depend on. The value-per-hour rule doesn't
  know that, and nothing holds a reset near the last Black Ops the way the after-Red-Pill rule holds it near the daemon's
  level. Needs a model of the Black Ops' chance against the stats first.
- **Rep for faction work outside the route estimate.** The Bladeburners faction's and a gang faction's rep also restart each
  install (from new rank and new respect only); neither is modelled for buying their augments.
- **Mechanics without scripts yet.** A corporation keeps everything through an install; whatever manages it
  should value spending over the BitNode, not the run. Sleeves are managed by [`../sleeves/`](../sleeves/README.md), which sets them back to work
  after an install by itself (the first pass sees shock and sync and recovers or synchronizes first); cash left before an install is not yet spent on sleeve augmentations. Stanek's Gift loses its charge each install, so charging belongs early
  in a run.
