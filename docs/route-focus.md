# Route focus

[`../utils/route-focus.js`](../utils/route-focus.js), worked out by [`../singularity/player-work.js`](../singularity/player-work.js) every
pass and posted on port 44. It makes the scripts that share the player, the sleeves and the spare RAM agree on what the way out of
the BitNode needs most *right now*, instead of each pursuing its own goal.

## The problem

On the hacking route (Daedalus' invite, The Red Pill, w0r1d_d43m0n) the wait is a number: hacking 2,500 for the invite, then Daedalus
rep, then hacking 6,000 for the daemon. Several scripts each had a good local reason to do something else meanwhile:

- **Share vs the XP farm.** During faction work share-manager took all the spare RAM and the XP farm stood down. The farm is the
  main hacking-exp source once there is RAM to spare (its weaken threads pay exp each; faction hacking work pays the player 2 exp a
  second at base), so the level the route waited for grew slowest exactly while the player did faction work.
- **The gang invite.** player-work.js put the invite's crimes and gym before faction work, and the sleeves went to the gym (combat 30)
  or to Homicide for the same invite, while the gang's money and rep unlock nothing on this route.
- **Faction order.** The first joined faction in `factionWork.order` with a goal was worked, whatever its augments were worth.

## Decision

`routeFocus` reads the phase from the game's own numbers (no BitNode number, nothing per player):

| Phase | When | Spare RAM | Side quests (gang invite, sleeve combat/karma) | Faction pick |
| --- | --- | --- | --- | --- |
| `level` | hacking route, Daedalus not joined, its invite (`getFactionInviteRequirements`, from `data/aug-plan.json`) lacks only hacking level (cash may still be coming) | XP farm | wait | most augment value per missing rep |
| `rep` | Daedalus joined, The Red Pill not installed | share (faster Red Pill rep) | wait | config order (Daedalus first) |
| `daemon` | The Red Pill installed, hacking below w0r1d_d43m0n's level | XP farm | wait | most augment value per missing rep |
| `none` | anything else: combat route, no route known, invite needs unknown, installed augments missing (the reset rule's job), the kill switch | as before | as before | config order |

"Hacking route" is the route estimate's verdict (`plan.route` on port 36), else the config route where Bladeburner exists, else hacking
(without Bladeburner it is the only way out). The invite's alternatives (`someCondition`) are read for the hacking one, since this
route does not train the combat stats.

Consumers read the post at 0GB and treat nothing posted, or a post older than ten minutes, as `none`, so a run without the Singularity
API, a stopped player-work.js or the kill switch (`routeFocus.enabled: false`) leaves every script as it was:

- [`../hack/xp-farm.js`](../hack/xp-farm.js) and [`../share/share-manager.js`](../share/share-manager.js) use one rule,
  `spareRamGoesToShare`, so they never both idle or both run: share keeps the RAM during faction work unless hacking exp binds and the
  farm is running. `share-manager --always` ignores it.
- [`../sleeves/plan.js`](../sleeves/plan.js) drops the gang invite's combat training and Homicide (`gangInviteOpen`).
- player-work.js skips the gang invite's steps and picks the faction with the highest `value` per missing rep. The goals helper
  ([`../singularity/workers/faction-goals.js`](../singularity/workers/faction-goals.js)) posts `value`, the summed `augValue` (the reset
  rule's value, already weighted by the route) of the augments it picked there.

## Tradeoffs and rejected alternatives

- **Study instead of faction work in the level phase.** Rejected: the player's own exp is small next to the farm's, and faction rep buys
  the augments the next install multiplies hacking by. The fix is to stop the farm losing RAM, not to move the player.
- **Skipping the gang in every phase but `none`.** The gang is dropped from the first moment the route has a clear next step, until the
  BitNode ends. That trades the gang's income and rep for the route's time; the cash is rarely what binds there (the invite's money is
  part of the phase test: a missing installed-augment count or any other need puts the phase back to `none`).
- **Sleeves for hacking exp.** Sleeve exp does not reach the player's own levels except through synchronization, so nothing is done there.
- **Per-script switches.** Rejected: one setting, `routeFocus.enabled` (default on), turns all of it off.

## Current state

Written for the hacking route only. A combat (Bladeburner) route has no phase yet: its focus is `bladeburner/bb-manage.js`' state, which
player-work.js and the sleeves already follow. Tests: [`../tests/route-focus.test.mjs`](../tests/route-focus.test.mjs).
