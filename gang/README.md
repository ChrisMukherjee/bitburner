# gang/

Gang manager. Design: [`docs/gang.md`](../docs/gang.md). RAM figures are approximate; `mem <script>` in game gives the exact cost. Figures follow the game's static RAM check (base 1.6GB plus each NS function named in the script and what it imports).

Requires column: see the [requirement tags](../README.md#requirements). The manager and its equipment worker need the Gang API (SF2), which only works in BitNode 2 or with Source-File 2. Outside BitNode 2 the gang also needs karma -54,000 (see [`utils/gang.js`](../utils/gang.js)). The manager exits cleanly without the API. The invite worker is `SF4`: it uses crimes and the gym.

Every decision is logged: tail `gang/gang-manager.js` if something looks off. `gang-report` (alias in the [root README](../README.md)) shows how well it is doing: money against the ceiling, members training or idle, ascensions per hour, land per hour. Settings, the maths and the measurements: [`docs/gang.md`](../docs/gang.md).

| Script | What it does | Flags | Requires | RAM |
| --- | --- | --- | --- | --- |
| [`gang-manager.js`](gang-manager.js) | Runs the gang; settings are `gang` in the config; posts status lines and a metrics sample on port 28 and logs samples to `data/gang-log.json` | `--no-buy`, `--no-war` | SF2 | about 34GB |
| [`formulas.js`](formulas.js) | Library: the game's gang formulas (money, respect, wanted, experience, ascension, clash outlook) | import only | none | 1.6GB |
| [`gang-report.js`](gang-report.js) | One-shot report from the metric log: income against the ceiling, training/idle members, ascensions and land per hour, milestones | `--hours <n>` | none | 1.6GB |
| [`ready.js`](ready.js) | Library: tells [`startup.js`](../startup.js) when the manager has work | import only | none | 1.5GB |
| [`workers/equipment.js`](workers/equipment.js) | One-shot: equipment list, on port 29 | none | SF2 | 5.6GB, for a moment |
| [`workers/spend-leftover.js`](workers/spend-leftover.js) | One-shot run by `install-augs.js` just before an install: the cash the install would wipe goes into gang equipment, which the gang keeps (anything that adds pay, best payback first; `persistence.spendLeftover`, [`docs/install-persistence.md`](../docs/install-persistence.md)) | arg: reserve | SF2 | 18.8GB, for a moment |
| [`workers/invite.js`](workers/invite.js) | One-shot for player-work: what the invite still needs, the crime with the most expected karma (or missing combat exp) per minute, failures included, and whether the gym should train the stats; also for the karma grind outside BitNode 2. On port 30 ([`docs/player-work.md`](../docs/player-work.md)) | arg: JSON | SF4 | 16.1GB (211.1GB at SF4.1, 55.1GB at SF4.2), for a moment |

[`startup.js`](../startup.js) starts the manager once there's work: a gang exists, or a gang faction is joined and a
gang can be created (BitNode 2, or Source-File 2 with karma -54,000; that rule lives in [`utils/gang.js`](../utils/gang.js)).

- **Combat or hacking.** The gang type comes from the faction it's created with, and can't be changed
  later. The default is a combat gang with Slum Snakes: more money (Human Trafficking) and stronger in
  territory clashes. The invite needs combat stats 30 and karma -9, so in BitNode 2
  [`player-work.js`](../singularity/player-work.js) commits the crime with the most expected karma per minute at your success chance (Homicide) for the karma, then trains the combat stats in the gym, after study until it
  arrives. Set `gang.factions` to `["NiteSec", "The Black Hand"]` for a hacking gang instead: no crimes,
  since the hacking scripts get the NiteSec invite anyway, but less money.
- **Recruits** whenever respect allows.
- **Growth** (`gang.growth`, on by default): each member either earns or trains, whichever is worth more over the
  horizon (the run's age, at least an hour). Training is chosen per stat with the game's own experience and pay
  formulas, so charisma and hacking get trained when the best money tasks weigh them (Human Trafficking is 30%
  hacking and 30% charisma). A member ascends after about `cycleSeconds` of training, when the stronger multiplier
  covers the gear to rebuy and the respect given up. At least `minEarnShare` of the gang always earns. Set
  `gang.growth.enabled` to `false` for the old fixed rules (`trainLevel`, `ascendAt`).
- **Tasks:** each earner gets the task with the most of the focus (respect until the gang is full, then money),
  scored with the game's exact formulas (each rate has its own difficulty factor, the wanted penalty and the land
  share enter). Above a 5% wanted penalty the weakest earners do Vigilante Justice / Ethical Hacking until it's below 1%.
- **Territory:** with a full gang, half the earners do Territory Warfare, the ones who give up the least pay per
  point of power. Clashes go on when the share of contested land we would take (win chance and land per win or loss,
  over every gang holding land) reaches 55% and off below 50%.
- **Equipment:** once a minute, best payback first within the `gang.buying` spending stages. Augmentations (they survive
  ascension) may pay back over the whole horizon; other gear only until that member's next ascension. An augmentation
  install keeps the gang and its gear, so just before one `install-augs.js` puts the cash it would wipe into equipment too
  (`workers/spend-leftover.js`, [`docs/install-persistence.md`](../docs/install-persistence.md)).
