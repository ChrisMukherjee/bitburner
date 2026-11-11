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
  estimate, rank samples, efficiency figures, status lines) is patched by whichever one-shot runs; startup.js runs one-shots one at
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
- **Black Ops.** The Contracts and Operations being played are often capped at 100 % long before the Black Ops are safe: the
  Black Ops have difficulty 2,000 (Typhoon) up to 80,000 (Daedalus), against 125-1,500 for a Contract or Operation, and all
  21 are needed to end the BitNode. Valuing skills only by the actions played would stop buying chance skills exactly when the
  last Black Ops need them. So `bb-pass.js` posts the next Black Op (`actions.blackOp`: name, required rank, low chance) and
  [`skillValues`](picks.js) blends its chance gain into every skill's value with `blackOpWeight`: 0 when the Black Op is
  already safe (low estimate 80 % or more), the share of the required rank already held (0..1) otherwise, so it takes over
  as the rank gate approaches and fully once the rank is there and only the chance is missing. Only the skills that apply to a
  Black Op count (Blade's Intuition, Digital Observer, Cloak for stealth ones, Short-Circuit for the killing ones, Reaper and
  Evasive System through the Black Op's own stat weights; Tracer, Overclock and Cyber's Edge are worth nothing to its
  chance). The Black Op ignores the city's population and chaos, so the city choice is untouched. Kill switch:
  `bladeburner.blackOpSkills: false` (only the Contracts and Operations count).
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
  far better operation. `bladeburner.fieldAnalysis: false` restores that. Scouting takes at most a fifth of the passes (a moving
  share, `scoutShare` on port 36); past that the safe action plays. Uncapped, a BitNode 6 start with low stats spent all its time on
  Field Analysis (the estimate barely moved) while 1,266 safe counts waited: 12 rank an hour, 8 % of the ceiling.
- **The Black Op gate and the team:** see [The Black Op gate and the team](#the-black-op-gate-and-the-team) below.

## The Black Op gate and the team

[`../bladeburner/team.js`](../bladeburner/team.js) (pure, 0GB) decides when to attempt the next Black Op, how many team members
go on it and when to recruit. The numbers are the game's own (v3.0.0): a team multiplies the chance by `(members + 1) ^ 0.05`
(20: x1.16, 100: x1.26); a Black Op with a team kills a whole number of members drawn evenly from 1 to `ceil(team / 2)` on a
win and 1 to the whole team on a loss; a failure costs the Black Op's fixed rank loss (10 for Typhoon up to 20,000 for
Vindictus) and `hpLoss x (difficulty ^ 0.28 + difficulty / 650)` damage, which hospitalises the player at 0 HP for
(HP missing) x $100k, at most 10 % of the cash; Recruitment succeeds with `charisma ^ 0.45 / (team + 1)`, costs no stamina and
takes `300 - (charisma ^ 0.81 + charisma / 90)` seconds (at least 10).

- **One currency.** Everything is priced in seconds of the player's rank flow (the measured rank per second, or the best safe
  action's): an attempt's time, the rank a failure loses, the members it kills (each at the seconds a replacement takes to
  recruit) and the hospital bill (over the income per second). Time is weighted by the share of passes where it earns rank:
  `freeShare` (port 36) is the moving share of passes where every safe action's counts were used up, and that time is
  nearly free. The expected cost of getting a Black Op done is the win's cost plus `(1 - p) / p` failures.
- **When to attempt (`bladeburner.blackOpGate`).** At the old 80 % line it always goes (`safe`). Below it, it goes when the
  expected cost is below the rank the Black Op gives (`pays`; nearly always true while the counts are used up). Otherwise it
  asks what holds the BitNode back. While rank is the limit (the rank the Black Op after this one needs is further away than
  this one would take), waiting costs nothing: the time goes to rank and the chance grows (`rank`). Once the Black Op is the
  limit (or it is the last one), every second of waiting delays the end, and waiting only pays while the chance grows fast
  enough: minimising `w + cost(p + g w)` gives "attempt once `p >= sqrt(failure cost x g)`" (`chain`; otherwise
  `growing`), with `g` the measured growth of the no-team chance (one sample per 5 minutes over 2 hours, `blackOpTrend`).
  Until half an hour of samples exists it waits (`measuring`). A Black Op already under way is never abandoned.
