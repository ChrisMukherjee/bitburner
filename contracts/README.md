# contracts/

Coding contracts. No design note. RAM figures are approximate; `mem <script>` in game gives the exact cost.

| Script | What it does | Flags | RAM |
| --- | --- | --- | --- |
| [`solve-contracts.js`](solve-contracts.js) | Looks for contracts every 15 minutes and hands them to the solver | none | 3.5GB |
| [`workers/contract-solver.js`](workers/contract-solver.js) | One-shot: solves all 30 contract types, records failures in `data/failed-contracts.txt` | arg: contract list as JSON | about 22GB, for a moment |
