# Grafting

Design note for the grafting step of [`../singularity/player-work.js`](../singularity/player-work.js), with
[`../singularity/graft-plan.js`](../singularity/graft-plan.js) (pure rules),
[`../singularity/workers/graft-scan.js`](../singularity/workers/graft-scan.js) (the candidates, port 46) and
[`../singularity/workers/graft-start.js`](../singularity/workers/graft-start.js). Capability: [`../utils/grafting.js`](../utils/grafting.js)
(BitNode 10, or Source-File 10 anywhere).

## What the game does (v3.0.0 source)

- A graft costs 3 x the augmentation's base price, taken when it starts and **not refunded** if the work is cancelled.
- It takes the player's time: (1 hour x log2(sum of the augmentation's multipliers, at least 1) + 30 minutes) / 2, divided by the
  Intelligence bonus, and unfocused work runs at 80% without the Neuroreceptor Management Implant.
- The augmentation works at once: no faction, no rep, no install, no reset. It needs its prerequisites installed and the player in
  New Tokyo when it starts (leaving afterwards is fine). Special augmentations (The Red Pill, Stanek's Gift) cannot be grafted.
- **Entropy virus**: each *finished* graft adds one stack (`Player.entropy`), unless the Congruity Implant is owned or queued.
  A stack multiplies every player multiplier by 0.98 (lower-is-better hacknet costs get 1/0.98), so n stacks leave 0.98^n
  (19 stacks: -31.9%). Stacks are **kept across installs** (the install re-applies them), cleared by buying/grafting the
  Congruity Implant (a graft-only augmentation, 50T base price, 150T to graft; it also stops new stacks) and reset when the
  BitNode ends. A cancelled graft adds none. `ns.getPlayer().entropy` is the count.
- Starting a graft replaces the player's current work, and any other work replaces a graft in progress.

## Decision

The player is the scarce thing, so the rule is about their time, not only the money:

1. **Never interrupt a graft.** While the work is a graft, every other step of player-work.js waits (a regression test pins it).
2. **Wanted augmentations only**: the reset rule's value (`augValue`, the same one buy-augs and faction-goals use) **less the
   Entropy stack the graft adds** (`entropyStackCost`) at least `grafting.minValue`, not owned or queued, never NeuroFlux, prerequisites installed. The scan worker asks every 10 minutes and
   right after a graft ends.
3. **While the player has other work** (faction work, a gang invite, study), only augmentations **no joined faction sells** are
   grafted: the rest come from rep for a third of the money, and the rep work stays. This is step 2c, before faction work.
4. **With nothing else to do** (no faction below its goal, no company job, no gang or study step), any wanted augmentation:
   idle player time is free, and an augmentation now beats the cash crime. This is the gap before the gym and the idle crime.
5. **Budget**: the cash beyond what this reset's planned purchases need (`data/aug-plan.json` `graftReserve` x `grafting.safety`),
   at most `grafting.maxFraction` of the cash. `graftReserve` is the batch the reset rule resets with, or is waiting for, less
   the income until then, and at least the batch that fits now (older plans: `cost`). Planned purchases come first because the
   reset rule is counting on that money: spent on grafts, the batch it waits for slipped out of reach and it reset with one augment.
6. **Which**: the best net value per hour of graft time, the cheaper first on a tie.
7. A refused graft is left alone for 30 minutes (`graftTryMs`). Flying to New Tokyo costs $200k and is only done when price
   plus flight fit; a stay in a city for an invite (`holdCity`) is never broken for a graft.

8. **The reset rule waits for a graft.** player-work notes the graft in progress in its state (port 35, `grafting`: augmentation,
   end time and price when it started it), from the pass that starts it. [`../singularity/buy-augs.js`](../singularity/buy-augs.js)
   reads it ([`../utils/grafting.js`](../utils/grafting.js) `readGraftInProgress`, 0GB): no reset while it runs (an install
   cancels it and the game keeps the money), and no rep rates measured over it (they read zero, so the rule saw nothing to wait for).
   See [`aug-reset.md`](aug-reset.md#grafting).

9. **Entropy is a cost in the same units as the value.** `augValue` is a sum of weight x ln(multiplier); a stack scales every
   multiplier by 0.98, so it costs -ln(0.98) x (sum of the weights, income-mix factors included, of the stats the player
   wants) (`entropyStackCost` in [`../utils/aug-filter.js`](../utils/aug-filter.js)). ln adds, so every stack costs the same.
   With the default stats that is about 0.2, so a graft must be worth clearly more than that: weak ones are not grafted, and a
   player with a narrow `wantStats` (a smaller weight sum) grafts more. The scan worker puts it on each candidate as
   `entropyCost` (0 with the Congruity Implant) and `pickGraft` ranks by the net value. The Congruity Implant itself is valued at
   the stacks it clears (entropy x one stack's cost), so it is grafted once the price fits the budget and there is entropy;
   the price (about 150T) means that is late. Rejected: a fixed stack cap (the right number depends on the weights).

Settings: `grafting` in the config (`enabled`, `maxFraction`, `safety`, `minValue`, `entropy`); `enabled: false` is the kill
switch for grafting, `entropy: false` ignores Entropy (the old rule: value alone).

## Tradeoffs and limits

- The scan worker is 34.6GB at Singularity 1x (94.6GB at 4x RAM multiplier SF4.2, 334.6GB at SF4.1), so at SF4.1 no server may have
  room and nothing is grafted; the rest of player-work.js is unaffected.
- Bladeburner: without The Blade's Simulacrum a Bladeburner action started by bb-pass.js cancels the player's work, a graft
  included. player-work.js starts nothing while Bladeburner plays, so it does not start a graft then, but one started just before
  the state changes could be cancelled. The sleeves' grafts do not exist: the game has no sleeve grafting.
- Rejected: grafting everything wanted whenever cash allows (it would pull the player off rep work that is a third of the price),
  and comparing against a measured rep rate per faction (the goals helper already limits which rep is reachable; the "no joined
  faction sells it" test is the simple, stable version of the same question).

## State

Built and tested against a fake game; not seen in a real run yet. Entropy added 2026-11-17 after the player saw 19 stacks (-31.9% on every multiplier); stacks already there stay until the Congruity Implant or the end of the BitNode.
