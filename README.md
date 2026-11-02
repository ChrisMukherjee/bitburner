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
  It is re-run automatically after home RAM upgrades, new port openers, augmentation installs
  and when entering a new BitNode.
- **Multi-target JIT batcher** ([`batcher.js`](batcher.js)). Just-in-time HWGW batches across up to 25 targets,
  using Formulas.exe when owned and a cheap stats helper when not. Picks the hack fraction with
  the best $/s per target and posts its income rate for other scripts to read.
- **Full Singularity loop.** Studies, buys programs and home upgrades, backdoors servers,
  joins factions (including the right city factions), works for factions and companies toward
  real rep goals, plans augmentation purchases, decides when a reset is worth it, and destroys
  the BitNode by itself once The Red Pill is installed.
- **Coding contracts.** [`workers/contract-solver.js`](workers/contract-solver.js) solves all 30 contract types in the game
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
run /tools/status.js     # one-screen summary of the whole run
```

`status` also has a BitNode line: the SF level destroying this node gives, the next BitNode on
`bitnodeRoute`, and how far along the end is (Daedalus invite needs, Daedalus rep against The Red
Pill's requirement, then hacking level and root for `w0r1d_d43m0n`). The Red Pill and Daedalus
numbers come from `data/aug-plan.json`, which [`auto-reset.js`](singularity/auto-reset.js) refreshes every 10 minutes.

[`startup.js`](startup.js) holds one priority-ordered list of long-running scripts, each tagged with the
stage it starts in. It skips anything already running and exits once everything is launched.
Below 64GB home (a fresh BitNode) it is in the `start` stage: only the home/program buyers,
the batcher, invites and backdoors, and [`player-work.js`](singularity/player-work.js) (study, faction and company work,
Tian Di Hui and city factions) run, so the batcher gets the free servers' RAM; the Go bot, hacknet,
server buying and auto-destroy follow after the first home upgrades. The batcher
keeps at most a quarter of home (up to 64GB) free for typed commands.

### Settings for your point in the game

The choices that depend on where you are in the game live in [`config.js`](config.js): which augment
stats are worth buying, the reset rule, faction and company order, study target, city-faction
groups, hacknet/server/stock spending stages, [`startup.js`](startup.js) stage thresholds and scripts to
skip, and the BitNode route for [`auto-destroy.js`](singularity/auto-destroy.js). The defaults suit a hacking run with no
gang (for example BitNode 4).

To change them, don't edit [`config.js`](config.js): create `data/config.json` in the game
(`nano data/config.json`) with just what you want different. Objects merge key by key; lists
and single values replace the default. It stays in the game, so git and filesync never
overwrite it and each player keeps their own. For example, a player who wants combat and
crime augs too, bigger reset batches, and BitNode 5 after SF4.3:

```json
{
  "augments": {
    "wantStats": ["hacking", "rep", "hacknet", "darknet", "combat", "crime"],
    "resetRule": { "minAugs": 8 }
  },
  "bitnodeRoute": [{ "bitNode": 4, "level": 3 }, { "bitNode": 5, "level": 1 }]
}
```

Stat groups: `hacking`, `rep`, `hacknet`, `darknet`, `combat`, `charisma`, `work`, `crime`,
`bladeburner`. `"profile"` picks a named preset from `PRESETS` in [`config.js`](config.js) first (only
`hacking` so far). Scripts read the settings when they start, so restart them after a change.
`run /tools/show-config.js [section]` prints what the scripts will use, and
`run /tools/show-config.js --example` prints a starter `data/config.json` with your current
values to paste into `nano data/config.json`.

### Aliases

Aliases always use absolute paths starting with `/` so they work from any directory.
Single quotes outside, plain double quotes inside.

```text
alias startup='run /startup.js'
alias status='run /tools/status.js'
alias config='run /tools/show-config.js'
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
alias exploits='run /tools/exploits/easy.js; run /tools/exploits/time-compression.js; run /tools/exploits/prototype-tampering.js; run /tools/exploits/unclickable.js'
```

## Layout

| Path | What it does |
| --- | --- |
| [`startup.js`](startup.js) | Stage-based launcher (see above) |
| [`config.js`](config.js) | Default settings and presets for the choices that depend on your progress (see Settings) |
| [`batcher.js`](batcher.js) | Multi-target JIT hack/grow/weaken batcher |
| [`pserv-manager.js`](pserv-manager.js) | Buys and upgrades purchased servers |
| [`hacknet-manager.js`](hacknet-manager.js) | Buys hacknet upgrades while they pay back fast enough for the current income |
| [`share-manager.js`](share-manager.js) | Shares spare RAM for faction rep, only while doing faction work |
| [`stock-trader.js`](stock-trader.js) | Stock market trading (`--buy-4s`, `--promote N`, `--no-influence`) |
| [`solve-contracts.js`](solve-contracts.js) | Finds coding contracts and hands them to [`workers/contract-solver.js`](workers/contract-solver.js) |
| [`singularity/`](singularity/) | Player automation: study, programs, home upgrades, backdoors, factions, company work, augs, resets, [`next-bitnode.js <n>`](singularity/next-bitnode.js) |
| [`darknet/`](darknet/) | Darknet crawler, password solvers, phishing and stasis links ([`dnet-manager.js`](darknet/dnet-manager.js) is the entry point) |
| [`gang/`](gang/) | Gang manager for BitNode 2 ([`gang-manager.js`](gang/gang-manager.js)), see below |
| [`go/`](go/) | IPvGO bot ([`ipvgo-bot.js`](go/ipvgo-bot.js)) and its move search ([`choose-move.js`](go/choose-move.js)) |
| [`workers/`](workers/) | Small scripts exec'd by managers: hack/grow/weaken, contract solver, faction goals, market access, share, gang equipment and gang invite |
| [`utils/`](utils/) | Shared helpers: server list, nuking, RAM pool, target scoring, spending rules, income rate, toasts, config loading, aug filter, BitNode route, Singularity check, one-shot helper launcher |
| [`tools/`](tools/) | Manual tools: status, settings ([`show-config.js`](tools/show-config.js)), state dump, income tracker, backdoor list, server checks |
| [`tools/exploits/`](tools/exploits/) | One-shot scripts for the hidden "Exploit:" achievements (Source-File -1), see below |
| [`archive/`](archive/) | Older versions of scripts, kept for history (not synced to the game) |

### Singularity scripts

> **Needs BitNode 4 or Source-File 4.** Everything in [`singularity/`](singularity/) uses the Singularity
> API, which only works in BitNode 4 or with Source-File 4. Outside BitNode 4 every Singularity
> function also costs more RAM: 16x at SF4.1, 4x at SF4.2 and the normal cost at SF4.3, so these
> scripts may not fit in a small home until SF4.3.
>
> Without it, [`startup.js`](startup.js) leaves out every Singularity script by itself (one line says how
> many) and starts the rest: batcher, servers, hacknet, Go, contracts, darknet, stocks. Buy home RAM and
> programs by hand and run `startup` again for the next stage. [`share-manager.js`](share-manager.js) can't see
> faction work, so startup skips it; run it with `--always` to share anyway. [`tools/status.js`](tools/status.js)
> shows work and faction goals as unknown. The check is in [`utils/singularity.js`](utils/singularity.js).
> [`workers/faction-goals.js`](workers/faction-goals.js), [`workers/city-plan.js`](workers/city-plan.js) and
> [`utils/aug-filter.js`](utils/aug-filter.js) also use the API, but only Singularity scripts run them.

| Script | Role |
| --- | --- |
| [`player-work.js`](singularity/player-work.js) | The one script that moves the player: free CS course until hacking 75, then faction work for the next faction below its real rep goal (order in `factionWork`), megacorp jobs when no faction needs rep; in BitNode 2 crimes for the gang invite first (after study); also flies to get Tian Di Hui and the one city-faction group whose augs are still wanted (`--focus`, `--study N`, `--no-company`, `--plan` prints the city plan) |
| [`buy-programs.js`](singularity/buy-programs.js) | TOR, port openers, DarkscapeNavigator.exe, Formulas.exe |
| [`upgrade-home-ram.js`](singularity/upgrade-home-ram.js) / [`upgrade-home-cores.js`](singularity/upgrade-home-cores.js) | Home upgrades within the spending rules (`--once` for a single pass) |
| [`auto-backdoor.js`](singularity/auto-backdoor.js) | Backdoors faction and company servers (`--daemon` also does w0r1d_d43m0n) |
| [`join-factions.js`](singularity/join-factions.js) | Accepts invites; city ones only when they lock out no wanted city faction (same rival group already joined, or the city plan wants nothing), or all with `--cities` |
| [`buy-augs.js`](singularity/buy-augs.js) | Plans and buys useful augs, most expensive first (`--dry` shows the plan and reset advice; what counts as useful is `augments` in the config) |
| [`auto-reset.js`](singularity/auto-reset.js) | Watches the plan and buys + installs augs when a reset pays off; on by default in [`startup.js`](startup.js) mid stage (`--dry` only logs) |
| [`install-augs.js`](singularity/install-augs.js) | Installs augs and runs a script afterwards; refuses unless the advice says RESET (or `--force`) |
| [`next-bitnode.js <n>`](singularity/next-bitnode.js) | Destroys w0r1d_d43m0n and enters BitNode n |
| [`auto-destroy.js`](singularity/auto-destroy.js) | Runs [`next-bitnode.js`](singularity/next-bitnode.js) by itself once The Red Pill is installed and hacking level and root allow; the next BitNode comes from `bitnodeRoute` in the config (BN4 until SF4.3, then BN2 once), then it waits for you (`--bn N` overrides, `--dry` only says) |

### Gang (BitNode 2)

> **Untested in game.** Written against the v3.0.0 Gang API before reaching BitNode 2. Tail
> `gang/gang-manager.js` on the first run; every decision is logged.

[`gang/gang-manager.js`](gang/gang-manager.js) runs the gang; settings are `gang` in the config. [`startup.js`](startup.js)
starts it once a gang exists or a gang faction is joined (BitNode 2, or Source-File 2 with karma -54,000).

- **Combat or hacking.** The gang type comes from the faction it's created with, and can't be changed
  later. The default is a combat gang with Slum Snakes: more money (Human Trafficking) and stronger in
  territory clashes. The invite needs combat stats 30 and karma -9, so in BitNode 2
  [`player-work.js`](singularity/player-work.js) commits crimes (Mug, later Homicide) after study until it
  arrives. Set `gang.factions` to `["NiteSec", "The Black Hand"]` for a hacking gang instead: no crimes,
  since the hacking scripts get the NiteSec invite anyway, but less money.
- **Recruits** whenever respect allows; **ascends** a member once their main stat multiplier would grow
  1.5x (`ascendAt`).
- **Tasks:** members train until `trainLevel`; the rest earn respect until the gang is full (12), then
  money. Each gets the task that pays them most, found by trying each task and reading the gain back.
  Above a 5% wanted penalty the weakest earners do Vigilante Justice / Ethical Hacking until it's below 1%.
- **Territory:** with a full gang, half the trained members do Territory Warfare. Clashes go on at a 55%
  win chance against every gang still holding territory and off below 50%.
- **Equipment:** once a minute, augmentations first (they survive ascension), then the cheapest useful
  item, within the `gang.buying` spending stages. `--no-buy` and `--no-war` turn parts off.

### Exploit scripts

Each hidden "Exploit:" achievement also adds a level of Source-File -1. The `exploits` alias runs
the first four below; the others need a hand.

| Script | Achievement | Notes |
| --- | --- | --- |
| [`easy.js`](tools/exploits/easy.js) | undocumented, rainbow, bypass | Must stay at 1.6GB for bypass to count |
| [`time-compression.js`](tools/exploits/time-compression.js) | time compression | Speeds up the game's 15s timer once, ~20s |
| [`prototype-tampering.js`](tools/exploits/prototype-tampering.js) | prototype tampering | Waits for the game's 15-minute check, ~16 min |
| [`unclickable.js`](tools/exploits/unclickable.js) | unclickable | Shows a red box; click it yourself |
| [`dev-menu.js`](tools/exploits/dev-menu.js) | you're not meant to access this | Opens the hidden Dev menu |
| [`alter-reality.js`](tools/exploits/alter-reality.js) | reality alteration | Needs a DevTools breakpoint, steps in the file |
| [`edit-save.py`](tools/exploits/edit-save.py) | edit | Run on an exported save outside the game, then import it |

Step-by-step instructions for every one, including the manual ones, are in
[`tools/exploits/README.md`](tools/exploits/README.md).

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
| 28 | Gang summary (for status) |
| 29 | Gang equipment list |
| 30 | Gang invite crimes (for player-work) |

## Conventions

- **Versioning.** When a working script is replaced by an improved one, the old copy is renamed
  `<name>-vX.js` (next unused number) and later moved into [`archive/`](archive/). Bug fixes to a broken
  script overwrite it in place. Old versions are kept for history (and the file-count achievement).
- **Static RAM.** The game charges RAM for any identifier that matches an NS function name,
  so helpers are never named `hack`, `grow`, `exec`, `attempt`, `window` and so on. Heavy
  API calls live in one-shot [`workers/`](workers/) scripts so long-running managers stay small.
- **Income.** Read money income with [`utils/income.js`](utils/income.js), not `ns.getTotalScriptIncome`
  (batcher workers exit on payout, so that reads about $0).
- **Notifications.** [`utils/notify.js`](utils/notify.js): FYI events are a short toast; things that need action
  get a sticky toast, a terminal line and a log line.
