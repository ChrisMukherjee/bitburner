# BN2: Challenge (no gang)

**What the game checks:** you destroy BitNode 2 while the player **has no gang** (`Player.gang === null`). Forming a gang sticks
until the BitNode ends (an install keeps it), so one `gang.createGang` anywhere in the run loses the attempt. The way out is
`w0r1d_d43m0n` or the Black Ops.

While the challenge is on, gangs are treated as not available: [`gang/gang-manager.js`](../gang/README.md) is not started, the
gang invite's crimes and gym are skipped ([`gang/workers/invite.js`](../gang/workers/invite.js), `gang.startInvite` off), and the
sleeves don't grind karma for it.

## Steps

1. **Before the BitNode 2 run starts** (any time earlier), in the game: `run /tools/set-config.js challenge bn2`. It applies from the
   start of the next BitNode 2 run; in a run that is still clean (no gang yet) `challenge bn2 --now` applies it at once. Check
   with `run /tools/set-config.js challenge`. Its settings only apply in BitNode 2.
2. **Enter BitNode 2** and let [`startup.js`](../startup.js) run first (it records the BitNode number).
3. **Play as normal.** Income comes from hacking, stocks and hacknet only; `status` shows `Challenge on: no gang`. Don't create a
   gang by hand (Gang tab).
4. **Destroy the BitNode** through `w0r1d_d43m0n` or the Black Ops. The achievement appears when it goes down.
5. **Nothing to clear.** When the next BitNode starts, `startup.js` takes `bn2` out of `challenges` by itself, so a later BitNode 2
   run plays with a gang again. To try again, set the challenge again before that run.

## If it goes wrong

If a gang was formed, the attempt is lost for this run; finish it, or `challenge clear` to carry on with the gang. Design:
[`docs/challenges.md`](../docs/challenges.md#forbidden-mechanics-bn2-bn3-bn6-bn7-bn10).
