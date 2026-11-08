# Gang

[`../gang/gang-manager.js`](../gang/gang-manager.js), with [`../gang/workers/equipment.js`](../gang/workers/equipment.js)
(port 29) and the invite step in [`../singularity/player-work.js`](../singularity/player-work.js)
(via [`../gang/workers/invite.js`](../gang/workers/invite.js), port 30). Settings are `gang` in
[`../config.js`](../config.js).

It was written against the v3.0.0 Gang API; every decision is logged, so tail it and tune `gang` in the config if
something looks off.

## Decisions

- **Combat gang by default (Slum Snakes).** The faction decides the gang type for good. Combat gangs make
  more money and win territory clashes more easily. The cost is getting the invite: in BitNode 2 karma -9
  and combat 30. A hacking gang (NiteSec, The Black Hand) needs no crimes but earns
  less. The choice is `gang.factions`.
- **The invite also runs in the start stage** (`gang.startInvite`): player-work.js needs a 64GB home, so waiting for it delayed the gang. [`../singularity/player-work-start.js`](../singularity/player-work-start.js) hands over to [`../singularity/workers/start-gang.js`](../singularity/workers/start-gang.js) (10.25GB, for a moment) before port openers and cash crimes: Homicide for the karma, the gym for the combat stats, then cash crime for the $1m. The gang manager starts once the faction is joined (it may run on a server when home is small). Rejected: buying 64GB first (costs cash the invite also needs, and the gang earns more), and a 16GB invite helper in the start pass.
- **The invite is a player-work step**, not its own script, because only player-work moves the player
  (see [`player-work.md`](player-work.md)): the crime with the most expected karma per minute (Homicide)
  for the karma, then the gym for the combat stats.
- **Best task by the game's formula.** Each member's task is scored from `ns.gang.getTaskStats` (stat weights
  x member stats minus 4 x difficulty, times base respect or money, times a territory factor for the
  land-dependent tasks), so no Formulas.exe is needed and no task is tried out. The formula comes from a
  gang script that has run in game; it replaced an earlier "try each task and read the gain back" version
  that assumed the gains update right after `setMemberTask`.
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
