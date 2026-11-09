# darknet/

Maps and cracks darknet servers, phishes for money and keeps stasis links on the best servers, pushes servers to move when mapping stalls, to reach cut-off parts of the darknet, and unleashes a STORM_SEED.exe when the darknet has run dry. Design: [`docs/darknet.md`](../docs/darknet.md). RAM figures are approximate; `mem <script>` in game gives the exact cost. Figures follow the game's static RAM check (base 1.6GB plus each NS function named in the script and what it imports).

Requires column: see the [requirement tags](../README.md#requirements). The scripts that use the darknet API need `DarkscapeNavigator.exe` on home (Darknet). The manager exits cleanly until it is there (see [`ready.js`](ready.js)).

| Script | What it does | Flags | Requires | RAM |
| --- | --- | --- | --- | --- |
| [`dnet-manager.js`](dnet-manager.js) | Entry point: starts crawlers, reads their reports, keeps the map and passwords; exits without DarkscapeNavigator.exe | `--once`, `--recon`, `--no-stasis`, `--no-migrate`; `darknet.storm.enabled: false` in `data/config.json` turns off the storm; `darknetLog` sets how often it logs and prints a summary | Darknet | 7GB |
| [`crawler.js`](crawler.js) | Spreads across darknet servers and cracks them (logs first, then the hint, then passwords from other servers) | args: earn, stasis, migrate (set by the manager) | Darknet | 11.05GB |
| [`phish.js`](phish.js) | Phishing worker, one per opened server | none | Darknet | 3.65GB |
| [`migrate.js`](migrate.js) | Pushes one neighbour with `induceServerMigration` until it moves; started by a crawler when the manager lists that neighbour as a target | arg: target host | Darknet | 5.8GB |
| [`stasis.js`](stasis.js) | Applies or removes a stasis link | arg: `unlink` | Darknet | 13.65GB while it runs |
| [`storm-rule.js`](storm-rule.js) | Library: decides when unleashing STORM_SEED.exe pays, as a break-even check from live data: measured income and its noise, blocked-RAM trend, which servers a storm could delete, discovery rate and fill time | import only | none | 0GB |
| [`ready.js`](ready.js) | Library: tells [`startup.js`](../startup.js) to start the manager only once DarkscapeNavigator.exe is owned | import only | none | 0GB |
| [`hint-interpreter.js`](hint-interpreter.js) | Library: works out a password from a server's hint (PHP 5.4: the anagrams of its sorted Data, up to 720) | import only | none | 0GB |
| [`feedback-solvers.js`](feedback-solvers.js) | Library: solvers for models that answer wrong guesses: Factori-Os (prime factors, capped by the password length and started from the hint's divisor; reads the reply from its data or message and stops on one it can't read) DeepGreen (Mastermind: only guesses of the reported length, re-reads the server log before every guess so several crawlers and restarts share the history, keeps it in `data/darknet-mastermind.txt`, and uses the log's "a 8 and a 6" clues), Pr0verFl0 (one overflow guess) and OpenWebAccessPoint (the password hidden in the packet each wrong guess returns, found by intersecting captures) | import only | none | 0.4GB (+0.6GB heartbleed when not already imported) |
| [`heartbleed.js`](heartbleed.js) | Library: reads a neighbour's logs for passwords that worked, leaked passcodes, known-wrong passwords, Mastermind replies and the two-digit "I can see a 8 and a 6" clues | import only | Darknet | 0.6GB |
| [`auth.js`](auth.js) | Library: login helper | import only | Darknet | no extra RAM |
| [`config.js`](config.js) | Library: shared constants | import only | none | 0GB |
