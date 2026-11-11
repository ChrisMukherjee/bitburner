# Gang

[`../gang/gang-manager.js`](../gang/gang-manager.js), with [`../gang/formulas.js`](../gang/formulas.js) (the game's gang
formulas), [`../gang/workers/equipment.js`](../gang/workers/equipment.js) (port 29), the invite step in
[`../singularity/player-work.js`](../singularity/player-work.js) (via [`../gang/workers/invite.js`](../gang/workers/invite.js),
port 30) and the report [`../gang/gang-report.js`](../gang/gang-report.js). Settings are `gang` in [`../config.js`](../config.js).

Every decision is logged, so tail it and tune `gang` in the config if something looks off.

## What the game does (Bitburner v3.0.0, `src/Gang/`)

These are the facts the manager is built on; each was read from the source, not remembered.

- **Pay.** Per member and cycle (200ms): money `(5 x baseMoney x W x land x wantedFactor)^p`, respect `(11 x baseRespect x W x land x wantedFactor)^p`.
  `W` is the task's weighted stats minus a difficulty term whose factor is 3.2 for money, 4 for respect and 3.5 for wanted.
  `land` is `(territory x 100)^exponent / 100` and **every** task has an exponent (default 1, up to 2 on the heavy tasks), so owning all land
  pays 7x on a default task and 18x on Human Trafficking. `wantedFactor` is `respect / (respect + wanted)`. `p = (0.2 x territory + 0.8) x GangSoftcap`.
- **Wanted level.** Tasks that raise it get cheaper per skill point (`7 x baseWanted / (3 x W x land)^0.8`); Vigilante Justice and Ethical Hacking lower
  it, and every member on one also shaves 0.1% off the level per update.
- **Experience and stats.** A task gives `weight/1500 x difficulty^0.9 x expMult x ascensionMult` experience per cycle to each stat it weighs, whether or not
  the member is good enough to earn from it. A stat is `floor(mult x (32 ln(exp + 534.5) - 200))`: logarithmic in experience.
- **Ascension.** Points are `exp - 1000` per stat and the multiplier is `max(sqrt(points / 2000), 1)`: square root of banked experience. Ascending resets
  experience and non-augmentation gear and takes away the respect the member earned. Experience gain scales with the ascension multiplier too.
  So banking beats levelling, but each ascension loses the first 1000 experience and the stats (they restart at the multiplier).
- **Territory.** Power grows by `0.015 x territory x (sum of Warfare members' stats / 95)` per 100 cycles. Clashes happen only while clashes are on
  (about two a 20 seconds, with a leftover chance for ~30 minutes after switching off). A clash moves `1e-4 x (0.5..1.5) x max(1, 1 + ln(power ratio)/ln 50)` of the
  land. Only Warfare members can die, with chance falling with defense. Other gangs' power grows by itself.
- **Recruiting.** The first 3 are free, then `5^n` respect for the next. Gear costs fall with respect and power.

## Decisions

- **Combat gang by default (Slum Snakes).** The faction decides the gang type for good. Combat gangs make
  more money and win territory clashes more easily. The cost is getting the invite: in BitNode 2 karma -9
  and combat 30. A hacking gang (NiteSec, The Black Hand) needs no crimes but earns
  less. The choice is `gang.factions`.
- **The invite also runs in the start stage** (`gang.startInvite`): player-work.js needs a 64GB home, so waiting for it delayed the gang. [`../singularity/player-work-start.js`](../singularity/player-work-start.js) hands over to [`../singularity/workers/start-gang.js`](../singularity/workers/start-gang.js) (10.25GB, for a moment) before port openers and cash crimes: Homicide for the karma, the gym for the combat stats, then cash crime for the $1m. The gang manager starts once the faction is joined (it may run on a server when home is small). Rejected: buying 64GB first (costs cash the invite also needs, and the gang earns more), and a 16GB invite helper in the start pass.
- **The invite is a player-work step**, not its own script, because only player-work moves the player
  (see [`player-work.md`](player-work.md)): the crime with the most expected karma per minute (Homicide)
  for the karma, then the gym for the combat stats.
- **The game's exact formulas, locally** ([`../gang/formulas.js`](../gang/formulas.js)). No Formulas.exe and no trial assignment, so it works for any
  player. The first version used one difficulty factor (4) for everything, so money looked 29% weaker than it is on Human Trafficking and tasks that already
  paid money were treated as out of reach. Ranking tasks by the exact rates also lets the planner compare a member's pay now with its pay after training.
- **Growth: earn or train per member** (`gang.growth`, default on). The old rules trained until the combat average hit 200 and then earned
  for good. But earning gives far less experience than training unless the task is hard (Train Combat: 1.05 a cycle on each of four stats; Mug People 0.02; Human Trafficking 0.5 on hacking, dexterity and charisma but almost none on the rest),
  and a member can only earn on hard tasks once its stats are high, so members stopped ascending at stats near 200 and the gang stalled. The planner scores two options for every member: earn (the best task's pay now, plus the growth its small experience
  buys) and each Train task (nothing now, plus the growth its experience buys), where growth is how much the member's pay *after an ascension and a short
  recovery* rises over a probe stretch, times the horizon. Experience is valued as the banked multiplier it turns into, not as the stat it lifts today.
  Because it uses the exact pay formulas, it trains charisma and hacking when the best tasks weigh them and combat stats would add nothing. The horizon is the run's age
  (invest while it pays back within the time already played), between `horizonMinSeconds` and `horizonMaxSeconds`. At least `minEarnShare` of the gang always
  earns, so there is cash for gear and respect to recruit.
