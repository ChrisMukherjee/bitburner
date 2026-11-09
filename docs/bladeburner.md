# Bladeburner

[`../bladeburner/`](../bladeburner/README.md): `bb-manage.js` decides a state, `bb-pass.js` plays, and
[`../singularity/player-work.js`](../singularity/player-work.js) does the gym. Ported from an earlier standalone
set of scripts that had run in game.

## States

`bb-manage.js` decides from live state every 3 minutes and posts it on port 36:

| State | Meaning | Who has the player |
| --- | --- | --- |
| `off` | no Bladeburner API, or the division can't be joined | normal player-work |
| `boot` | start of a run: hacking 10 and income first (never longer than an hour into a run) | normal player-work |
| `train` | a combat stat is below 100 (the join requirement), e.g. after an install reset the stats | the gym, via player-work |
| `run` | stats ready, division joined | `bb-pass.js`; player-work starts nothing |
| `hold` | joined, but the route estimate says hacking is faster or Bladeburner isn't worth the time now; or not joined, waiting for Stanek's Gift (below) | normal player-work |

A state older than 15 minutes counts as `off`, so a stopped manager can't hold the player for ever.

## Why this shape

- **One owner of the player.** Any other work started during `run` cancels the Bladeburner action, and
  `bb-pass.js` would cancel it back 30 s later. So the gym is a step in player-work (which already owns
  study, factions and crimes), `run` makes player-work start nothing, and no second script touches the player.
- **State on a port, not files.** The original used files copied between servers. A port works from any server,
  so the one-shots can run wherever there is room (`bb-pass.js` is 57GB). One shared object (state, route
  estimate, rank samples, status lines) is patched by whichever one-shot runs; startup.js runs one-shots one at
  a time, so read-modify-write is safe.
- **One-shot passes.** The game keeps repeating the action between passes, so a pass only changes it when needed;
  no 53GB script waits idle.
- **Route estimate.** `node-eta.js` writes `plan` on the port (`route`, `hold`) and `bb-manage.js` follows it. Without one, `bladeburner.route` in the
  config decides (`"combat"` by default, `"hacking"` holds Bladeburner), so the choice can be made by hand.
- **Never "done".** player-work never reports done while the API is usable, since the manager may ask for the
  gym or the whole player later in the run.

## Skill points and the city

Both are computed from the live readings `bb-pass.js` posts (`actions` on the port), by the pure functions in
[`../bladeburner/picks.js`](../bladeburner/picks.js); the numbers are the game's own (v3.0.0 skill data and
`Action.getSuccessChance`), not a per-player table.

- **Skills.** The original bought Overclock up to level 90 (about 5,900 points) before any other skill, so the
  success-chance skills, Cyber's Edge and Hyperdrive got nothing for a long time, and Reaper and Evasive System were
  never bought. Now each skill is valued by the rank-rate gain of its next level (additive per level, so each level is
  worth less) and the best gain per point is bought; if it costs more than the points in hand the manager waits rather
  than buy a lesser one. Chance skills count only where the chance is not capped at 1; Reaper and Evasive System act
  through the combat stats each action weighs; Overclock (shorter actions) counts for the share of the time the player is
  not resting for stamina, Cyber's Edge for the share it is (`restShare`, a moving average `bb-pass.js` keeps);
  Hyperdrive for the chance left to gain. Rejected: a fixed order (it was the problem), and weighing by measured rank
  per hour (too slow and noisy to steer individual purchases). Before the first readings, or with
  `bladeburner.adaptiveSkills: false`, the old fixed tiers apply.
- **City.** A city's population multiplies the chance by `(pop / 1e9) ^ 0.7` and chaos above 50 divides it by
  `sqrt(1 + chaos - 50)`. `bb-pass.js` moves to the city that gives the best chance when the gain on the actions being
  played (with the cap at 1) beats the noise of its own estimates (the width of their ranges) plus 5 points, so a small
  difference never makes it hop. It moves at the end of a pass, since the readings belong to the city they were taken in.
  `bladeburner.switchCity: false` keeps the starting city.
- **Scouting.** While a safe action is played, a better one can be too uncertain to call (ranges like 7-95% when the
  population estimate is far off). `bb-pass.js` then runs Field Analysis (30 s, no stamina, improves the current city's
  population estimate by a couple of percent each) when an action that isn't safe yet has a higher expected rank rate than the best safe one
  and could still turn out safe (`scoutTarget`); as the estimate converges the action becomes safe or clearly not, and it stops.
  Without this it only analysed when nothing was safe, so a barely safe contract could be played for hours beside a
  far better operation. `bladeburner.fieldAnalysis: false` restores that.
- **Not done:** Recruitment and team assignment. They need three more API calls and risk casualties for about
  `(team + 1) ^ 0.05` on operations, so the gain per RAM is small.

## Stanek's Gift first

With Source-File 7 at level 3, joining the division installs The Blade's Simulacrum at once. Stanek's Gift can only be
accepted while every augmentation installed or bought is NeuroFlux Governor, so that join closes the Gift for the rest of
the BitNode. The game warns about this when you join by hand; `joinBladeburnerDivision()` doesn't (bitburner-src v3.0.0,
`src/CotMG/Helper.tsx`, `src/PersonObjects/Player/PlayerObjectBladeburnerMethods.ts`).

