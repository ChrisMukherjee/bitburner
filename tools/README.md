# tools/

Scripts to run by hand. RAM figures are approximate; `mem <script>` in game gives the exact cost, and `?` means none is recorded.

| Script | What it does | Flags | RAM |
| --- | --- | --- | --- |
| [`status.js`](status.js) | One-screen summary of the whole run | none | about 5GB |
| [`show-config.js`](show-config.js) | Prints the settings the scripts will use. Design: [`docs/config.md`](../docs/config.md) | `[section]`, `--example` | 1.6GB |
| [`track-income.js`](track-income.js) | Logs income every 10 seconds | none | 2.7GB |
| [`dump-state.js`](dump-state.js) | Prints a snapshot of the game state to paste elsewhere | none | ? |
| [`list-backdoors.js`](list-backdoors.js) | Lists servers worth backdooring and the path to each | `--all` | ? |
| [`check-servers.js`](check-servers.js) | Lists purchased servers | none | ? |
| [`kill-all-remote.js`](kill-all-remote.js) | Kills every script on every server except home | none | ? |

[`exploits/`](exploits/) holds one-shot scripts for the hidden "Exploit:" achievements (Source-File -1), with steps in [`exploits/README.md`](exploits/README.md).

| Script | Achievement | Notes |
| --- | --- | --- |
| [`easy.js`](exploits/easy.js) | undocumented, rainbow, bypass | Must stay at 1.6GB for bypass to count |
| [`time-compression.js`](exploits/time-compression.js) | time compression | Speeds up the game's 15s timer once, about 20s |
| [`prototype-tampering.js`](exploits/prototype-tampering.js) | prototype tampering | Waits for the game's 15-minute check, about 16 min |
| [`unclickable.js`](exploits/unclickable.js) | unclickable | Shows a red box; click it yourself |
| [`dev-menu.js`](exploits/dev-menu.js) | you're not meant to access this | Opens the hidden Dev menu |
| [`alter-reality.js`](exploits/alter-reality.js) | reality alteration | Needs a DevTools breakpoint, steps in the file |
| [`edit-save.py`](exploits/edit-save.py) | edit | Run on an exported save outside the game, then import it |

The `exploits` alias runs the first four.