- **The team (`bladeburner.team`).** `bb-pass.js` picks the team size that minimises the cost (`teamPlan` on port 36) and
  `bb-manage.js` sets it on the Black Op with `setTeamSize` (posting `team`: size and assignment). When members are free to
  replace (time is free) the whole team goes; when each costs minutes of rank, a x1.16 chance does not pay for the members a
  failure kills, and none go. `bb-pass.js` recruits while the counts are used up (ahead of the risky and filler actions) when a
  member lowers the next Black Op's cost, and otherwise only when a member saves the Black Op more seconds than recruiting takes.
- **Operations get no team.** An Operation with a team loses 0 to `ceil(team / 2)` members per win and is played hundreds of
  times, so the replacements cost far more than a x1.16 chance on actions that are mostly capped anyway.
- **Kill switches.** `bladeburner.blackOpGate: false` attempts only at 80 % (as before); `bladeburner.team: false` never
  recruits and leaves the assignment alone.
- **Tradeoffs.** The member value counts only the next Black Op, though members who survive serve the later ones too (it
  under-recruits a little). The trend can mistake a jump in the population estimate for growth (Field Analysis settles it).
  The failure bill assumes the average damage. bb-manage.js applies the plan every 3 minutes, so a team grown by recruiting
  goes on the Black Op up to 3 minutes later. RAM: `getTeamSize` and `setTeamSize` (4GB each) sit in bb-manage.js so bb-pass.js,
  the largest one-shot, grows only by the income read (0.1GB).
- **Rejected:** a lower fixed line (40 % has a positive expected rank, but ignores a failure's members, hospital bill and
  whether waiting even costs anything); valuing members by the chance they add alone (ignores that a Black Op kills at least
  one per attempt).

## Mechanics and what the scripts do with them

Read from the v3.0.0 source (`src/Bladeburner/`), checked against what `bb-manage.js` and `bb-pass.js` call. "Impact" is how
much play is left on the table.

| Mechanic (v3.0.0) | Handled by | Status / impact |
| --- | --- | --- |
| Contracts and Operations: chance, rank gain, time, level, count | `bb-pass.js` reads all of them each pass, plays the best chance x gain / seconds among the safe ones | Handled. Actions with no count left are no longer planned on (the game stops them and the player idled until the next pass) |
| Action count: -1 per attempt (win or lose), grows by the table's average per 480 s, no cap | Read per action; `route-model.js` models it | Handled for choosing; it is the **late-game limit** (see "Measuring"): about 0.05 counts a second across all nine actions |
| Action level (`autoLevel` on: level = max level, which rises with successes) | Read (`level`, `maxLevel`); the game's default keeps the highest level | Not steered. `setActionLevel` could trade reward for chance, but reward grows faster than difficulty, so the default is right whenever the chance holds. Open: the 60 % safety gate can exclude an action whose autolevel difficulty pushed it just under; a lower level would be safe |
| Success chance: stats^decay, skills, stamina below 50 %, population^0.7, chaos above 50, team | `picks.js` (skills, city), stamina rest below 55 %, `team.js` (team on Black Ops) | Handled |
| Stamina: cost per action, regeneration, Hyperbolic Regeneration Chamber | Rest below 55 % until 90 %; `ideal.js` models the budget | Handled; now measured |
| City: population, chaos, communities (Raid needs one), random events | `pickCity` moves for a clear gain; Diplomacy only when nothing is safe and chaos is above 10 | Handled. Communities and the pop loss from Raid (-1 % per win) are not modelled; a Raid with no community shows 0 % and is skipped |
| Black Ops: 21 in order, rank gates, difficulty 2,000-80,000, no city effect, 1.5x time, rank loss and damage on failure | `team.js` gate: always at 80 %, earlier when it pays or holds the BitNode back; skills weigh their chance | Handled |
| Skills: 12; chance, stat, time, stamina, exp, money, estimate | 10 of 12 (Hands of Midas and Datamancer ignored on purpose) | Handled |
| Field Analysis (no stamina, +0.1 rank, sharpens the population estimate) | Used to scout and as a fallback | Handled |
| Training (30 s, combat exp, +stamina bonus), Diplomacy (chaos), Hyperbolic Regeneration Chamber | Fallbacks and rests | Handled |
| Recruitment (team size) and `setTeamSize` per action | `team.js`: recruits while counts are used up (or when it saves the Black Op more than it takes); the cheapest team size goes on the Black Op | Handled for Black Ops; Operations get no team on purpose (see above) |
| Incite Violence (new in v3: +3 minutes of count growth for every action; chaos +10 and more in every city) | Not used | Correctly ignored: chaos only falls by about 0.36 an hour (Diplomacy takes about 1.5 % of it per minute), and above 50 it divides every chance by `sqrt(1 + chaos - 50)` |
| Sleeves: support (team members that survive), Infiltrate Synthoids (counts) | No sleeve scripts yet | Out of scope here; counts are the late-game limit, so infiltrating sleeves are the lever to add with the sleeves folder |
| Bonus time (`getBonusTime`), `nextUpdate`, automate console | Not used | Not relevant to a one-shot pass design |
| BitNode multipliers: `BladeburnerRank` (every rank gain; 0 = no division), `BladeburnerSkillCost`, combat level multipliers | Live readings already include them; before readings the route estimate's first guess uses the saved multipliers (Source-File 5), and rank 0 means no Bladeburner | Handled (see "Route estimate") |
| Rank, skill points (1 per 3 rank), Bladeburners faction (rank 25), rank to rep | Skill points spent by `bb-manage.js`, which also joins the faction as soon as the rank allows (the game joins by itself only at an install, and rep only grows while a member) | Handled |
| Stanek's Gift vs The Blade's Simulacrum | `bladeburner.stanekFirst` | Handled (below) |
| The Blade's Simulacrum (Bladeburner actions alongside other work) | Bought first and installed at once on this route; `player-work.js` then works alongside | Handled (below) |

