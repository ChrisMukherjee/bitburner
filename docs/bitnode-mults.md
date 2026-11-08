# BitNode multipliers

## Decision

`ns.getBitNodeMultipliers()` needs BitNode 5 or Source-File 5 and costs 4GB, so no manager calls it. A
one-shot ([`tools/save-bitnode-mults.js`](../tools/save-bitnode-mults.js), started once per run by
[`startup.js`](../startup.js) when [`utils/sf5.js`](../utils/sf5.js) says the game allows it) saves them to
`data/bitnode-mults.json`. [`utils/bitnode-mults.js`](../utils/bitnode-mults.js) reads that file at 0GB:
`bitnodeMults(ns).get("ServerWeakenRate")`. Without the file (no Source-File 5, not saved yet, or a file left
from another BitNode) every multiplier reads as 1, which is what the scripts assumed before, so a player
without SF5 sees no change. Scripts never branch on `known` unless they must; they use `get()` and the
default does the right thing.

## What the code already gets right

Most numbers are read live from the game, and the live values already include the BitNode:
batcher target scoring and thread counts (`hackAnalyze`, `growthAnalyze`, `weakenAnalyze`, `getServerMaxMoney`,
Formulas), hacknet payback (real node production), augment prices and rep costs
(`singularity.getAugmentationPrice` / `RepReq`), the donation rate (`repMult` from the faction). Pure money
multipliers also cancel when ranking targets, because every target is scaled the same.

## Where a multiplier still changes a decision (plan)

1. **Done:** batcher's weaken guess before the first measurement (`ServerWeakenRate`); hacknet's price of a
   first node without Formulas (`HacknetNodeMoney`).
2. **Gating (next):** skip or lower the priority of mechanics a BitNode makes worthless: hacknet at
   `HacknetNodeMoney` ~0, the gang at `GangSoftcap` ~0, coding contracts at `CodingContractMoney` ~0,
   infiltration, corporation. Each goes in that folder's ready check, not in startup.js.
3. **Hacking worth:** with `ScriptHackMoney` x `ScriptHackMoneyGain` very low, hack income is not worth the
   RAM; the batcher should say so and leave the RAM to share, XP farm and stock-influence. Needs a design
   pass before any code.
4. **Reset rule:** `PRICE_MULT` 1.9 and the NeuroFlux 1.14 are game constants, not BitNode multipliers
   (Source-File 11 changes the 1.9). `AugmentationMoneyCost`/`AugmentationRepCost` are already in the live
   prices. `DaedalusAugsRequirement` and `FavorToDonateToFaction` would replace assumptions in the Daedalus
   rule (the latter is already read live via `getFavorToDonate`).
5. **`bitnodes` in `config.js`:** it is empty today, so there is nothing to replace yet. Rule going forward:
   a per-BitNode value that only encodes a multiplier effect is derived from the multiplier, not written by hand.

## Tradeoffs and rejected ideas

- Calling `getBitNodeMultipliers` in each script: 4GB per script, too much for the batcher and managers.
- Putting them on a port: lost when the game restarts or ports clear; a file survives and is checked against
  the BitNode number it was written in.
- Raising the whole core to depend on SF5: breaks earlier-game players, so everything falls back to 1.
