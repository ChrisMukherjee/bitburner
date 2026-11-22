# BN6: Challenge and BN7: Challenge (no Bladeburner division)

**What the game checks:** you destroy BitNode 6 (or 7) while the player has **never joined the Bladeburner division** in
that run. It is checked once, when `w0r1d_d43m0n` is destroyed (a scripted destroy counts too). Joining sticks until the
BitNode ends: an augmentation install keeps the division, so one join anywhere in the run, even for a minute, loses the
attempt. The two achievements are the same rule, one per BitNode, and both need the way out to be `w0r1d_d43m0n` (the
Black Ops can't be done without the division).

The scripts do this run by themselves: while the challenge is on, Bladeburner is treated as not available, so nothing
joins it, nothing trains the combat stats for it, and the route is hacking (Daedalus, The Red Pill, `w0r1d_d43m0n`).

## Before you start

- **Name it before the run you want it for.** It applies from the start of the next run of that BitNode (so you can set it in
  the run before, or any time earlier), because a run that has already joined the division can't win it. If you are in a run that
  is still clean, `challenge bn6-7 --now` applies it at once; if you have joined, leave it for the next run.
- **Expect a long hacking run.** BitNode 6 and 7 cut the hacking level multiplier to 35%, so the daemon needs about
  6,000 hacking ([`docs/bitnode-order.md`](../docs/bitnode-order.md#challenge-achievements)). The scripts' hacking route
  handles it (faction work, the aug reset rule, `auto-destroy.js`); it just takes longer than Bladeburner would. Any level of
  the BitNode counts (6.1 to 6.3, and extra runs), so do it where hacking is strongest.
- **Source-Files stay valid.** Source-File 6 and 7 still give their bonuses; the achievement only needs the division not joined.

## Steps

1. **Before the run starts** (any time earlier), in the game:

   ```text
   run /tools/set-config.js challenge bn6-7
   ```

   (`challenge bn6` or `challenge bn7` for one of them.) This adds the names to `challenges` in `data/config.json`. Their
   settings only apply in their own BitNode. Check with `run /tools/set-config.js challenge`.
2. **Enter the BitNode** as usual and let [`startup.js`](../startup.js) run first, since it records the BitNode number.
3. **Play as normal.** `status` shows `Challenge on: no Bladeburner division`. `bb-manage.js`, `bb-pass.js` and `node-eta.js`
   are not started; [`player-work.js`](../singularity/player-work.js) goes for faction rep instead of the gym for Bladeburner. Don't
   join the division by hand (Bladeburner tab, the Bladeburner city location).
4. **Destroy the BitNode** through `w0r1d_d43m0n` ([`auto-destroy.js`](../singularity/auto-destroy.js) does it once The Red Pill
   is installed and hacking allows). The achievement appears when it goes down.
5. **Nothing to clear.** When the next BitNode starts, `startup.js` takes that BitNode's challenge out of `challenges` by itself
   and says so, so a later run plays Bladeburner again. To try again, run the `challenge` command again before that run.

## If it goes wrong

If the division was joined, the attempt is lost for this run; finish the BitNode (or `challenge clear` to use Bladeburner) and
try again on a later run of it. How it works and why: [`docs/challenges.md`](../docs/challenges.md#forbidden-mechanics-bn2-bn3-bn6-bn7-bn10).