Open items: lowering an action's level when that alone makes it safe; counting the later Black Ops in a member's value.

## Progress toward ending the BitNode

The `status` BitNode block says how far each way out is, so the player doesn't have to piece it together from the logs. The active
route (`plan.route`, the verdict of [`node-eta.js`](../bladeburner/node-eta.js)) is spelled out and the other is one line; with no
verdict yet both are spelled out, under a line saying what the player does meanwhile: `bb-manage.js` follows `bladeburner.route`
(combat by default), so Bladeburner starts (hacking 10 and income, the gym, then actions) to get the live readings the estimate
needs, and the faster route takes over once it has them. "Not chosen yet" read as if nothing was decided while the gym was
already running. The wording lives in [`utils/route-progress.js`](../utils/route-progress.js).

- **Hacking route:** Daedalus (installed augs against the invite's count, cash, hacking level or combat stats, each with what the player
  has), The Red Pill (Daedalus rep against its requirement with an ETA, then bought, then installed), `w0r1d_d43m0n` (hacking level
  against its requirement, and root). Before the Red Pill is installed the server doesn't exist, so the requirement is the
  `daemonLevel` that `node-eta.js` posts in `plan`, or, while there is no fresh estimate (a new run, and the `status` that
  `startup.js` prints when typed by hand), the same value from `daemonLevelFor(node)` in `route-progress.js` (3000 x the
  BitNode's difficulty; `node-eta.js` uses that function too). So the line reads the same with or without an estimate; only
  BitNode 12, which isn't tabled, says the level is unknown until the server appears.
- **Bladeburner route:** Black Ops done of the total, rank against Operation Daedalus' 400,000, the next Black Op with its rank
  requirement and chance, and a note when the route is on hold. `bb-pass.js` posts these as `progress` on port 36 (the Black Ops run in
  order, so the next one's position is the count done). Operation Daedalus is the last, so it is done when all are.
- **Without Bladeburner access** (no BitNode 6/7, no Source-File 6/7) only the hacking lines show, with no route labels; without
  Singularity the rep and Red Pill lines say what's missing. `status.routeProgress: false` in the config goes back to the hacking lines only.

Rejected: calling the Bladeburner API from `status` (several GB more RAM for a screen that should stay cheap); `bb-pass.js` posts it instead.

## Measuring how well it plays

`bb-pass.js` posts an efficiency figure with every pass that reads the actions, from [`ideal.js`](../bladeburner/ideal.js), and
the status block shows it as one line under the rank line:

`efficiency: 1840 rank/h of at most 2900 (63%), limited by count; idle 12%, stamina under 50% 3%; 8 safe counts banked; rank 400k in ~97 h if this rate held (eta models the growth)`

- **rank/h measured** is the rank gained over the last hour of samples (`rank` on port 36), shown once the samples span 15 minutes
  (`MIN_RATE_SPAN_MS`; `node-eta.js` and the Black Op hold in `buy-augs.js` use the same minimum). One success is worth up to
  ~55 rank early on, so a two-minute window read 1,967/h in a run averaging ~110/h. **at most** is the ceiling below.
- **The ceiling** is the best any play could do right now, from the live readings and the game's formulas: maximise
  `sum(chance x gain x attempts/s)` over the nine Contracts and Operations subject to (a) one action at a time, (b) stamina,
  where an attempt costs `0.285 x (d^0.28 + d/650)`, regeneration is `(0.0085 + max/70000) x agility^0.17` (with Reaper, Evasive
  System, Cyber's Edge and the player's stamina multiplier) and resting adds 1 % of the maximum a minute, and (c) counts, which
  grow by the table's average per 480 s, plus the counts already banked spread over the hour the rate is measured on. Without the
  bank the ceiling was the long-run rate with no counts saved up, and a player working off thousands of banked counts measured
  above it (322 %). It is a small linear program solved through its dual (a nested ternary search on a convex
  function), so no solver is needed. Failures, Black Ops and the 0.1 rank of a Field Analysis are not in it.
- **limited by** says which resource, if lifted alone, would raise the ceiling most: `count` (the supply of counts: the usual
  late-game answer once the bank is spent), `time` (long actions, or many counts banked) or `stamina` (short, cheap actions, or a
  small stamina pool early on).
- **rank 400k in ~N h** is a straight line at the measured rate. It ignores what grows (skills, action levels, stats, augs), so it
  reads long early in a BitNode; `data/node-eta.txt` (alias `eta`) models that growth and is the estimate to plan by.
- **idle** is the share of passes that found no action running (the game stops one when its count runs out, a Black Op ends, or
  stamina hits 0), **stamina under 50 %** the share of passes below the level where every chance is cut, **banked** the counts
  waiting on safe actions.

What a good run looks like, and what to do about a bad one:

| You see | Meaning | Look at |
| --- | --- | --- |
| Efficiency 85-100 %, limited by count | Playing at the game's limit; only more counts (sleeves, levels), chance or a team can add | Nothing to fix in the scripts |
| Efficiency low, banked counts high | The clock is the limit but the player isn't using it: idle or resting too much | `idle`, `restShare`, the 30 s pass cadence against very short actions |
| Efficiency low, idle high, banked near 0 | Counts ran out and the player waits for the next pass | A faster pass while counts are scarce |
| Stamina under 50 % above a few percent | Rest threshold too low for the action length | `REST_BELOW` in `bb-pass.js`, Cyber's Edge |
| Black Op "waits (rank)" | Rank for the Black Op after it is still further off; the time goes to rank | Nothing: it goes once that rank is near |
| Black Op "waits (growing)" or "(measuring)" for hours | The chance, not rank, holds the BitNode back, and it is still rising fast | Chance skills (steered by the Black Op), the team, stat gains; with `blackOpGate: false` it waits for 80 % |

Rank per hour while a Black Op is being attempted includes its jumps (+50 up to +40,000), so read the trend over a few hours.
Besides the line, port 36 keeps `perf` (the latest figures, regeneration, the three best actions by rank per count) and
`perfLog` (one entry an hour, the last 48: rank, measured, ceiling, limiter, idle, banked). `run /tools/debug-report.js` shows
the efficiency line under the last pass of `bb-pass.js`, and `--full` prints port 36 with `perf` and `perfLog`. Time to the end of the BitNode is the larger of the time to rank 400,000 at the measured rate
and the time the Black Op chances need; the line gives the first, `data/node-eta.txt` the route comparison.

Sanity numbers from the formulas, for judging a report: counts grow at about 0.05 a second over all nine actions, and a count is
spent per attempt win or lose, so the count-bound ceiling is roughly `sum(regen x chance x gain)`: about 1,700 rank an hour at action levels of 1
(Raid alone is 0.24 a second), and several times that once the high-reward actions (Raid 1.10, Assassination 1.14 a level) have levelled
up. Levels need successes (about `L^2 / 2` for level L), so they are the slow compounding term in a count-bound run.

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

[`../bladeburner/node-eta.js`](../bladeburner/node-eta.js) (31GB at normal Singularity cost, a one-shot every 5 minutes) answers
"hacking or Bladeburner?" from live game state only, with the models in
[`../bladeburner/route-model.js`](../bladeburner/route-model.js). It walks both routes reset by reset: every installed aug keeps
its multiplier, skill exp restarts at each install, income and exp grow with the hacking multiplier. Income growth is
measured over earlier runs (`data/node-eta-history.json`, the one file, because it must survive resets) with a log-log fit that
is used only when it explains the data (3+ runs, R-squared 0.5+, slope under the cap of 3); otherwise three scenarios are shown
and the verdict uses the flat-income one. A slope at the cap means income grew for other reasons (RAM, servers) and the fit would
credit it to the multiplier, which makes hacking look far better than it is: a real history had x90 income for 7% more
multiplier. A reliable fit adds a flat scenario to the report for comparison. The Bladeburner side is scaled from the live readings of
`bb-pass.js` with the game's own formulas (a first guess from the formulas and the BitNode's multipliers before there are
any, below), and calibrated against the measured rank per hour. The readable report is
`data/node-eta.txt` (alias `eta`); the verdict is `plan` on the port.

- **One route at a time.** The committed route changes only when the other is 25 % better by its own measure (hours when a
  scenario finishes, else the income it would need), since flipping wastes the gym time, rank and rep already spent.
- **No route before readings, except a clear first guess for hacking.** Until `bb-pass.js` has posted live action readings
  no measured route is written (the config route applies), otherwise "hacking" would hold Bladeburner and the combat route could
  never be measured. Measuring costs the gym to combat 100, though, and in a BitNode that nerfs Bladeburner hard that time is
  wasted on a route that loses anyway. So before the readings `node-eta.js` makes a first guess (`priorRows` in
  `route-model.js`): every Contract and Operation at level 1 with its chance and time from the game's formulas at combat 100
  (average new-city population, full stamina, no skills), its rank gain times the BitNode's `BladeburnerRank`, the skill cost
  times `BladeburnerSkillCost`, and the gym time at the BitNode's combat level multipliers. It posts `hacking` (with
  `plan.prior`, shown in `status` and the hold line as a first guess) only when hacking takes under 75 % of the guessed
  Bladeburner time; otherwise nothing is posted and Bladeburner trains and measures as before. The guess is redone every pass
  and gives way the same way a flip would (Bladeburner 25 % better). The multipliers come from `getBitNodeMultipliers`
  (saved by `tools/save-bitnode-mults.js`, so they need Source-File 5); without them the guess assumes no nerf. Kill switch:
  `bladeburner.priorRoute: false`. A young run (under 30 minutes since the install) has no income or hacking exp rate
  measured yet, and without them the hacking route cannot be simulated at all, so the guess had nothing to compare
  Bladeburner with and defaulted to training (this is how a run spent the gym on Bladeburner, then switched to hacking at
  rank 53 of 400,000). `node-eta.js` now records each run's peak exp rate next to its peak income in
  `data/node-eta-history.json` and, while the run is young (or a figure is missing), starts from the last earlier run's
  income and exp rate (`seedFromHistory` in `route-model.js`; income grows with the multiplier only through a reliable fit,
  else flat). The report says when it did. Once the run has its own figures they replace the seed. Kill switch:
  `bladeburner.priorHistory: false`. Needs one earlier run in the history; the first run ever still measures. Rejected:
  reading `data/reset-log.json` (the history file already holds income per run with the multiplier and survives resets).
  Rejected: a table of BitNode numbers in the scripts (the game's own multipliers say it, and
  a table would drift from the game); committing either route from the guess (a guess for Bladeburner would skip the
  measurement that calibrates it).
