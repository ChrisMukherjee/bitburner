# contracts/

Coding contracts. No design note. RAM figures are approximate; `mem <script>` in game gives the exact cost.

| Script | What it does | Flags | RAM |
| --- | --- | --- | --- |
| [`solve-contracts.js`](solve-contracts.js) | Every 15 minutes, looks for contracts on the normal network and on every darknet server in the darknet map (opened caches can leave contracts there) and hands them to the solver, on home or, when home is short, on any rooted server with room. Keeps `data/failed-contracts.txt` (wrong answers, never retried) and drops entries once their contract is gone | none | 4.25GB |
| [`workers/contract-solver.js`](workers/contract-solver.js) | One-shot: solves all 30 contract types. Skips contracts it can't read, reports wrong answers on port 32, and warns with the terminal commands to solve a contract by hand | arg: contract list as JSON | 21.9GB, for a moment |
| [`config.js`](config.js) | Shared constants: the failures port and file | none | 0GB (import only) |
