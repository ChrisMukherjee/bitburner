# darknet/

Maps and cracks darknet servers, phishes for money and keeps stasis links on the best servers. Design: [`docs/darknet.md`](../docs/darknet.md). RAM figures are approximate; `mem <script>` in game gives the exact cost. Figures follow the game's static RAM check (base 1.6GB plus each NS function named in the script and what it imports).

> **Needs `DarkscapeNavigator.exe` on home.** The manager exits cleanly until it is there (see [`ready.js`](ready.js)).

| Script | What it does | Flags | RAM |
| --- | --- | --- | --- |
| [`dnet-manager.js`](dnet-manager.js) | Entry point: starts crawlers, reads their reports, keeps the map and passwords; exits without DarkscapeNavigator.exe | `--once`, `--recon`, `--no-stasis` | 7GB |
| [`crawler.js`](crawler.js) | Spreads across darknet servers and cracks them (logs first, then the hint, then passwords from other servers) | args: earn, stasis (set by the manager) | 10.85GB |
| [`phish.js`](phish.js) | Phishing worker, one per opened server | none | 3.65GB |
| [`stasis.js`](stasis.js) | Applies or removes a stasis link | arg: `unlink` | 13.65GB while it runs |
| [`ready.js`](ready.js) | Library: tells [`startup.js`](../startup.js) to start the manager only once DarkscapeNavigator.exe is owned | import only | 0GB |
| [`hint-interpreter.js`](hint-interpreter.js) | Library: works out a password from a server's hint | import only | 0GB |
| [`feedback-solvers.js`](feedback-solvers.js) | Library: solvers for models that answer wrong guesses: Factori-Os (prime factors) and DeepGreen (Mastermind) | import only | 0.4GB |
| [`heartbleed.js`](heartbleed.js) | Library: reads a neighbour's logs for passwords that worked, leaked passcodes, known-wrong passwords and Mastermind replies | import only | 0.6GB |
| [`auth.js`](auth.js) | Library: login helper | import only | no extra RAM |
| [`config.js`](config.js) | Library: shared constants | import only | 0GB |