- **Ascension cycles.** A member ascends once a stat holds `1000 + trainRate x cycleSeconds` experience (about 25 minutes of training) and following both
  paths (stay vs go, summed over the next stretch so the dip counts) the pay gained covers the gear to rebuy and the respect given up. The first version of this rule
  compared the two paths alone and ascended every three minutes: the tiny multiplier gain looked positive, but each ascension throws away 1000 experience and resets the stats, so
  the gang never got anywhere. A one-stat model of 12 hours of training showed the shape: 2-minute cycles stall at multiplier 1.4, 15 to 60 minutes reach about 50,
  and the optimum is flat around 25 minutes. Rejected: a fixed ratio (the right ratio changes from 1.9x early to 1.2x late); ascending as often as possible.
- **Respect until full, then money.** `focus: "auto"`. The weakest earners cool the wanted level when its penalty passes 5%.
- **Territory.** With a full gang, `warfareShare` of the earners build power: the ones who give up the least pay per point of power (pay is concave in stats while
  land is below 100%, so that is often the strongest, and linear near full land, where the weakest give up less). Clashes use the land outlook: for each gang
  still holding land, chance to win x land a win takes, against chance to lose x land a loss costs, averaged over the gangs (the opponent is random). The old
  rule (win chance against the *worst* gang) never fought while one strong gang existed, even when taking land from the weak ones paid. On at 55%, off below 50%.
- **Equipment by payback.** Each (item, member) is valued by the pay it adds on the member's post-ascension stats (augmentations) or current stats (other gear), and
  bought best payback first when the payback fits the item's horizon: the run's age for augmentations, the time until that member's next ascension for other gear (it is
  wiped by ascending). Replaces "cheapest first", which bought gear for members about to ascend and equipment whose stats no task used. With growth off the old order stays.
- **Started only when useful.** [`../startup.js`](../startup.js) starts it once
  [`../gang/ready.js`](../gang/ready.js) says a gang exists or a gang faction is joined and a gang can be created,
  so its RAM isn't held while waiting for the invite.
- **No BitNode-number checks.** Whether the Gang API works and whether a gang needs karma -54,000 (everywhere
  but BitNode 2) is decided once, in [`../utils/gang.js`](../utils/gang.js). The manager posts ready-made status
  lines on port 28, so [`../tools/status.js`](../tools/status.js) knows nothing about gangs. `GangSoftcap` comes from the saved BitNode multipliers
  ([`bitnode-mults.md`](bitnode-mults.md)), 1 when unknown.
- **Kill switches.** `gang.growth.enabled: false` restores the fixed rules (`trainLevel`, `ascendAt`, `ascendMaxRespectShare`) and the old equipment order;
  `--no-buy`, `--no-war`; `gang.logMs: 0` stops the log.

## Measuring it

- **Status** (`status`, port 28): money per second **against the ceiling** (every member on its best money task with no wanted penalty, at its current stats),
  respect per second, wanted penalty, land and clash state with the land outlook, and a line of members earning / training / warfare / cooling, ascensions, deaths and the main-stat average and weakest member.
  Deaths are counted every update, before recruiting can fill the place (a gang with the respect to replace a member at once would otherwise never see the loss).
  Efficiency below ~70% at a full gang means members are training, at war or cooling; the third line says which.
- **Log and report.** The manager appends a sample to `data/gang-log.json` every `gang.logMs` (5 minutes, a day kept) with milestones (first full gang, first clashes, all land).
  `gang-report` prints the latest sample, ascensions and deaths per hour, income and stat trend, land gained per hour and the hours left to all of it at that pace.
- **Against a theoretical best.** The ceiling above is the per-moment bound. For the long run, compare time to milestones between runs (the report keeps them) and the main-stat
  average against the multiplier a continuously training member reaches (about 50 after 12 hours in the one-stat model). A full gang whose weakest member stays far below the average
  is a member stuck on a task it can't use.
- **Regression check.** [`../tests/gang-sim.test.mjs`](../tests/gang-sim.test.mjs) plays a twelve-member gang for 8 simulated hours with the real task table and the
  exact formulas. Growth earns well over the legacy rules (about 1.7x at one seventh of the land, about 2x at all of it in the 12-hour runs), ascends about twice an hour per member, and keeps a third earning.
  It is a model of the game's maths, not the game: equipment, wanted level and territory change are not in it.

## Current state and open questions

- Written against the v3.0.0 source and checked against a model, then covered by tests. The growth rules are new; watch the first hours with `gang-report`: members
  should train for the first hour or so (income dips while the multiplier builds), then earn at several times the old rate. If income stays flat, set `gang.growth.enabled` to false and report what the status lines showed.
- Warfare still starts only with a full gang (warriors make no respect and recruiting needs it). Land multiplies every task, so starting earlier may pay; the model does not decide that yet.
- The share of members at war is fixed (`warfareShare`). Power only needs to outgrow the other gangs, so a share that falls once the land outlook is comfortable would free earners.
- Respect-vs-money after the gang is full ignores that the gang faction's reputation (augmentations in BitNode 2) comes from respect.
- In BitNode 2 the gang faction sells almost every augment, so faction-work order and aug buying may want a gang-aware tweak.
