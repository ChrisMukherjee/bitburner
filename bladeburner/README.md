# bladeburner/

Bladeburner for BitNode 6 and 7, and for any run with Source-File 6 or 7. Design: [`docs/bladeburner.md`](../docs/bladeburner.md). RAM figures follow the game's static RAM check (base 1.6GB plus each NS function named in the script and what it imports); `mem <script>` in game gives the exact cost. All of it comes from the other player's scripts, which have run in game; this port (state on a port instead of files, startup.js instead of her orchestrator) has not.

| Script | What it does | Flags | RAM |
| --- | --- | --- | --- |
| [`bb-manage.js`](bb-manage.js) | One short pass every 3 minutes: decides the state (`off`, `boot`, `train`, `run`, `hold`) and posts it on port 36, joins the division, spends skill points | none | 26.2GB, for a moment |
| [`bb-pass.js`](bb-pass.js) | One short pass every 30 s while the state is `run`: stamina first, then the next Black Op when safe, otherwise the Contract or Operation with the best rank per second; posts its reasoning as the `status` lines, rank samples and live readings | none | 53.1GB, for a moment |
| [`state.js`](state.js) | Library: reads and patches the shared object on port 36 (state, route estimate, rank samples, status lines) | import only | 1.6GB |
| [`ready.js`](ready.js) | Library: ready checks [`startup.js`](../startup.js) uses (the API is usable; the state is `run`) | import only | 2.6GB |

The gym (`train`) is done by [`singularity/player-work.js`](../singularity/player-work.js), the one script that moves the player. [`utils/bladeburner.js`](../utils/bladeburner.js) says whether the API is usable.
