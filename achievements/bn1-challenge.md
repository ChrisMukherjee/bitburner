# BN1: Challenge

**What the game checks:** you destroy BitNode 1 while home has **at most 128GB of RAM and exactly 1 core**.
It is checked once, at the moment `w0r1d_d43m0n` is destroyed (a scripted destroy counts too).
Home upgrades survive augment installs, so home must stay at or under the limit for the **whole** BitNode.
Purchased servers have no limit, and BitNode 1 allows the full 25 at up to 1PB each, so the batcher still
has plenty of RAM.

The scripts can do this run by themselves: one setting caps the home RAM and core buyers.

## Steps

1. **Before BitNode 1 starts** (any time in the BitNode before it), switch the challenge on in the game:

   ```text
   run /tools/set-config.js challenge bn1
   ```

   This adds `"challenges": ["bn1"]` to `data/config.json`. Its settings only apply while you are in
   BitNode 1, so it is safe to set early. Check with `run /tools/set-config.js challenge` (lists the
   challenges and which are on).
2. **Enter BitNode 1** as usual (`afk-route` with BitNode 1 on the route, or `next-bitnode 1`). Make sure
   [`startup.js`](../startup.js) is the first thing that runs there: it records the BitNode number that turns
   the cap on. `auto-destroy.js` already starts it after a destroy.
3. **Play as normal.** [`upgrade-home-ram.js`](../singularity/upgrade-home-ram.js) stops at 128GB and
   [`upgrade-home-cores.js`](../singularity/upgrade-home-cores.js) never buys a core; each posts a
   toast when it reaches the cap. The buy that [`install-augs.js`](../singularity/install-augs.js) does
   before every install stops there too. `run /tools/show-config.js homeUpgrades` should show
   `maxGB: 128` and `max: 1`.
4. **Don't upgrade home by hand.** No home RAM or core upgrades at a tech store (Alpha Enterprises and
   the like); the game doesn't stop you there. The `upgrade-home` alias is fine, it runs the capped buyers.
   One upgrade past the limit ends the attempt for this BitNode.
5. **Destroy BitNode 1.** The achievement appears when `w0r1d_d43m0n` goes down.
6. **Switch it off** once the BitNode is destroyed: `run /tools/set-config.js challenge clear`. Left on, it
   would cap home again the next time you play BitNode 1.

## What changes during the run

- Home starts at 32GB with Source-File 1 (8GB without), and is bought up to 128GB as usual.
- [`startup.js`](../startup.js) picks its stage from home RAM. The challenge lowers the "late" stage to
  128GB so its scripts (the stock trader and the Daedalus Go bot) still start; they wait if home is full.
- No extra cores means grow and weaken threads on home get no core bonus. Most batcher threads run on
  purchased servers, so the run should take about as long as a normal BitNode 1 run.

## If it goes wrong

If home passes 128GB or 1 core, it can't be undone in this BitNode. Finish the BitNode anyway and try again
on a later BitNode 1 run (with `bn1` still on).

How it works and why: [`docs/challenges.md`](../docs/challenges.md).