- **No division where the BitNode gives no rank.** `utils/bladeburner.js` reports Bladeburner unavailable when the saved
  multipliers give `BladeburnerRank` 0 (the game then refuses `joinBladeburnerDivision`) or the BitNode's advanced options
  disable it, so nothing trains for a division that never opens. Without Source-File 5 only the join attempt can tell
  (`bb-manage.js` posts `off`).
- **Real levels.** The models start from the multipliers the levels really grow with: the player's own mults times the
  BitNode's level multiplier, read back from the live level and exp (`modelMults` in `route-model.js`, the same reading
  `buy-augs.js` uses after The Red Pill; no Source-File 5 needed). `player.mults` leaves the BitNode's multiplier out, so
  without it BitNode 6 (hacking level x0.35) saw hacking levels about 2.9 times too high, the hacking route looked far shorter
  than it is, and Bladeburner was held. The report's "Hacking" line shows the multiplier when it isn't 1.
- **Invite gates.** A faction not joined yet sells in a modelled run only once that run reaches its invite's hacking, combat
  and installed-aug levels (`inviteGate` in `route-model.js`, from `getFactionInviteRequirements`; Daedalus has two ways in).
  Money, karma, backdoors and company conditions are assumed met. Without the gates the hacking route bought Illuminati's and
  The Covenant's augs at hacking levels BitNode 6 never reaches.
