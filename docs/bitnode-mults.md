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

## Where a multiplier changes a decision

1. **Done:** batcher's weaken guess before the first measurement (`ServerWeakenRate`); hacknet's price of a
   first node without Formulas (`HacknetNodeMoney`).
2. **Gating, done:** `mechanicGates` in the config maps a script to the multipliers it lives on; startup.js leaves it
   out while one is below `minMultiplier` (0.1) and says so once. Today: hacknet (`HacknetNodeMoney`) and the gang
   (`GangSoftcap`). The player's overrides win: `mechanicGates.force` lists scripts to start anyway and
   `enabled: false` turns it off (`set-config set mechanicGates.enabled false`). Coding contracts are not gated: they
   also pay faction and company rep, not only money.
3. **Route suggestion, done:** with `bitnodeRoute` empty, `bitnodePlan` (the order in [`bitnode-order.md`](bitnode-order.md), in
   tiers, in the config) is walked against the Source-Files the game says are owned: the first tier with a level not
   owned yet, and inside it the BitNode whose multipliers (`easeScore` in
   [`utils/bitnode-route.js`](../utils/bitnode-route.js): hack money, server money, hacking level, faction rep, minus
   augment costs) make it easiest. The multipliers of every BitNode come from the same saved file, so this needs SF5;
   without it the listed order is used. By default it only suggests (status and the "ready" notice), because ending
   a BitNode is not undoable; `bitnodeRouteAuto: true` lets auto-destroy.js follow it. A `bitnodeRoute` of the player's
   own always wins, and `next-bitnode <n>` / `afk-route` still work, e.g. to go for a specific achievement.
4. **Hacking worth, done:** where `ScriptHackMoney` x `ScriptHackMoneyGain` is below `hackWorth.minProduct` (0.1),
   startup.js doesn't start the batcher ([`hack/ready.js`](../hack/ready.js)), so share and the XP farm get the RAM. Chosen
   over a mode inside the batcher: grow and weaken without hack earn nothing. Cost: stock influence (it runs through the
   batcher's workers) stops too. Overrides: `hackWorth.enabled: false` or `mechanicGates.force`. It waits up to 2 minutes
   for the multipliers to be saved at the start of a run, then starts the batcher anyway. If the multipliers turn up after the
   batcher started (the wait timed out), startup.js stops it on its next pass and says so once. In that case the stock trader moves from the late to the
   early stage (`earlyIf` in startup.js), since the market is then the income; its ~26GB still needs a 64GB home.
   An influence-only grow/hack worker for the stock servers is not built; design it from a real BitNode 8 run.
5. **Reset rule:** the price step (1.9, less with Source-File 11: [`../utils/aug-price.js`](../utils/aug-price.js)) and the
   NeuroFlux 1.14 are game constants, not BitNode multipliers. Augment cost and rep multipliers are already in the live prices.
6. **`bitnodes` in `config.js`:** one entry today, BitNode 13 turning on `bladeburner.stanekFirst`
   ([`bladeburner.md`](bladeburner.md)): a choice about the BitNode's mechanic, not a multiplier effect. A per-BitNode
   value that only encodes a multiplier effect should be derived from the multiplier, as the two above are.

## Tradeoffs and rejected ideas

- Calling `getBitNodeMultipliers` in each script: 4GB per script, too much for the batcher and managers.
- Putting them on a port: lost when the game restarts or ports clear; a file survives and is checked against
  the BitNode number it was written in.
- Raising the whole core to depend on SF5: breaks earlier-game players, so everything falls back to 1.
