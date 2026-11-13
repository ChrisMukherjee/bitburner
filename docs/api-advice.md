# Advice when an API or item is missing

[`../utils/api-advice.js`](../utils/api-advice.js) (the text and the once-only printing), [`../tools/api-advice.js`](../tools/api-advice.js)
(the pass [`../startup.js`](../startup.js) runs), `status` (one line per missing thing).

## Decision

Anything that depends on what a BitNode or Source-File unlocks has to work without it, and has to **say so**: what is
missing, what the scripts do meanwhile, and what the player can do about it. A script that quietly does less leaves the player
wondering why nothing buys programs or manages a gang. The advice is computed, not scripted per route:

- **What is missing** comes from the run: the BitNode, the Source-Files owned (`getResetInfo`) and `Formulas.exe` on home.
- **What to do** is the BitNode that gives it (Singularity: BitNode 4; multipliers: 5; Gang: 2; Bladeburner: 6 or 7), with the
  Source-File level that destroying it would give. Where several BitNodes give it, the one `bitnodePlan` lists first wins. Things bought in the
  game (Formulas.exe) say what to buy and that TOR comes first. A BitNode that forbids the API (Bladeburner with rank
  multiplier 0) gets its reason and no recommendation.
- **Once per BitNode run.** `tools/api-advice.js` runs every 10 minutes from `startup.js`, prints each missing thing the first time
  it sees it in a run (`data/api-advice.json` remembers; a new BitNode run says it again) and rewrites the list so what
  you gain later disappears from `status` (a `Missing ...` line per item).
- **Scripts you run by hand** (`buy-augs`, `install-augs`, `player-work`, `auto-destroy` ... without the Singularity API) print the
  advice and stop (`requireApi`), every time you run them, instead of failing inside the game. Managers `startup.js` starts (gang,
  Bladeburner) use the once-only version when they exit.
- **Kill switch:** `missingApiAdvice.enabled: false` in the config silences the tool, the managers and `status`. Guards still
  stop a script that cannot work, with the one fact and no recommendation.

## RAM

The helper never calls `getResetInfo` itself: callers pass in the result they already have, so importing it adds nothing to a
Singularity script (checked with the static RAM check on every script that gained the guard). The Singularity scripts that
have no `getResetInfo` in their imports (the workers, `buy-programs`, `upgrade-home-*`) are not guarded: `startup.js`
never starts them without the API and says so. The pure checks are `singularityFromInfo`, `bitnodeMultsFromInfo` and `gangApiFromInfo`
in the capability helpers, so each rule is still written once.

## Audit: what each feature does without it

| Feature | Scripts that use it | Without it | Advice |
| --- | --- | --- | --- |
| Singularity (SF4) | everything in [`../singularity/`](../singularity/), `node-eta.js`, `share-manager.js`, `status.js` | `startup.js` leaves them out; `reminders.js` tells you when to backdoor and buy; `status` says "unknown" for work and goals; the hacking core runs | tool, `requireApi` in `buy-augs`, `install-augs`, `player-work`, `player-work-start`, `auto-destroy` |
| BitNode multipliers (SF5) | `batcher.js`, `hack/ready.js`, `hacknet-manager.js`, `gang-manager.js`, `stock-trader.js`, `node-eta.js`, `auto-destroy.js`, `status.js`, `startup.js` via [`../utils/bitnode-mults.js`](../utils/bitnode-mults.js) | every multiplier reads 1 (the old assumptions); nothing is held back as worthless; the route suggestion uses the plan's order | tool |
| Formulas.exe | `batcher.js`, `hacknet-manager.js`, `target-stats.js`, `utils/targets.js` | estimates from measured numbers with a safety margin; switches on the moment the file appears (batcher checks every tick) | tool |
| Intelligence (SF5) | `status.js`, Bladeburner chance model | the stat is 0: the line is hidden, the model's factor is 1 | none (nothing to do differently; SF5 is already advised for the multipliers) |
| Gang (SF2) | `gang-manager.js`, the gang workers, `go-plan.js` | manager prints its reason and exits; `startup.js` only starts it when `gang/ready.js` says there is work | tool, manager exit |
| Sleeves (SF10) | `sleeve-manager.js`, `sleeve-shop.js` | managers print their reason and exit; `startup.js` only starts them when `sleeves/ready.js` says the API works | tool, manager exit |
| Bladeburner (SF6/7) | `bb-manage.js`, `bb-pass.js`, `node-eta.js` | the route stays hacking; manager exits | tool, manager exit |
| TIX / 4S data | `stock-trader.js` | buys TIX itself once cash allows, waits with a terminal line; without 4S it forecasts from price history | none (it buys them by itself) |
| Darknet (`DarkscapeNavigator.exe`) | `dnet-manager.js` | `startup.js` waits for the program; `buy-programs.js` buys it | none (bought automatically with the Singularity API; without it `reminders.js` lists it) |
| IPvGO cheat (SF14.2) | `go/anticheat.js` | says it needs SF14.2 and stops | its own message |

Stanek and corporations have no scripts yet, so nothing depends on them.

## Rejected

- **Advice from each script's own `if`.** Twenty scripts printing their own wording drift apart; one table of features and one
  function give the same text everywhere and make it testable.
- **A hardcoded "go to BitNode 4" route.** The right BitNode depends on what you own and on `bitnodePlan`, so it is computed.
- **A guard in every Singularity script.** A guard needs `getResetInfo` (1GB); on a script without it that is more RAM on
  the smallest homes, where the script is already left out by `startup.js`.
