# gang/

Gang manager. Design: [`docs/gang.md`](../docs/gang.md). RAM figures are approximate; `mem <script>` in game gives the exact cost. Figures follow the game's static RAM check (base 1.6GB plus each NS function named in the script and what it imports).

> **Needs BitNode 2 or Source-File 2.** The Gang API only works there. Outside BitNode 2 the gang also needs
> karma -54,000 (see [`utils/gang.js`](../utils/gang.js)). The manager exits cleanly without the API.

> **Untested in game.** Written against the v3.0.0 Gang API before reaching BitNode 2. Tail
> `gang/gang-manager.js` on the first run; every decision is logged.

| Script | What it does | Flags | RAM |
| --- | --- | --- | --- |
| [`gang-manager.js`](gang-manager.js) | Runs the gang; settings are `gang` in the config; posts status lines on port 28 | `--no-buy`, `--no-war` | about 33GB |
| [`ready.js`](ready.js) | Library: tells [`startup.js`](../startup.js) when the manager has work | import only | 1.5GB |
| [`workers/equipment.js`](workers/equipment.js) | One-shot: equipment list, on port 29 | none | 5.6GB, for a moment |
| [`workers/invite.js`](workers/invite.js) | One-shot for player-work: the best-scoring crime for the invite (and for the karma grind outside BitNode 2), on port 30 | arg: JSON | 16.1GB (211.1GB at SF4.1, 55.1GB at SF4.2), for a moment |

[`startup.js`](../startup.js) starts the manager once there's work: a gang exists, or a gang faction is joined and a
gang can be created (BitNode 2, or Source-File 2 with karma -54,000; that rule lives in [`utils/gang.js`](../utils/gang.js)).

- **Combat or hacking.** The gang type comes from the faction it's created with, and can't be changed
  later. The default is a combat gang with Slum Snakes: more money (Human Trafficking) and stronger in
  territory clashes. The invite needs combat stats 30 and karma -9, so in BitNode 2
  [`player-work.js`](../singularity/player-work.js) commits the best-scoring crime of `gang.inviteCrimes` (Mug early, harder ones as stats rise) after study until it
  arrives. Set `gang.factions` to `["NiteSec", "The Black Hand"]` for a hacking gang instead: no crimes,
  since the hacking scripts get the NiteSec invite anyway, but less money.
- **Recruits** whenever respect allows; **ascends** a member once their main stat multiplier would grow
  1.5x (`ascendAt`).
- **Tasks:** members train until `trainLevel`; the rest earn respect until the gang is full (12), then
  money. Each gets the task that pays them most, found by trying each task and reading the gain back.
  Above a 5% wanted penalty the weakest earners do Vigilante Justice / Ethical Hacking until it's below 1%.
- **Territory:** with a full gang, half the trained members do Territory Warfare. Clashes go on at a 55%
  win chance against every gang still holding territory and off below 50%.
- **Equipment:** once a minute, augmentations first (they survive ascension), then the cheapest useful
  item, within the `gang.buying` spending stages.
