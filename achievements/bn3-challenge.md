# BN3: Challenge (no corporation)

**What the game checks:** you destroy BitNode 3 while the player **has no corporation** (`Player.corporation === null`). A
corporation sticks until the BitNode ends (an install keeps it), so one `corporation.createCorporation` anywhere in the run loses
the attempt. The way out is `w0r1d_d43m0n` or the Black Ops.

While the challenge is on, corporations are treated as not available: [`corp/corp-manager.js`](../corp/README.md) is not started
and, if started by hand, prints one line and stops without creating one.

## Steps

1. **Before the BitNode 3 run starts** (any time earlier), in the game: `run /tools/set-config.js challenge bn3`. It applies from the
   start of the next BitNode 3 run; in a run that is still clean (no corporation yet) `challenge bn3 --now` applies it at once.
   Check with `run /tools/set-config.js challenge`. Its settings only apply in BitNode 3.
2. **Enter BitNode 3** and let [`startup.js`](../startup.js) run first (it records the BitNode number).
3. **Play as normal.** Hacking in BitNode 3 pays little, so a gang or Bladeburner carries the run; `status` shows
   `Challenge on: no corporation`. Don't create a corporation by hand (City -> Sector-12 -> City Hall).
4. **Destroy the BitNode** through `w0r1d_d43m0n` or the Black Ops. The achievement appears when it goes down.
5. **Nothing to clear.** When the next BitNode starts, `startup.js` takes `bn3` out of `challenges` by itself, so a later BitNode 3
   run gets its corporation again. To try again, set the challenge again before that run.

## If it goes wrong

If a corporation was created, the attempt is lost for this run; finish it, or `challenge clear` to let the manager run it. Design:
[`docs/challenges.md`](../docs/challenges.md#forbidden-mechanics-bn2-bn3-bn6-bn7-bn10).
