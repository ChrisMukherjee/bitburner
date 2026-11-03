# Bladeburner

[`../bladeburner/`](../bladeburner/README.md): `bb-manage.js` decides a state, `bb-pass.js` plays, and
[`../singularity/player-work.js`](../singularity/player-work.js) does the gym. Ported from the other player's
scripts, which have run in game; the port itself has not.

## States

`bb-manage.js` decides from live state every 3 minutes and posts it on port 36:

| State | Meaning | Who has the player |
| --- | --- | --- |
| `off` | no Bladeburner API, or the division can't be joined | normal player-work |
| `boot` | start of a run: hacking 10 and income first (never longer than an hour into a run) | normal player-work |
| `train` | a combat stat is below 100 (the join requirement), e.g. after an install reset the stats | the gym, via player-work |
| `run` | stats ready, division joined | `bb-pass.js`; player-work starts nothing |
| `hold` | joined, but the route estimate says hacking is faster or Bladeburner isn't worth the time now | normal player-work |

A state older than 15 minutes counts as `off`, so a stopped manager can't hold the player for ever.

## Why this shape

- **One owner of the player.** Any other work started during `run` cancels the Bladeburner action, and
  `bb-pass.js` would cancel it back 30 s later. So the gym is a step in player-work (which already owns
  study, factions and crimes), `run` makes player-work start nothing, and no second script touches the player.
- **State on a port, not files.** The original used files copied between servers. A port works from any server,
  so the one-shots can run wherever there is room (`bb-pass.js` is 53GB). One shared object (state, route
  estimate, rank samples, status lines) is patched by whichever one-shot runs; startup.js runs one-shots one at
  a time, so read-modify-write is safe.
- **One-shot passes.** The game keeps repeating the action between passes, so a pass only changes it when needed;
  no 53GB script waits idle.
- **Route estimate is an input, not part of this folder.** `plan` on the port (`route`, `hold`, `trainTarget`)
  lets an estimate say "hacking is faster, hold" or "train longer first". Without one, Bladeburner is the route.
- **Never "done".** player-work never reports done while the API is usable, since the manager may ask for the
  gym or the whole player later in the run.

## Not done

- The route estimate (`node-eta`) is still to be ported; until then `plan` is never written.
- Augment weights for the combat route are the `bladeburner` preset in [`../config.js`](../config.js), picked by hand
  with `"profile": "bladeburner"`; nothing switches it from the state yet.
