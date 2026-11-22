# BN10: Challenge

**What the game checks:** you destroy BitNode 10 while **no sleeve holds an augmentation or any experience**
(hacking, strength, defense, agility, dexterity, charisma). It is checked once, when `w0r1d_d43m0n` is destroyed
(a scripted destroy counts too). Owning sleeves is fine, so the Covenant's sleeves can still be bought. Experience and
augmentations are wiped only when a BitNode ends (installing augmentations keeps them), so anything a sleeve
gains **during the run** counts against you, and the setting must be on from the start of the run.

The scripts do the run by themselves: one setting stops the sleeve manager giving jobs and the shop buying sleeve
augmentations, in BitNode 10 only. The shop still buys sleeves and memory, and the BitNode is still held open for a
Covenant sleeve worth the wait ([`../docs/sleeves.md`](../docs/sleeves.md#holding-bitnode-10-for-the-covenants-sleeves)).

## Which run

Any one BitNode 10 destroy counts, so pick the run where giving up sleeves costs least: **BitNode 10.1**, the first
(one sleeve, income at its lowest, a Covenant sleeve unlikely). The later runs are where sleeves speed up karma,
Bladeburner and rep. The challenge needs SF6 for the Black Ops way out, as the plan has it. If 10.1 is gone, the next
cheapest is the next run, and so on: the cost grows by one idle sleeve per run. (For comparison, the BN1 challenge goes on
the second BitNode 1 run, [`bn1-challenge.md`](bn1-challenge.md).)

## Steps

1. **Before the run starts** (any time earlier, for example during BitNode 10.1 for the 10.2 run; it applies from the start of the next
   run, and `challenge bn10 --now` applies it at once in a run where no sleeve has worked yet):

   ```text
   run /tools/set-config.js challenge bn10
   ```

   Check with `run /tools/set-config.js challenge`. The sleeve manager and shop read it on their next pass (every minute).
2. **Play as normal.** Sleeves stay idle; with `status` the sleeve line says no sleeves yet or shows nothing.
3. **Check before destroying** if you are unsure a sleeve worked earlier in this run (for example the setting went on late):
   a sleeve's experience is in `ns.sleeve.getSleeve(i).exp` and its augmentations in `ns.sleeve.getSleeveAugmentations(i)`.
   Any non-zero value cannot be undone in this run; then leave the challenge for the next BitNode 10 run.
4. **Nothing to clear.** When the next BitNode starts, `startup.js` takes `bn10` out of `challenges` by itself (and says so), so the next BitNode 10 run uses its sleeves. To try again, set it again before that run.

Rule and settings: `CHALLENGES.bn10` in [`../config.js`](../config.js) (`forbid: ["sleeves"]`); design: [`../docs/challenges.md`](../docs/challenges.md#forbidden-mechanics-bn2-bn6-bn7-bn10).
