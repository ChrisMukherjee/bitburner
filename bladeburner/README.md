# bladeburner/

Bladeburner. Design: [`docs/bladeburner.md`](../docs/bladeburner.md). RAM figures follow the game's static RAM check (base 1.6GB plus each NS function named in the script and what it imports); `mem <script>` in game gives the exact cost. All of it comes from the other player's scripts, which have run in game; this port (state on a port instead of files, startup.js instead of her orchestrator) has not.

Requires column: see the [requirement tags](../README.md#requirements). The Bladeburner API (SF6/7) only works in BitNode 6 or 7, or with Source-File 6 or 7. The scripts exit cleanly without it (see [`utils/bladeburner.js`](../utils/bladeburner.js)).

| Script | What it does | Flags | Requires | RAM |
| --- | --- | --- | --- | --- |
| [`bb-manage.js`](bb-manage.js) | One short pass every 3 minutes: decides the state (`off`, `boot`, `train`, `run`, `hold`) and posts it on port 36, joins the division, spends skill points (by gain per point from the live readings, see [`picks.js`](picks.js); `bladeburner.adaptiveSkills: false` = fixed tiers). With `bladeburner.stanekFirst` (on in BitNode 13) it doesn't join while that would close Stanek's Gift (Source-File 7.3, see [`utils/stanek.js`](../utils/stanek.js)) | none | SF6/7 | 26.2GB, for a moment |
| [`node-eta.js`](node-eta.js) | One short pass every 5 minutes: simulates the hacking and Bladeburner routes reset by reset and posts the verdict (`route`, `hold`) on port 36; report in `data/node-eta.txt`. Needs the Singularity API too | none | SF6/7, SF4 | 30GB (390GB at SF4.1, 102GB at SF4.2), for a moment |
| [`route-model.js`](route-model.js) | Library: the pure route models (Bladeburner rank, augmentation shopping, Daedalus and The Red Pill) | import only | none | 0GB |
| [`bb-pass.js`](bb-pass.js) | One short pass every 30 s while the state is `run`: stamina first, then the next Black Op when safe, otherwise the Contract or Operation with the best rank per second; moves to the city with the best chances (`bladeburner.switchCity`), posts its reasoning as the `status` lines, rank samples, live readings and the share of time spent resting | none | SF6/7 | 57.1GB, for a moment |
| [`picks.js`](picks.js) | Library: the pure choices, which skill to buy and which city to play in, from the live readings | import only | none | 0GB |
| [`state.js`](state.js) | Library: reads and patches the shared object on port 36 (state, route estimate, rank samples, status lines) | import only | none | 1.6GB |
| [`ready.js`](ready.js) | Library: ready checks [`startup.js`](../startup.js) uses (the API is usable; the state is `run`) | import only | none | 2.6GB |

The gym (`train`) is done by [`singularity/player-work.js`](../singularity/player-work.js), the one script that moves the player. [`utils/bladeburner.js`](../utils/bladeburner.js) says whether the API is usable.