- **Decision.** With `bladeburner.stanekFirst` on, `bb-manage.js` doesn't join while the Gift is still open
  ([`../utils/stanek.js`](../utils/stanek.js): the church is there in BitNode 13 or with Source-File 13, and nothing but
  NeuroFlux Governor is installed). The state is `hold`, the gym waits too (the install that would close the Gift resets
  what it trained), and one notice per BitNode says how to go on: accept the Gift at the Church of the Machine God in
  Chongqing, or set `stanekFirst` to false. Once the Gift or any other augmentation is installed, the next pass joins.
- **Default.** On in BitNode 13 only (`bitnodes` in [`../config.js`](../config.js)), where the Gift is the point of the
  BitNode. Elsewhere the Simulacrum, which lets Bladeburner actions run alongside other work, is worth more than a Gift
  that no script here charges.
- **Tradeoffs.** It sees installed augmentations only (`getResetInfo().ownedAugs`; bought ones need the Singularity API),
  so after a purchase it waits on until the install. That is usually at once: the reset buys and installs together. An
  unattended first run of BitNode 13 with Source-File 7.3 plays no Bladeburner.
- **Rejected:** accepting the Gift automatically (Genesis alone multiplies nearly every stat by 0.9 until fragments are
  charged, and there are no Stanek scripts yet); waiting in every BitNode with Source-File 13 (each BitNode 12 run would
  lose its first run of Bladeburner for a Gift nobody charges).

## Ending the BitNode

All Black Ops done ends the BitNode without hacking w0r1d_d43m0n. `bb-pass.js` posts `blackOps: { done, time }`
when `getNextBlackOp()` finds none; `blackOpsDone` in `state.js` is true for an hour after that.
[`../singularity/auto-destroy.js`](../singularity/auto-destroy.js) then stops waiting for the daemon (Red Pill, hacking
level, root) and [`../singularity/next-bitnode.js`](../singularity/next-bitnode.js) destroys it straight away. This needs
the Singularity API too, as before.

## Route estimate

[`../bladeburner/node-eta.js`](../bladeburner/node-eta.js) (30GB at normal Singularity cost, a one-shot every 5 minutes) answers
"hacking or Bladeburner?" from live game state only, with the models in
[`../bladeburner/route-model.js`](../bladeburner/route-model.js). It walks both routes reset by reset: every installed aug keeps
its multiplier, skill exp restarts at each install, income and exp grow with the hacking multiplier. Income growth is
measured over earlier runs (`data/node-eta-history.json`, the one file, because it must survive resets) with a log-log fit that
is used only when it explains the data (3+ runs, R-squared 0.5+, slope under the cap of 3); otherwise three scenarios are shown
and the verdict uses the flat-income one. A slope at the cap means income grew for other reasons (RAM, servers) and the fit would
credit it to the multiplier, which makes hacking look far better than it is: a real history had x90 income for 7% more
multiplier. A reliable fit adds a flat scenario to the report for comparison. The Bladeburner side is scaled from the live readings of
`bb-pass.js` with the game's own formulas, and calibrated against the measured rank per hour. The readable report is
`data/node-eta.txt`; the verdict is `plan` on the port.

- **One route at a time.** The committed route changes only when the other is 25 % better by its own measure (hours when a
  scenario finishes, else the income it would need), since flipping wastes the gym time, rank and rep already spent.
- **No route before readings.** Until `bb-pass.js` has posted live action readings no route is written (the config route
  applies), otherwise "hacking" would hold Bladeburner and the combat route could never be measured.
- **Hold.** `plan.hold` is true when the best action's chance, rescaled to the current skills, is under 30 % (back above 40 %).
- Left out of the original: its combat-aug shopping plan (faction-goals and buy-augs already decide what to buy) and the
  long projected-multiplier report lines. `plan.trainTarget` is read by `bb-manage.js` but never written; the original did not
  write it either.
- Tradeoffs: the estimate is only as good as its inputs, and with no income measurement or exp rate it says "unknown" rather
  than guessing. Rejected: running it on home (it needs about 30GB for a moment); a resident script.

## Augment weights

The augment weights for the combat route follow the state by themselves (`routeAdjust` in
[`../utils/config.js`](../utils/config.js), see [`config.md`](config.md)); the `bladeburner` preset only forces them.
On the same condition `routeAdjust` turns off `resetRule.daedalusPush` and `daedalusFavor`: chasing the Daedalus invite (filler
augments, resets for favor) is a hacking-route plan and would spend resets the Bladeburner route doesn't need.

## What came from the standalone scripts

`bb-manage`, `bb-pass`, `node-eta` and `route-model` are ports (state on port 36 instead of files). The earlier city-faction
choice (`city-pass.js`) is merged into [`../singularity/workers/city-plan.js`](../singularity/workers/city-plan.js)
(groups ranked by augment value) and [`../singularity/player-work.js`](../singularity/player-work.js) (no group is picked
while the route is unsettled), see [`player-work.md`](player-work.md). Not carried over: `bb-hold.txt` and `bb-route.txt`
(now `plan` on the port), `node-ready.txt` (auto-destroy uses `blackOps` instead) and its debug text files
(`city-why.txt`, `bb-status.txt`: see `status` and `run /tools/debug-report.js`).