- **Faction rep restarts at each install.** As in the game, a modelled run starts every faction's rep at 0 and its rep turns
  into favor at the install; favor speeds rep up by (1 + favor/100) and opens donations at `getFavorToDonate()`. An aug needs its
  rep within one run, and Daedalus invites again each run before its rep for The Red Pill counts. The model used to keep rep
  across installs, which made the hacking route look shorter than it is next to Bladeburner, whose rank does carry over.
  `persistence.routeRepResets: false` brings that back ([`install-persistence.md`](install-persistence.md)).
- **Calibrated duty only.** The Bladeburner model's duty (measured rank per hour over predicted) is applied only after 30
  minutes of play; before that it stays at 50 %. `bb-pass.js` restarts its rank samples after a gap of over 10 minutes, so
  time held or training isn't counted as slow play. Both used to happen: the first minutes read 14 % duty, which made the route
  look slow enough to hold it again before it was measured properly.
- **Skill points, stamina and levels.** The Bladeburner side buys skill points as rank comes in (one per 3 rank): Overclock (-1 %
  action time a level, up to 90) and Blade's Intuition (+3 % chance), whichever adds more rank per point, from the levels, points and
  next Overclock cost `bb-manage.js` posts (`skillModel`; the cost gives the BitNode's skill cost multiplier). Stamina the regeneration
  doesn't cover costs resting time (1 % of the maximum per 60 s), so shorter actions don't count for more than stamina allows. Each
  action is played at its highest level that is still safe (40 %), and once an action's counts run out the next best fills the time.
  Without these the model let action levels outgrow the stats until nothing was safe, and the route looked several times slower than
  it is. Still left out: combat exp from the actions, the Black Ops' own chances and rank gates.
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

## The Blade's Simulacrum

- **Decision.** On the Bladeburner route The Blade's Simulacrum (Bladeburners faction, 1,250 rep, $150b) is bought before any
  other augment and installed at once. Without it the game cancels the Bladeburner action whenever the player starts other work
  (and the reverse), so `player-work.js` starts nothing while Bladeburner plays and the faction rep for the combat augments, the
  gym and the crime-faction invites all wait. Installed, the game runs both (bitburner-src v3.0.0 `Bladeburner.process` and
  `startAction` check it, installed only), so every later hour of the BitNode gets both.
- **How.** It has no stats, so `routeAdjust` adds it to `augments.special` (wanted) and `resetRule.routeKeyAugs` while the route
  is Bladeburner. `buy-augs.js` puts it first in the plan and the buyer buys it first (`first` in `buyList`), and
  `decideReset` resets for it right after the Black Op hold (a Black Op about to be attempted still goes first). Its rep comes
  from rank only, so `bb-manage.js` joins the Bladeburners faction at rank 25 instead of waiting for the next install.
- **Afterwards.** `player-work.js` sees it installed (`simulacrumInstalled` in [`../utils/bladeburner.js`](../utils/bladeburner.js))
  and goes on with its steps while `bb-pass.js` plays: crime-faction invites, faction work, company work, and in the gaps the
  gym for the lowest combat stat (Bladeburner's chances) instead of the cash crime.
- **Tradeoffs.** The reset costs the run's combat stats and faction rep; it is taken anyway because the gain lasts the rest of
  the BitNode. Rejected: valuing it in the normal reset rule (it has no stats for the weights to price, and a guessed value
  would be a hardcoded number). `bladeburner.simulacrumFirst: false` turns it off; the scripts then never buy it.

## What came from the standalone scripts

`bb-manage`, `bb-pass`, `node-eta` and `route-model` are ports (state on port 36 instead of files). The earlier city-faction
choice (`city-pass.js`) is merged into [`../singularity/workers/city-plan.js`](../singularity/workers/city-plan.js)
(groups ranked by augment value) and [`../singularity/player-work.js`](../singularity/player-work.js) (no group is picked
while the route is unsettled), see [`player-work.md`](player-work.md). Not carried over: `bb-hold.txt` and `bb-route.txt`
(now `plan` on the port), `node-ready.txt` (auto-destroy uses `blackOps` instead) and its debug text files
(`city-why.txt`, `bb-status.txt`: see `status` and `run /tools/debug-report.js`).
