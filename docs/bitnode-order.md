# Which BitNodes to do first

A guide for a new save: the order to do every BitNode in, from the first BitNode 1 to BitNode 12, what each
Source-File level gives, what these scripts do with it, and how to tell the scripts your route. The order is
`bitnodePlan` in [`../config.js`](../config.js); with no route of your own, the scripts suggest the next BitNode from it
([Setting the route](#setting-the-route)). What a script needs is the `Requires` column of its folder README (tags in
the root README's [Requirements](../README.md#requirements)).

The order weighs only what the game gives: what each level adds, how hard each BitNode is with the Source-Files held by
then, and how much a level helps every run after it. Which mechanics these scripts automate played no part;
[What the scripts do with each Source-File](#what-the-scripts-do-with-each-source-file) covers that. The numbers come
from the game's source at version 3.0.0 and its in-game BitNode guides ([Sources](#sources)). Anything marked
**(community)** is a player report the source can't confirm.

## The order

"BN4.3" means Source-File 4 at level 3. Each destroy of a BitNode raises its Source-File by one level, up to 3
(BitNode 12 has no top level).

| Step | BitNode | What the Source-File gives | Why here |
| --- | --- | --- | --- |
| 1 | BN1.1 | Every later BitNode starts with 32GB of home RAM instead of 8GB; +16% to every multiplier | Every save starts here |
| 2 | BN1.2 | +24% instead of +16% | The biggest SF1 step, from the only BitNode with no penalties. The in-game guide warns that BitNode 4 is "a bit harsh" with only SF1 |
| 3 | BN4.1 to 4.3, in a row | The Singularity API everywhere. Outside BitNode 4 its RAM cost is 16x at SF4.1, 4x at 4.2, 1x at 4.3 | Automation first. At SF4.1 most Singularity calls cost 32 to 80GB each, more than a new BitNode's home. A long run: 9,000 hacking to finish |
| 4 | BN5.1 | Formulas.exe at every start ($5b otherwise), `getBitNodeMultipliers()`, Intelligence, +8% to the six hacking multipliers | Intelligence only gains XP once you own SF5, so every run after this one counts. 4,500 hacking to finish, one of the lowest |
| 5 | BN1.3 | +28% instead of +24%. No more home RAM: every SF1 level gives the same 32GB start | The cheapest clear in the game, and the bonus covers almost every later run |
| 6 | BN2.1 | Gangs everywhere (outside BitNode 2 a gang needs -54,000 karma); +24% crime success, crime money and charisma | In BitNode 2 a gang needs no karma and its faction offers The Red Pill. Gang money buys the NeuroFlux levels its 15,000-hacking finish takes |
| 7 | BN6.1 | Bladeburner everywhere; +8% combat | Finishing every Black Op ends a BitNode with no hacking at all: the way out of BitNodes 10, 9 and 13. BitNode 6 has no Bladeburner penalties |
| 8 | BN10.1 to 10.3, in a row | One sleeve per level, and grafting | Sleeves speed up karma and Bladeburner. The Covenant sells up to 5 more sleeves ($10t up to $100q) only inside BitNode 10, so three runs give three chances |
| 9 | BN7.1 to 7.3, in a row | +8/12/14% Bladeburner stamina, analysis and success chance; at 7.3 The Blade's Simulacrum free on joining Bladeburner ($150b otherwise) | With the Simulacrum, Bladeburner runs alongside other work. Sleeves and SF6 soften BitNode 7's 60% rank gain and 2x skill costs |
| 10 | BN3.1 to 3.3, in a row | Corporations everywhere ($150b to start one outside BitNode 3); at 3.3 the full corporation API (the Office and Warehouse APIs cost $50b each otherwise) | Hacking pays 0.8% of BitNode 1 there and augmentations cost 3x, but a corporation can start on government seed money and Bladeburner has no penalty |
| 11 | BN9.1 to 9.3, in a row | Hacknet servers everywhere; from 9.2 a 128GB home at every start; at 9.3 a highly upgraded hacknet server at every start | Hacking pays 0.1% of BitNode 1 there and there are no purchased servers, so it comes after Bladeburner. The 128GB start then helps every run after |
| 12 | BN5, BN2 and BN6 to level 3 | Multipliers only. Over level 1: +5.6% hacking (SF5), +14.5% crime and charisma (SF2), +5.6% combat (SF6) | They unlock nothing, so they wait until these BitNodes are quick. They share one tier: the scripts suggest the easiest of the three first |
| 13 | BN14.1 to 14.3 | IPvGO: stat bonuses from node power doubled, then the `go.cheat` API, then +25% cheat success; more favor from win streaks at each level | Go is in every BitNode, so every later run gains. 15,000 hacking at 40% hacking level, but Go power is 4x there and Bladeburner works (60% rank) |
| 14 | BN15.1 to 15.3 | TOR and DarkscapeNavigator.exe at every start and the full darknet, whose labyrinth gives The Red Pill in every BitNode but 8; then charisma raises job pay and rep; then faction rep and `.cache` rewards | A second way to The Red Pill for the BitNodes after. Bladeburner gets 20% rank there and augmentations cost 3x, so it is a hacking and darknet run |
| 15 | BN8.1 to 8.3 | WSE and the TIX API at every start, then short selling, then limit and stop orders; +12/18/21% grow | Only stocks pay there, and each install resets your money to $250m. Later Source-Files barely help, so it isn't held back further |
| 16 | BN13.1 to 13.3 | Stanek's Gift (the Church of the Machine God) in every BitNode, bigger each level | The in-game guide calls its multipliers extremely harsh: 9,000 hacking at 25% hacking level, Bladeburner at 45% rank, gangs at 30%. It gets every other help first |
| 17 | BN11.1 to 11.3 | +32/48/56% company pay and rep, and company favor raises pay too; each augmentation bought raises the rest's price x1.77 instead of x1.9 at 11.3 | Both in-game guides rate it low for its difficulty. Its cheaper batches help in BitNode 12 |
| 18 | BN12, as often as you like | One free NeuroFlux Governor level per SF12 level at every start | Each level makes the BitNode about 2% harsher: 3,060 hacking to finish at 12.1, 8,075 at 37% hacking level by 12.50. The plan asks for 50, its challenge achievement; raise it to keep going |

## How the order was decided

Six rules, in priority order.

1. **Automation first, all three levels in one go.** At SF4.1 most Singularity functions cost 32 to 80GB each outside
   BitNode 4, and still 8 to 20GB at SF4.2, so stopping early buys little. BitNode 1.2 goes before them: the in-game
   guide warns that BitNode 4 is "a bit harsh" with only SF1, and calls the step from SF1.1 to 1.2 "equivalent to 8 levels of
   NFG". The price: Bladeburner isn't unlocked yet, so each BitNode 4 run ends by hacking to 9,000.
2. **Cheap boosts that every later run keeps.** Intelligence gains XP only once you own SF5 (or inside BitNode 5): from
   crimes, grafting, writing programs, several Singularity calls, and 300 XP for each BitNode destroyed after that. The
   sooner BitNode 5.1 comes, the more it collects. BitNode 1.3 follows: a bonus to every multiplier from the easiest
   clear.
3. **A way out before the BitNodes that need one.** Finishing every Black Op ends a BitNode without the hacking level
   or The Red Pill. SF6 comes before BitNode 10 (6,000 hacking at 35% hacking level), 9 and 13, and the in-game guide
   names 9 and 13 as where Bladeburner helps most. BitNode 2 doesn't need it, since its gang pays for the NeuroFlux
   levels. BitNode 6 comes before 7 because it has no Bladeburner penalties and SF6 alone unlocks the API.
4. **Mechanics in the order they help each other.** Gangs before sleeves: BitNode 10 halves hacking money while its
   Covenant sleeves cost $10t up to $100q, and gangs are barely weakened there. Sleeves before BitNode 7 and the hard
   BitNodes: the guide says sleeves speed up Bladeburner "a lot", and their crimes count toward a gang's karma. SF7.3
   before BitNodes 9 and 13, where the guide recommends Bladeburner. Corporations before hacknet servers: hashes buy
   corporation funds and research as well as Bladeburner rank.
5. **Levels that unlock something go back to back.** BitNodes 4, 10, 7, 3 and 9 go to level 3 in a row because the
   main payoff is at a higher level: 1x Singularity RAM at 4.3, a sleeve per level of 10 (and a Covenant window each
   run), the Simulacrum at 7.3, the full corporation API at 3.3, the 128GB home at 9.2. The later BitNodes also go to
   level 3 in one go, because each repeat reuses the strategy that BitNode forced and some later levels are features
   (`go.cheat` at 14.2, short selling and limit orders at 8.2 and 8.3); that part is judgment. Levels that only raise
   multipliers (5, 2 and 6 past level 1) wait until those BitNodes are quick. SF1 is the exception: BitNode 1 is the
   easiest clear and its bonus covers every multiplier.
6. **The hardest BitNodes last, each after what eases it.** BitNodes 14 and 15 open the tail: Go and the darknet exist
   in every BitNode, so their Source-Files help every run after, and SF15's labyrinth is a second way to The Red Pill
   for 13, 11 and 12. BitNode 8 next: later Source-Files barely help there, since Bladeburner, gangs, corporations,
   Stanek's Gift and darknet money are switched off, and its one named prerequisite, grafting, comes from BitNode 10.
   BitNode 13 after that, with every other help. BitNode 11 near the end: both guides rate its reward low for its
   difficulty, and the comprehensive guide says to do it "at the end, for the sake of completion". BitNode 12 last and
   open-ended: the guide says to try it "after unlocking all mechanics".

## Least certain

The source fixes what each level gives and each BitNode's multipliers, not how long a run takes. Three calls rest on
judgment, each with a fallback:

- **BitNode 10 before 3.** The last three Covenant sleeves cost $1q, $10q and $100q and sell only inside BitNode 10,
  and the guide says the last one needs "a batcher or a corporation". Sleeves come first here because they help every
  step after; a sleeve still missing after 10.3 costs one more BitNode 10 run later. Fallback: BitNode 3 before 10, so
  a corporation can pay for them.
- **BitNode 2.1 before 6.1.** Both guides call BitNode 2 a good early BitNode, and players report finishing it in
  under two days with a gang (community). If your BitNode 2 run stalls short of 15,000 hacking, do 6.1 first: SF6 then
  lets BitNode 2 end through the Black Ops while the gang runs by itself.
- **The order of the tail** (14, 15, 8, 13, 11). Each comes after what eases it, but no source ranks them against each
  other. BitNode 8 moves most easily: it can go any time after step 8 if the stock market suits you. BitNode 15 can
  come sooner if you want the labyrinth's Red Pill earlier.

## What the scripts do with each Source-File

The plan includes every Source-File, managed here or not. In a run whose new mechanic has no manager yet, you play that
mechanic by hand and the rest of the scripts run as usual.

### Source-File 1

[`../startup.js`](../startup.js) picks its stage from home RAM (under 64GB it runs the lean `start` stage), so with any
level of Source-File 1 every run still begins in that stage until home is upgraded. Source-File 9.2's 128GB start
begins in the `mid` stage.

### Source-File 4: the automation gate

The Singularity API lets a script study, buy programs and home upgrades, backdoor servers, join factions, work for
them, buy and install augmentations and end the BitNode. Everything in [`../singularity/`](../singularity/README.md)
uses it, plus `share-manager.js` and parts of the Bladeburner and gang scripts. It works in BitNode 4, or anywhere once
you own Source-File 4 ([`../utils/singularity.js`](../utils/singularity.js)). A script whose 30GB is all Singularity
calls costs 480GB at SF4.1 and 120GB at SF4.2, so most of them won't fit until level 3. Inside BitNode 4 there is no
multiplier, so the first run through it is the cheapest way to see the whole automation work.

Without SF4, [`../startup.js`](../startup.js) leaves out every Singularity script with one summary line and runs the
rest: batcher, purchased servers, hacknet, Go, contracts, darknet, stocks. You buy programs and home RAM by hand and
back door servers by hand ([`reminders.md`](reminders.md) tells you when). The run works; it just is not hands off.

### Source-File 5: numbers instead of guesses

- **Formulas.exe.** The batcher and hacknet use exact numbers instead of estimates (`Formulas (opt)`).
- **`getBitNodeMultipliers()`.** [`../startup.js`](../startup.js) saves them once per run
  ([`bitnode-mults.md`](bitnode-mults.md)). With them it skips the batcher where hacking pays almost nothing, skips
  hacknet or the gang where their multiplier is below 0.1, and ranks the BitNodes that share a tier of the plan by how
  easy their multipliers make them.
- **The Intelligence stat.** Nothing here depends on it; scripts that read it work without.

Everything falls back to a multiplier of 1 without SF5, so skipping it costs efficiency, not function.

### Source-File 2: gangs

The Gang API ([`../gang/`](../gang/README.md), `SF2`) works in BitNode 2 or with Source-File 2. In BitNode 2 a gang
only needs a gang faction's invite; elsewhere it also needs karma of -54,000, which
[`../singularity/player-work.js`](../singularity/player-work.js) grinds with crimes when it has SF4
([`../utils/gang.js`](../utils/gang.js)). A gang is a strong second income, so SF2 pays back in every later run.

### Source-Files 6 and 7: Bladeburner

The Bladeburner API ([`../bladeburner/`](../bladeburner/README.md), `SF6/7`) works in BitNode 6 or 7, or with
Source-File 6 or 7; either one is enough for the scripts. Once every Black Op is done,
[`../singularity/auto-destroy.js`](../singularity/auto-destroy.js) and `next-bitnode` end the BitNode with no hacking
level or Red Pill needed, which is how the plan gets out of BitNodes 10, 9 and 13. Combat training goes through `player-work.js`, which needs SF4. The `bladeburner` preset
in [`../config.js`](../config.js) swaps the augment weights for combat; `bladeburner.route` picks between playing it and
holding it. SF7's bonuses apply by themselves. Without SF7.3 the scripts buy The Blade's Simulacrum first on the Bladeburner route and install it at once ([`bladeburner.md`](bladeburner.md#the-blades-simulacrum)).

With SF7.3, joining the Bladeburner division installs The Blade's Simulacrum, which closes Stanek's Gift for the rest
of the BitNode (the game warns when you join by hand; the API doesn't). With `bladeburner.stanekFirst` on,
[`../bladeburner/bb-manage.js`](../bladeburner/bb-manage.js) doesn't join while the Gift is still open, and says once how
to go on: accept the Gift at the Church of the Machine God in Chongqing, or
`run /tools/set-config.js set bladeburner.stanekFirst false`. It is on by default in BitNode 13 only; set it to `true`
for any other run where you want the Gift ([`bladeburner.md`](bladeburner.md)).

### Source-Files with no manager here yet

- **SF10, sleeves and grafting:** no sleeve or grafting scripts; set sleeves to work by hand.
- **SF3, corporations:** no corporation scripts.
- **SF9, hacknet servers:** SF9 replaces hacknet nodes with hacknet servers in every BitNode, and
  [`../hacknet/hacknet-manager.js`](../hacknet/hacknet-manager.js) only handles nodes that earn money: it stands down
  once they make hashes, which is every run from step 11 on. Spend hashes by hand.
- **SF13, Stanek's Gift:** no scripts; place and charge the fragments by hand.
- **SF8, stock market:** SF8.1 gives the WSE account and the TIX API at every start, which
  [`../stocks/stock-trader.js`](../stocks/stock-trader.js) needs (`TIX`). The trader buys longs only: the short-selling
  calls would cost 5GB of RAM even when unused.
- **SF14, IPvGO:** the Go bot ([`../go/`](../go/README.md)) works from a fresh save, and SF14.1 doubles what its wins
  give. [`../go/anticheat.js`](../go/anticheat.js) needs SF14.2.
- **SF15, darknet:** [`../darknet/`](../darknet/README.md) starts once DarkscapeNavigator.exe is on home, which SF15.1
  gives at every start. No script goes after the labyrinth's Red Pill, and in BitNode 15 Daedalus doesn't sell it, so
  that run needs you to get it there (or a Black Ops finish at 20% rank).
- **SF11:** the company and augmentation price effects apply by themselves, and the scripts that plan augmentation
  batches use the cheaper price step ([`../utils/aug-price.js`](../utils/aug-price.js), [`aug-reset.md`](aug-reset.md)).
- **SF12:** the free NeuroFlux Governor levels apply by themselves.

## Challenge achievements

Twelve BitNodes have a challenge achievement in v3.0.0; BitNodes 4, 5 and 11 have none. Any destroy of that BitNode
under the condition counts, including an extra run after level 3. Where each fits this order is a suggestion. Which
scripts break each challenge is in [`../achievements/README.md`](../achievements/README.md#challenges).

| BitNode | Condition | Where it fits |
| --- | --- | --- |
| 1 | At most 128GB home RAM and 1 core | BitNode 1.2 or 1.3 (steps 2 and 5), with `challenge bn1` ([`../achievements/bn1-challenge.md`](../achievements/bn1-challenge.md)) |
| 2 | No gang | BitNode 2.2 or 2.3 (step 12), finishing through the Black Ops |
| 3 | No corporation | BitNode 3.3 (step 10), with a gang or Bladeburner |
| 6, 7 | Never join the Bladeburner division | An extra run late in the order: 6,000 hacking at 35% hacking level |
| 8 | No 4S market data | BitNode 8.3 (step 15), if your trading works without 4S |
| 9 | No hacknet nodes or servers | BitNode 9.3 (step 11), finishing through the Black Ops |
| 10 | No sleeves | An extra BitNode 10 run after step 8, finishing through the Black Ops |
| 12 | Destroy BitNode 12 50 times | Step 18, which the plan runs to level 50 |
| 13 | No Stanek's Gift | An extra run at the end, since the Gift is BitNode 13's main help |
| 14 | No Go moves or cheats through the API | BitNode 14.3 (step 13): stop the Go bot and play by hand, or not at all |
| 15 | Never call `dnet.heartbleed` | BitNode 15.3 (step 14), without the darknet scripts, which use it |

When you pick the next BitNode yourself on the BitVerse screen, its advanced options can switch a mechanic off for one
run (gangs, corporations, Bladeburner, 4S market data, hacknet servers, or sleeves' experience and augmentations) or cap
home at 128GB and 1 core, and the Source-File is granted the same. That keeps a script from breaking a challenge by
accident.

## Setting the route

Three ways, from least to most control. All of them are read when [`../singularity/auto-destroy.js`](../singularity/auto-destroy.js)
decides the next BitNode, and nothing is destroyed unless the conditions are met (The Red Pill installed, hacking level
for `w0r1d_d43m0n`, or every Black Op done).

- **Do nothing.** With `bitnodeRoute` empty the scripts only *suggest* the next BitNode from `bitnodePlan` (in `status`
  and in the "ready" notice). Set `bitnodeRouteAuto` to `true` to let auto-destroy follow the suggestion itself. The
  suggestion is the first step with a level you don't own yet (counting the one this destroy gives), so it works from
  any save: one that did BitNode 4 before 1.2 is sent back for 1.2 first. Within a tier it picks the BitNode whose
  multipliers make it easiest when you own SF5, otherwise the listed order.
- **Set your own route.** `afk-route 4:3 2:1 5:1` stores `bitnodeRoute` in `data/config.json`: BitNode:level pairs, done
  in order. Source-Files you already have are skipped, so you can list the whole plan. `afk-route` alone shows it,
  `afk-route clear` empties it. A route of your own always wins over the plan.
- **Go now.** `next-bitnode 5` ends the BitNode (same checks) and enters BitNode 5 directly; use it for a one-off
  choice or an achievement run.

To change the default order, put your own `bitnodePlan` (list of `{ bitNode, level, tier }`) in `data/config.json`.
Lists replace the default, so copy the whole list from [`../config.js`](../config.js) and change what you want; lower
tier numbers go first. Settings that should differ per BitNode go under `bitnodes` ([`config.md`](config.md)).

Rejected: a fixed route in code. The right order depends on how far a save already is, so the plan is a list in the
config that skips what you own, and the suggestion is advice unless you turn on `bitnodeRouteAuto`. In that list,
step 12 is one tier because its three BitNodes are interchangeable, and BitNode 12 has a target level because every
entry needs one: 50 is the game's own marker (its challenge achievement), and a higher number keeps the suggestion going.

## Sources

Game source at the [v3.0.0 tag](https://github.com/bitburner-official/bitburner-src/tree/v3.0.0):

- BitNode and Source-File texts and every multiplier: [`src/BitNode/BitNode.tsx`](https://github.com/bitburner-official/bitburner-src/blob/v3.0.0/src/BitNode/BitNode.tsx)
- What each Source-File level applies: [`src/SourceFile/applySourceFile.ts`](https://github.com/bitburner-official/bitburner-src/blob/v3.0.0/src/SourceFile/applySourceFile.ts)
- What a new BitNode starts with (home RAM, the BitNode 9 hacknet server, SF12 NeuroFlux levels, Intelligence XP): [`src/Prestige.ts`](https://github.com/bitburner-official/bitburner-src/blob/v3.0.0/src/Prestige.ts)
- Singularity RAM costs: [`src/Netscript/RamCostGenerator.ts`](https://github.com/bitburner-official/bitburner-src/blob/v3.0.0/src/Netscript/RamCostGenerator.ts)
- Finishing a BitNode by hacking or by the Black Ops: [`src/NetscriptFunctions/Singularity.ts`](https://github.com/bitburner-official/bitburner-src/blob/v3.0.0/src/NetscriptFunctions/Singularity.ts)
- Covenant sleeves: [`src/PersonObjects/Sleeve/SleeveCovenantPurchases.tsx`](https://github.com/bitburner-official/bitburner-src/blob/v3.0.0/src/PersonObjects/Sleeve/SleeveCovenantPurchases.tsx)
- Intelligence XP: [`src/PersonObjects/Person.ts`](https://github.com/bitburner-official/bitburner-src/blob/v3.0.0/src/PersonObjects/Person.ts)
- Augmentation prices and The Blade's Simulacrum: [`src/Augmentation/AugmentationHelpers.ts`](https://github.com/bitburner-official/bitburner-src/blob/v3.0.0/src/Augmentation/AugmentationHelpers.ts), [`src/Augmentation/Augmentations.ts`](https://github.com/bitburner-official/bitburner-src/blob/v3.0.0/src/Augmentation/Augmentations.ts)
- Stanek's Gift and joining Bladeburner with SF7.3: [`src/CotMG/Helper.tsx`](https://github.com/bitburner-official/bitburner-src/blob/v3.0.0/src/CotMG/Helper.tsx), [`src/PersonObjects/Player/PlayerObjectBladeburnerMethods.ts`](https://github.com/bitburner-official/bitburner-src/blob/v3.0.0/src/PersonObjects/Player/PlayerObjectBladeburnerMethods.ts)
- Corporations: [`src/Corporation/helpers.ts`](https://github.com/bitburner-official/bitburner-src/blob/v3.0.0/src/Corporation/helpers.ts), [`src/Corporation/data/CorporationUnlocks.ts`](https://github.com/bitburner-official/bitburner-src/blob/v3.0.0/src/Corporation/data/CorporationUnlocks.ts)
- Hacknet servers and hashes: [`src/Hacknet/HacknetHelpers.tsx`](https://github.com/bitburner-official/bitburner-src/blob/v3.0.0/src/Hacknet/HacknetHelpers.tsx), [`src/Hacknet/data/HashUpgradesMetadata.tsx`](https://github.com/bitburner-official/bitburner-src/blob/v3.0.0/src/Hacknet/data/HashUpgradesMetadata.tsx)
- The darknet labyrinth: [`src/DarkNet/effects/labyrinth.ts`](https://github.com/bitburner-official/bitburner-src/blob/v3.0.0/src/DarkNet/effects/labyrinth.ts)
- Challenge achievements and the BitVerse's advanced options: [`src/Achievements/AchievementData.json`](https://github.com/bitburner-official/bitburner-src/blob/v3.0.0/src/Achievements/AchievementData.json), [`src/BitNode/ui/BitNodeAdvancedOptions.tsx`](https://github.com/bitburner-official/bitburner-src/blob/v3.0.0/src/BitNode/ui/BitNodeAdvancedOptions.tsx)
- In-game guides: the [short guide](https://github.com/bitburner-official/bitburner-src/blob/v3.0.0/src/Documentation/doc/en/advanced/bitnode_recommendation_short_guide.md) and the [comprehensive guide](https://github.com/bitburner-official/bitburner-src/blob/v3.0.0/src/Documentation/doc/en/advanced/bitnode_recommendation_comprehensive_guide.md)

Community reports: [BitNode 4.3 stuck below 9,000 hacking](https://www.reddit.com/r/Bitburner/comments/1b2297s/bn43_cant_get_to_9000_hack_to_install_backdoor/),
[BitNode 2's 15,000 hacking](https://www.reddit.com/r/Bitburner/comments/1h04776/bitnode_2_question/),
[choosing a BitNode](https://www.reddit.com/r/Bitburner/comments/1g7b53j/im_hesitant_with_choosing_bitnode/),
[gangs in BitNodes 2 and 3](https://steamcommunity.com/app/1812820/discussions/0/3975051032846139530) (Steam).
