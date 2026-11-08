# darknet/

Maps and cracks darknet servers, phishes for money and keeps stasis links on the best servers and pushes servers to move when mapping stalls, to reach cut-off parts of the darknet. Design: [`docs/darknet.md`](../docs/darknet.md). RAM figures are approximate; `mem <script>` in game gives the exact cost. Figures follow the game's static RAM check (base 1.6GB plus each NS function named in the script and what it imports).

Requires column: see the [requirement tags](../README.md#requirements). The scripts that use the darknet API need `DarkscapeNavigator.exe` on home (Darknet). The manager exits cleanly until it is there (see [`ready.js`](ready.js)).

| Script | What it does | Flags | Requires | RAM |
| --- | --- | --- | --- | --- |
| [`dnet-manager.js`](dnet-manager.js) | Entry point: starts crawlers, reads their reports, keeps the map and passwords; exits without DarkscapeNavigator.exe | `--once`, `--recon`, `--no-stasis`, `--no-migrate` | Darknet | 7GB |
| [`crawler.js`](crawler.js) | Spreads across darknet servers and cracks them (logs first, then the hint, then passwords from other servers) | args: earn, stasis, migrate (set by the manager) | Darknet | 10.85GB |
| [`phish.js`](phish.js) | Phishing worker, one per opened server | none | Darknet | 3.65GB |
| [`migrate.js`](migrate.js) | Pushes one neighbour with `induceServerMigration` until it moves; started by a crawler when the manager lists that neighbour as a target | arg: target host | Darknet | 5.8GB |
| [`stasis.js`](stasis.js) | Applies or removes a stasis link | arg: `unlink` | Darknet | 13.65GB while it runs |
| [`ready.js`](ready.js) | Library: tells [`startup.js`](../startup.js) to start the manager only once DarkscapeNavigator.exe is owned | import only | none | 0GB |
| [`hint-interpreter.js`](hint-interpreter.js) | Library: works out a password from a server's hint | import only | none | 0GB |
| [`feedback-solvers.js`](feedback-solvers.js) | Library: solvers for models that answer wrong guesses: Factori-Os (prime factors, capped by the password length and started from the hint's divisor) and DeepGreen (Mastermind) | import only | none | 0.4GB |
| [`heartbleed.js`](heartbleed.js) | Library: reads a neighbour's logs for passwords that worked, leaked passcodes, known-wrong passwords and Mastermind replies | import only | Darknet | 0.6GB |
| [`auth.js`](auth.js) | Library: login helper | import only | Darknet | no extra RAM |
| [`config.js`](config.js) | Library: shared constants | import only | none | 0GB |
