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

- **One-command startup.** [`startup.js`](startup.js) launches everything for the current stage (start, early, mid, late,
  picked from home RAM) and works from a fresh 8GB home by running scripts on rooted servers.
  It stays running: it moves to the next stage after a home upgrade, restarts scripts that stop, and
  runs the Singularity buyers, invites and backdoors as short one-shots only when there is something
  to do. It starts by itself after augmentation installs and when entering a new BitNode.
- **Multi-target JIT batcher** ([`batcher.js`](hack/batcher.js)). Just-in-time HWGW batches across up to 25 targets,
  using Formulas.exe when owned and a cheap stats helper when not. Picks the hack fraction with
  the best $/s per target and posts its income rate for other scripts to read.
- **Full Singularity loop.** Studies, buys programs and home upgrades, backdoors servers,
  joins factions (including the right city factions), works for factions and companies toward
  real rep goals, plans augmentation purchases, decides when a reset is worth it, and destroys
  the BitNode by itself once The Red Pill is installed.
- **Coding contracts.** [`contracts/workers/contract-solver.js`](contracts/workers/contract-solver.js) solves all 30 contract types in the game,
  including contracts left on darknet servers (tested on 2000 random contracts per type against the game's own solvers).
- **IPvGO bot** using Monte Carlo tree search (UCT + RAVE) at 0GB extra RAM. In-game record (as of 2026-11-02):

  | Opponent | Wins | Best streak | Captured nodes | Bonus |
  | --- | --- | --- | --- | --- |
  | Netburners | 42 / 42 | 42 | 1202 | +17.97% hacknet production |
  | Slum Snakes | 41 / 41 | 41 | 1162 | +22.0% crime success |
  | The Black Hand | 52 / 53 | 44 | 1540 | +18.27% hacking money |
  | Tetrads | 55 / 58 | 52 | 1541 | +16.90% combat stats |
  | Daedalus | 196 / 198 | 171 | 5397 | +45.30% reputation gain |
  | Illuminati (5x5) | 25 / 39 | 12 | 493 | +17.76% faster hack/grow/weaken |

- **All 11 exploit achievements** (Source-File -1 level 11), mostly by script: see [`tools/exploits/`](tools/exploits/).
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

Sync is one way (local → game), never deletes files in game, and skips [`archive/`](archive/).
On every connect it pushes all files (`pushAllOnConnection`), so edits made while sync was off still reach the game. This push prints nothing; the "… changed" lines only appear for edits made while sync is running.
Files the game writes (anything in `data/`) never come back to disk.
[`NetscriptDefinitions.d.ts`](NetscriptDefinitions.d.ts) is refreshed from the game on connect, for editor autocomplete.

## Running it

```text
run /startup.js          # pick the stage from home RAM (early >= 64GB, mid >= 128GB, late >= 256GB)
run /startup.js mid      # force a stage
run /startup.js --restart  # also restart running scripts, so freshly synced code takes effect
run /tools/status.js     # one-screen summary of the whole run
```

`status` also has a BitNode line: the SF level destroying this node gives, the next BitNode on
`bitnodeRoute`, and how far along the end is (Daedalus invite needs, Daedalus rep against The Red
Pill's requirement, then hacking level and root for `w0r1d_d43m0n`). The Red Pill and Daedalus
numbers come from `data/aug-plan.json`, which [`auto-reset.js`](singularity/auto-reset.js) refreshes every 10 minutes.

[`startup.js`](startup.js) holds one priority-ordered list of long-running scripts, each tagged with the
stage it starts in. It skips anything already running and stays running (about 7GB) to start what
becomes ready, restart what stops, and run the one-shots.
Below 64GB home (a fresh BitNode) it is in the `start` stage: only the home/program buyers,
the batcher, invites and backdoors, and [`player-work-start.js`](singularity/player-work-start.js) (study, the gang invite where a gang only needs that, create port openers, then crime for cash; a
short pass every minute) run, so the batcher gets the free servers' RAM. From 64GB home [`player-work.js`](singularity/player-work.js)
(study, faction and company work, Tian Di Hui and city factions) takes over the player, and the Go bot, hacknet,
server buying and auto-destroy follow after the first home upgrades. The batcher
keeps at most a quarter of home (up to 64GB) free for typed commands.

### Settings for your point in the game

The choices that depend on where you are in the game live in [`config.js`](config.js): which augment
stats are worth buying, the reset rule, faction and company order, study target, city-faction
groups, hacknet/server/stock spending stages, how much income the home upgrades keep back, [`startup.js`](startup.js) stage thresholds and scripts to
skip, and the BitNode route for [`auto-destroy.js`](singularity/auto-destroy.js) (when the route is done and `w0r1d_d43m0n` is ready, nothing is destroyed or backdoored: you get a sticky notice, and `next-bitnode <n>` ends the BitNode when you choose; alias below). The defaults suit a hacking run with no
gang (for example BitNode 4).

To change them, don't edit [`config.js`](config.js): create `data/config.json` in the game
(`nano data/config.json`) with just what you want different. Objects merge key by key; lists
and single values replace the default. It stays in the game, so git and filesync never
overwrite it and each player keeps their own. For example, a player who wants combat and
crime augs too, no reset in the first hour of a run, and BitNode 5 after SF4.3:

```json
{
  "augments": {
    "wantStats": ["hacking", "rep", "hacknet", "darknet", "combat", "crime"],
    "resetRule": { "minRunMinutes": 60 }
  },
  "bitnodeRoute": [{ "bitNode": 4, "level": 3 }, { "bitNode": 5, "level": 1 }]
}
```

Stat groups: `hacking`, `rep`, `hacknet`, `darknet`, `combat`, `charisma`, `work`, `crime`,
`bladeburner`. `"profile"` picks a named preset from `PRESETS` in [`config.js`](config.js) first
(`hacking`, or `bladeburner` for the Bladeburner route). Scripts read the settings when they start, so restart them after a change.
`run /tools/show-config.js [section]` prints what the scripts will use, and
`run /tools/show-config.js --example` prints a starter `data/config.json` with your current
values to paste into `nano data/config.json`.

Settings that should differ by BitNode go in a `bitnodes` section keyed by BitNode number, in
[`config.js`](config.js) or in `data/config.json` (e.g. `"bitnodes": { "2": { "augments": { ... } } }`). The
current BitNode's entry applies automatically; [`startup.js`](startup.js) records which BitNode you're in
(`data/bitnode.txt`), so run it once in a new BitNode before relying on them.

### Planning your BitNode route and settings

Do this once, in the game, to tailor the scripts to your save:

1. **See where you are.** `run /tools/show-config.js` prints the settings the scripts will use, and `run /tools/status.js` shows the Source-File level this BitNode gives and the next BitNode on the route.
2. **Set the route without an editor.** `afk-route 4:3 2:1 5:1` (bitNode:level, done in order; a bare `afk-route 5` means one more level of BitNode 5 than you will own once this BitNode ends) stores the BitNode route in `data/config.json`; `afk-route` alone shows it, `afk-route clear` empties it. `set-config set <path> <value>` and `set-config unset <path>` change any other setting. Or create your file by hand: `run /tools/show-config.js --example` prints a starter `data/config.json`; paste it into `nano data/config.json`. Keep only the lines you want to change. If the file doesn't exist, the defaults apply.
3. **Set your route.** `bitnodeRoute` is a list of `{ "bitNode": N, "level": L }`, done in order. [`auto-destroy.js`](singularity/auto-destroy.js) enters the first entry whose Source-File level you don't have yet, counting the level the current destroy gives. Source-Files you already own are skipped automatically, so you can list your whole plan. The default route is empty: with no route (or once it's done) nothing is destroyed, you get one sticky notice, and `next-bitnode <n>` ends the BitNode when you choose.
4. **Tune a single BitNode.** Put settings that only apply in one BitNode under `"bitnodes": { "<N>": { ... } }`. They are laid over your other settings while you are in BitNode N. Run [`startup.js`](startup.js) once in a new BitNode so it records which one you are in.
5. **Pick a preset if one fits.** `"profile": "bladeburner"` (see `PRESETS` in [`config.js`](config.js)) swaps the augment weights for a Bladeburner run.
6. **Restart.** Scripts read the config when they start: `run /startup.js --restart`. Bad JSON gives a sticky alert and falls back to the defaults.

Example `data/config.json` for a player who plans BitNode 4 to Source-File 3, then 2, then 5, with combat augments while in BitNode 2:

```json
{
  "bitnodeRoute": [
    { "bitNode": 4, "level": 3 },
    { "bitNode": 2, "level": 1 },
    { "bitNode": 5, "level": 1 }
  ],
  "bitnodes": {
    "2": { "augments": { "wantStats": ["hacking", "rep", "combat", "crime"] } }
  }
}
```

Which BitNodes the scripts can use is listed in the "Needs" column of the folder table below. A BitNode with no support yet can still be on the route; the scripts just run the hacking core there.

### Aliases

Aliases always use absolute paths starting with `/` so they work from any directory.
Single quotes outside, plain double quotes inside.

```text
alias startup='run /startup.js';
alias restart='run /startup.js --restart';
alias status='run /tools/status.js';
alias debug-report='run /tools/debug-report.js; cat data/debug-report.txt';
alias config='run /tools/show-config.js';
alias set-config='run /tools/set-config.js';
alias afk-route='run /tools/set-config.js route';
alias track-income='run /tools/track-income.js; tail /tools/track-income.js';
alias hack-only='run /tools/track-income.js; run /hack/batcher.js';
alias gobot='run /go/ipvgo-bot.js --opponent "The Black Hand"';
alias solve-contracts='run /contracts/solve-contracts.js';
alias list-backdoors='run /tools/list-backdoors.js';
alias check-servers='run /tools/check-servers.js';
alias darknet-phishing='run /darknet/dnet-manager.js';
alias stock-trading='run /stocks/stock-trader.js';
alias upgrade-home='run /singularity/upgrade-home-ram.js --once; run /singularity/upgrade-home-cores.js --once';
alias auto-backdoor='run /singularity/auto-backdoor.js --once';
alias player-work='run /singularity/join-factions.js --once; run /singularity/player-work.js --once';
alias augs='run /singularity/buy-augs.js --dry';
alias buy-augs='run /singularity/buy-augs.js';
alias install-augs='run /singularity/install-augs.js /startup.js';
alias next-bitnode='run /singularity/next-bitnode.js';
alias exploits='run /tools/exploits/easy.js; run /tools/exploits/time-compression.js; run /tools/exploits/prototype-tampering.js; run /tools/exploits/unclickable.js';
```

## Folders

Each folder's README lists its scripts with flags and RAM cost, and links its design note.

| Folder | What it does | Needs |
| --- | --- | --- |
| [`hack/`](hack/README.md) | Multi-target JIT hack/grow/weaken batcher and its workers | nothing special |
| [`pserv/`](pserv/README.md) | Buys and upgrades purchased servers | nothing special |
| [`hacknet/`](hacknet/README.md) | Buys hacknet upgrades while they pay back fast enough | nothing special |
| [`stocks/`](stocks/README.md) | Stock market trading | nothing special |
| [`contracts/`](contracts/README.md) | Finds and solves coding contracts | nothing special |
| [`share/`](share/README.md) | Shares spare RAM for faction rep during faction work | nothing special |
| [`singularity/`](singularity/README.md) | Player automation: study, programs, home upgrades, backdoors, factions, company work, augs, resets, next BitNode | BitNode 4 or Source-File 4 |
| [`gang/`](gang/README.md) | Gang manager | BitNode 2 or Source-File 2 |
| [`bladeburner/`](bladeburner/README.md) | Bladeburner: state manager, action pass and route estimate | BitNode 6 or 7, or Source-File 6 or 7 |
| [`darknet/`](darknet/README.md) | Darknet crawler, password solvers, phishing and stasis links | `DarkscapeNavigator.exe` on home |
| [`go/`](go/README.md) | IPvGO bot | nothing special |
| [`tools/`](tools/README.md) | Manual tools: status, settings, state dump, income tracker, backdoor list, server checks, exploit achievements | nothing special |
| [`utils/`](utils/README.md) | Shared helpers | nothing special |
| [`docs/`](docs/README.md) | Design notes: why the scripts work the way they do | nothing special |
| [`archive/`](archive/README.md) | Older versions of scripts, kept for history (not synced to the game) | nothing special |

[`startup.js`](startup.js) (the stage-based launcher) and [`config.js`](config.js) (default settings and presets) stay at the root.

## Ports

| Port | Data |
| --- | --- |
| 20 | Darknet |
| 21 | Stock influence (servers to push up or down) |
| 22 | Total hacked money |
| 23 | Faction rep goals |
| 24 | Income rate ($/s, from the batcher) |
| 25 | City faction plan |
| 26 | Stock summary |
| 27 | Target stats and home cores (for the batcher) |
| 28 | Gang summary (for status) |
| 29 | Gang equipment list |
| 30 | Gang invite crimes (for player-work) |
| 31 | Batcher RAM claim (free RAM its batches still need; share-manager leaves it alone) |
| 32 | Contract wrong answers (solver to solve-contracts) |
| 33 | One-shot gates (cash the next home upgrade or program needs, player-work done, for startup.js) |
| 34 | RAM reservations (room kept free on a server for a script waiting to start; the batcher and share-manager leave it alone) |
| 35 | player-work state between passes |
| 36 | Bladeburner state, route estimate, rank samples and status lines (bladeburner/) |
| 37 | Last pass of each one-shot, for the debug report ([`utils/pass-log.js`](utils/pass-log.js)) |
| 38 | This run's money by source, for the augment weights ([`utils/income-mix.js`](utils/income-mix.js), posted by buy-augs.js) |

## Conventions

- **Design notes.** Why things are built the way they are (batching, startup stages, settings, aug resets, player work,
  RAM, darknet, stocks, Go, gang) is in [`docs/`](docs/), one short note per area, linked from each script's header.
- **Versioning.** When a working script is replaced by an improved one, the old copy is renamed
  `<name>-vX.js` (next unused number) and moved into [`archive/`](archive/). Bug fixes to a broken
  script overwrite it in place. Old versions are kept for history (and the file-count achievement).
- **Across BitNodes.** One folder per mechanic (like [`gang/`](gang/)) whose manager exits when its API
  isn't available; checks ask what the run can use, not which BitNode it is; per-BitNode tuning lives in
  [`config.js`](config.js); the core scripts stay the same everywhere. Details in [`AGENTS.md`](AGENTS.md).
- **Static RAM.** The game charges RAM for any identifier that matches an NS function name,
  so helpers are never named `hack`, `grow`, `exec`, `attempt`, `window` and so on. Heavy
  API calls live in one-shot scripts in each folder's `workers/` subfolder so long-running managers stay small.
- **Income.** Read money income with [`utils/income.js`](utils/income.js), not `ns.getTotalScriptIncome`
  (batcher workers exit on payout, so that reads about $0).
- **Notifications.** [`utils/notify.js`](utils/notify.js): FYI events are a short toast; things that need action
  get a sticky toast, a terminal line and a log line.
