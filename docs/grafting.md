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
- Starting a graft replaces the player's current work, and any other work replaces a graft in progress.

## Decision

The player is the scarce thing, so the rule is about their time, not only the money:

1. **Never interrupt a graft.** While the work is a graft, every other step of player-work.js waits (a regression test pins it).
2. **Wanted augmentations only**: the reset rule's value (`augValue`, the same one buy-augs and faction-goals use) at least
   `grafting.minValue`, not owned or queued, never NeuroFlux, prerequisites installed. The scan worker asks every 10 minutes and
   right after a graft ends.
3. **While the player has other work** (faction work, a gang invite, study), only augmentations **no joined faction sells** are
   grafted: the rest come from rep for a third of the money, and the rep work stays. This is step 2c, before faction work.
4. **With nothing else to do** (no faction below its goal, no company job, no gang or study step), any wanted augmentation:
   idle player time is free, and an augmentation now beats the cash crime. This is the gap before the gym and the idle crime.
5. **Budget**: the cash beyond what this reset's planned purchases need (`data/aug-plan.json` cost x `grafting.safety`), at most
   `grafting.maxFraction` of the cash. Planned purchases come first because their price per augmentation is lower.
6. **Which**: the best value per hour of graft time, the cheaper first on a tie.
7. A refused graft is left alone for 30 minutes (`graftTryMs`). Flying to New Tokyo costs $200k and is only done when price
   plus flight fit; a stay in a city for an invite (`holdCity`) is never broken for a graft.

Settings: `grafting` in the config (`enabled`, `maxFraction`, `safety`, `minValue`); `enabled: false` is the kill switch.

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

Built and tested against a fake game; not seen in a real run yet.
