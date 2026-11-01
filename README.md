# bitburner

Bitburner automation scripts, written against the **Bitburner v3.0.0** Netscript API.

The goal is a mostly hands-off run: type `run /startup.js` once per BitNode and the scripts
root servers, farm money, buy upgrades and programs, grind factions, buy augmentations and
reset by themselves.

## What's been achieved

### BitNode progress

| BitNode | Status |
| --- | --- |
| BN1 (Source Genesis) | Destroyed (2026-10-30) |
| BN4 (The Singularity) | In progress, replaying for SF4.3 |
| Next | Probably BN5 or BN2 |

### Highlights

- **One-command startup.** `startup.js` launches everything for the current stage (early, mid, late,
  picked from home RAM) and works from a fresh 8GB home by running scripts on rooted servers.
  It is re-run automatically after home RAM upgrades, new port openers, augmentation installs
  and when entering a new BitNode.
- **Multi-target JIT batcher** (`batcher.js`). Just-in-time HWGW batches across up to 25 targets,
  using Formulas.exe when owned and a cheap stats helper when not. Picks the hack fraction with
  the best $/s per target and posts its income rate for other scripts to read.
- **Full Singularity loop.** Studies, buys programs and home upgrades, backdoors servers,
  joins factions (including the right city factions), works for factions and companies toward
  real rep goals, plans augmentation purchases and decides when a reset is worth it.
