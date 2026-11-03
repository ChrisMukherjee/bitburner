# darknet/

Maps and cracks darknet servers, phishes for money and keeps stasis links on the best servers. Design: [`docs/darknet.md`](../docs/darknet.md). RAM figures are approximate; `mem <script>` in game gives the exact cost. Figures follow the game's static RAM check (base 1.6GB plus each NS function named in the script and what it imports).

| Script | What it does | Flags | RAM |
| --- | --- | --- | --- |
| [`dnet-manager.js`](dnet-manager.js) | Entry point: starts crawlers, reads their reports, keeps the map and passwords; exits without DarkscapeNavigator.exe | `--once`, `--recon`, `--no-stasis` | 7GB |
| [`crawler.js`](crawler.js) | Spreads across darknet servers and cracks them | args: earn, stasis (set by the manager) | 10.25GB |
| [`phish.js`](phish.js) | Phishing worker, one per opened server | none | 3.65GB |
| [`stasis.js`](stasis.js) | Applies or removes a stasis link | arg: `unlink` | 13.65GB while it runs |
| [`hint-interpreter.js`](hint-interpreter.js) | Library: works out a password from a server's hint | import only | 0GB |
| [`feedback-solvers.js`](feedback-solvers.js) | Library: solvers for models that answer wrong guesses, such as Factori-Os | import only | 0.4GB |
| [`auth.js`](auth.js) | Library: login helper | import only | no extra RAM |
| [`config.js`](config.js) | Library: shared constants | import only | 0GB |
