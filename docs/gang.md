# Gang

[`../gang/gang-manager.js`](../gang/gang-manager.js), with [`../gang/workers/equipment.js`](../gang/workers/equipment.js)
(port 29) and the invite step in [`../singularity/player-work.js`](../singularity/player-work.js)
(via [`../gang/workers/invite.js`](../gang/workers/invite.js), port 30). Settings are `gang` in
[`../config.js`](../config.js).

**Untested in game.** It was written against the v3.0.0 Gang API before reaching BitNode 2. Tail it on
the first run and tune; every decision is logged.

## Decisions

- **Combat gang by default (Slum Snakes).** The faction decides the gang type for good. Combat gangs make
  more money and win territory clashes more easily. The cost is getting the invite: in BitNode 2 the player
  commits crimes for karma and combat stats. A hacking gang (NiteSec, The Black Hand) needs no crimes but earns
  less. The choice is `gang.factions`.
- **The invite is a player-work step**, not its own script, because only player-work moves the player
  (see [`player-work.md`](player-work.md)).
- **Best task by trying.** Each member's task is picked by trying each one and reading back the gain, so no
  Formulas.exe is needed. This is the assumption most likely to need checking in game.
- **Respect until full, then money.** Members train to `trainLevel`, ascend at a 1.5x multiplier gain, and
  the weakest earners cool the wanted level when its penalty passes 5%.
- **Territory:** with a full gang, half the trained members build power; clashes go on at 55% win chance
  against every gang with territory and off below 50% (the gap stops flapping).
- **Equipment:** augmentations first since they survive ascension, within the `gang.buying` spending stages.
- **Started only when useful.** [`../startup.js`](../startup.js) starts it once
  [`../gang/ready.js`](../gang/ready.js) says a gang exists or a gang faction is joined and a gang can be created,
  so its RAM isn't held while waiting for the invite.
- **No BitNode-number checks.** Whether the Gang API works and whether a gang needs karma -54,000 (everywhere
  but BitNode 2) is decided once, in [`../utils/gang.js`](../utils/gang.js). The manager posts ready-made status
  lines on port 28, so [`../tools/status.js`](../tools/status.js) knows nothing about gangs.

## Open

In BitNode 2 the gang faction sells almost every augment, so faction-work order and aug buying may want a
gang-aware tweak.