- **Coding contracts.** `workers/contract-solver.js` solves all 30 contract types in the game
  (tested on 2000 random contracts per type against the game's own solvers).
- **IPvGO bot** using Monte Carlo tree search (UCT + RAVE) at 0GB extra RAM. In-game record:

  | Opponent | Wins |
  | --- | --- |
  | Netburners | 45 / 45 |
  | Slum Snakes | 38 / 38 |
  | The Black Hand | 39 / 39 |
  | Tetrads | 26 / 30 |
  | Daedalus | 173 / 180 |
  | Illuminati (5x5) | 19 / 27 |

- **Darknet automation.** Maps and cracks darknet servers from hints and feedback (including
  Factori-Os prime factoring), phishes for money and keeps stasis links on the best servers.
- **Stock trader** using TIX with 4S data when available (estimates otherwise), buys market
  access itself, caps any stock at 25% of net worth, and can steer prices through the batcher's
  hack/grow workers.
- **RAM audit.** Static RAM costs cut hard (stock trader 60 → 25.5GB, contract finder 23 → 3.5GB,
  darknet manager 18 → 7GB) by moving heavy calls into one-shot workers.

## Setup

Scripts are pushed into the game with
[bitburner-filesync](https://github.com/bitburner-official/bitburner-filesync):

```sh
npm install
npm run sync
```

Then in the game: Options → Remote API → port `12525` → Connect.

Sync is one way (local → game), never deletes files in game, and skips `archive/`.
Files the game writes (anything in `data/`) never come back to disk.
`NetscriptDefinitions.d.ts` is refreshed from the game on connect, for editor autocomplete.

## Running it

```text
run /startup.js          # pick the stage from home RAM (mid >= 128GB, late >= 256GB)
run /startup.js mid      # force a stage
run /tools/status.js     # one-screen summary of the whole run
```

`startup.js` holds one priority-ordered list of long-running scripts, each tagged with the
stage it starts in. It skips anything already running and exits once everything is launched.

### Aliases

Aliases always use absolute paths starting with `/` so they work from any directory.
Single quotes outside, plain double quotes inside.

```text
alias startup='run /startup.js'
alias status='run /tools/status.js'
alias track-income='run /tools/track-income.js'
alias hack-only='run /tools/track-income.js; run /batcher.js'
alias gobot='run /go/ipvgo-bot.js --opponent "The Black Hand"'
alias solve-contracts='run /solve-contracts.js'
alias list-backdoors='run /tools/list-backdoors.js'
alias check-servers='run /tools/check-servers.js'
alias darknet-phishing='run /darknet/dnet-manager.js'
alias stock-trading='run /stock-trader.js'
alias upgrade-home='run /singularity/upgrade-home-ram.js --once; run /singularity/upgrade-home-cores.js --once'
alias auto-backdoor='run /singularity/auto-backdoor.js --once'
alias augs='run /singularity/buy-augs.js --dry'
alias buy-augs='run /singularity/buy-augs.js'
alias install-augs='run /singularity/install-augs.js /startup.js'
```

## Layout

| Path | What it does |
| --- | --- |
| `startup.js` | Stage-based launcher (see above) |
| `batcher.js` | Multi-target JIT hack/grow/weaken batcher |
| `pserv-manager.js` | Buys and upgrades purchased servers |
| `hacknet-manager.js` | Buys hacknet upgrades while they pay back fast enough for the current income |
| `share-manager.js` | Shares spare RAM for faction rep, only while doing faction work |
| `stock-trader.js` | Stock market trading (`--buy-4s`, `--promote N`, `--no-influence`) |
| `solve-contracts.js` | Finds coding contracts and hands them to `workers/contract-solver.js` |
| `singularity/` | Player automation: study, programs, home upgrades, backdoors, factions, company work, augs, resets, `next-bitnode.js <n>` |
| `darknet/` | Darknet crawler, password solvers, phishing and stasis links (`dnet-manager.js` is the entry point) |
| `go/` | IPvGO bot (`ipvgo-bot.js`) and its move search (`choose-move.js`) |
| `workers/` | Small scripts exec'd by managers: hack/grow/weaken, contract solver, faction goals, market access, share |
| `utils/` | Shared helpers: server list, nuking, RAM pool, target scoring, spending rules, income rate, toasts |
| `tools/` | Manual tools: status, state dump, income tracker, backdoor list, server checks |
| `archive/` | Older versions of scripts, kept for history (not synced to the game) |

### Singularity scripts

| Script | Role |
| --- | --- |
| `study.js` | Free CS course until hacking 75 |
| `buy-programs.js` | TOR, port openers, DarkscapeNavigator.exe, Formulas.exe |
| `upgrade-home-ram.js` / `upgrade-home-cores.js` | Home upgrades within the spending rules (`--once` for a single pass) |
| `auto-backdoor.js` | Backdoors faction and company servers (`--daemon` also does w0r1d_d43m0n) |
| `join-factions.js` | Accepts invites (city factions only with `--cities`) |
| `get-tian-di-hui.js` / `city-factions.js` | Travels to get Tian Di Hui and the one city-faction group whose augs are still wanted |
| `faction-work.js` | Hacking contracts for the next faction below its real rep goal |
| `company-work.js` | Megacorp jobs until their faction invites arrive |
| `buy-augs.js` | Plans and buys useful augs, most expensive first (`--dry` shows the plan and reset advice) |
| `auto-reset.js` | Watches the plan and installs augs when a reset pays off (`--dry` only logs) |
| `install-augs.js` | Installs augs and runs a script afterwards; refuses unless the advice says RESET (or `--force`) |
| `next-bitnode.js <n>` | Destroys w0r1d_d43m0n and enters BitNode n |

### Ports

| Port | Data |
| --- | --- |
| 20 | Darknet |
| 21 | Stock influence (servers to push up or down) |
| 22 | Total hacked money |
| 23 | Faction rep goals |
| 24 | Income rate ($/s, from the batcher) |
| 25 | City faction plan |
| 26 | Stock summary |
| 27 | Target stats (batcher without Formulas.exe) |

## Conventions

- **Versioning.** When a working script is replaced by an improved one, the old copy is renamed
  `<name>-vX.js` (next unused number) and later moved into `archive/`. Bug fixes to a broken
  script overwrite it in place. Old versions are kept for history (and the file-count achievement).
- **Static RAM.** The game charges RAM for any identifier that matches an NS function name,
  so helpers are never named `hack`, `grow`, `exec`, `attempt`, `window` and so on. Heavy
  API calls live in one-shot `workers/` scripts so long-running managers stay small.
- **Income.** Read money income with `utils/income.js`, not `ns.getTotalScriptIncome`
  (batcher workers exit on payout, so that reads about $0).
- **Notifications.** `utils/notify.js`: FYI events are a short toast; things that need action
  get a sticky toast, a terminal line and a log line.
