# bitburner

Bitburner automation scripts, written against the **Bitburner v3.0.0** Netscript API.

The goal is a mostly hands-off run: type `startup` once per BitNode and the scripts
root servers, farm money, buy upgrades and programs, grind factions, buy augmentations and
reset by themselves.


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
[`NetscriptDefinitions.d.ts`](NetscriptDefinitions.d.ts) is refreshed from the game on connect, for editor autocomplete and type checking (add `// @ts-check` to a script; see [`docs/typecheck.md`](docs/typecheck.md)). The `.d.ts` and `jsconfig.json` files are never synced to the game (filesync only pushes `.js` and `.txt`).

`npm test` runs the automated tests in [`tests/`](tests/README.md) with Node 22 or later: the reset rule, the batcher's
thread math, the gym and study choices, the config layers and repo checks (imports, README listings, aliases), outside
the game with a fake `ns`. Run it after changing a script; it prints the name of anything that broke. The tests are
`.mjs` files, so filesync never pushes them. GitHub runs the tests and the type check on every push
([`.github/workflows/test.yml`](.github/workflows/test.yml)), so a commit that breaks one shows a red cross. `npm run test:changed` lists the tests a change edited (for its report),
and `npm run mutate -- <script>` shows which of a script's conditions no test would notice breaking. Why and how:
[`docs/testing.md`](docs/testing.md).

To type-check the scripts that start with `// @ts-check`, run `npx -p typescript tsc -p jsconfig.json` from the
repo root (no alias or npm script for it; it prints nothing when everything is clean). Details:
[`docs/typecheck.md`](docs/typecheck.md).

## Aliases

Aliases keep the commands short, so these docs mention the alias by default (`status`, not
`run /tools/status.js`) and spell out the full `run` command only where no alias exists. Type the lines
below into the game terminal once (the terminal also takes them one at a time); aliases stay saved in the game.
Aliases always use absolute paths starting with `/` so they work from any directory.
Single quotes outside, plain double quotes inside.

```text
alias startup='run /startup.js';
alias restart='run /startup.js --restart';
alias status='run /tools/status.js';
alias debug-report='run /tools/debug-report.js; cat data/debug-report.txt';
alias eta='cat /data/node-eta.txt';
alias config='run /tools/show-config.js';
alias set-config='run /tools/set-config.js';
alias afk-route='run /tools/set-config.js route';
alias track-income='run /tools/track-income.js; tail /tools/track-income.js';
alias hack-only='run /tools/track-income.js; run /hack/batcher.js';
alias gobot='run /go/go-bot.js';
alias solve-contracts='run /contracts/solve-contracts.js';
alias list-backdoors='run /tools/list-backdoors.js';
alias check-servers='run /tools/check-servers.js';
alias darknet-phishing='run /darknet/dnet-manager.js';
alias gang-report='run /gang/gang-report.js';
alias stock-trading='run /stocks/stock-trader.js';
alias upgrade-home='run /singularity/upgrade-home-ram.js --once; run /singularity/upgrade-home-cores.js --once';
alias auto-backdoor='run /singularity/auto-backdoor.js --once';
alias player-work='run /singularity/join-factions.js --once; run /singularity/player-work.js --once';
alias augs='run /singularity/buy-augs.js --dry';
alias buy-augs='run /singularity/buy-augs.js';
alias install-augs='run /singularity/install-augs.js /startup.js';
alias next-bitnode='run /singularity/next-bitnode.js';
alias clean-home='run /tools/clean-home.js';
```

### Achievement aliases

Only needed when chasing achievements, see [`achievements/`](achievements/README.md).

```text
alias challenge='run /tools/set-config.js challenge';
alias exploits='run /achievements/exploits/easy.js; run /achievements/exploits/time-compression.js; run /achievements/exploits/prototype-tampering.js; run /achievements/exploits/unclickable.js';
```

## Running it

```text
startup        # pick the stage from home RAM (early >= 64GB, mid >= 128GB, late >= 256GB)
startup mid    # force a stage
restart        # also restart running scripts, so freshly synced code takes effect
status         # one-screen summary of the whole run
```

`status` also has a BitNode block: the SF level destroying this node gives, the next BitNode on
`bitnodeRoute`, and how far along each way out is. The hacking route shows the Daedalus invite (augs installed against the count, cash,
level), Daedalus rep against The Red Pill's requirement, then hacking level and root for `w0r1d_d43m0n`; the Bladeburner route shows
Black Ops done of the total, rank and the next Black Op's chance. The route the estimate picked is spelled out, the other is one line
(`status.routeProgress`, see [`docs/bladeburner.md`](docs/bladeburner.md#progress-toward-ending-the-bitnode)). The Red Pill and Daedalus
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
groups, hacknet/server/stock spending stages and the stock trader's switches (`stocks`), how much income the home upgrades keep back, [`startup.js`](startup.js) stage thresholds and scripts to
skip, and the BitNode route for [`auto-destroy.js`](singularity/auto-destroy.js) (when the route is done and `w0r1d_d43m0n` is ready, nothing is destroyed or backdoored: you get a sticky notice, and `next-bitnode <n>` ends the BitNode when you choose; alias above). The defaults suit a hacking run with no
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
`config [section]` prints what the scripts will use, and
`config --example` prints a starter `data/config.json` with your current
values to paste into `nano data/config.json`.

Settings that should differ by BitNode go in a `bitnodes` section keyed by BitNode number, in
[`config.js`](config.js) or in `data/config.json` (e.g. `"bitnodes": { "2": { "augments": { ... } } }`). The
current BitNode's entry applies automatically; [`startup.js`](startup.js) records which BitNode you're in
(`data/bitnode.txt`), so run it once in a new BitNode before relying on them.

With Source-File 5, [`startup.js`](startup.js) also does not start the batcher where hacking pays almost nothing (`hackWorth` in the config) and leaves out hacknet or the gang in a BitNode whose multiplier for them is below 0.1 (`mechanicGates` in the config; `force` or `enabled: false` overrides it).

### Planning your BitNode route and settings

New to the repo? Read [`docs/bitnode-order.md`](docs/bitnode-order.md) first: the order to do every BitNode in, from a new save to BitNode 12 (BitNode 1 twice, Source-File 4 to level 3, then 5, 1.3, gangs, Bladeburner, sleeves and on), what each Source-File gives and what the scripts do with it. It is the default `bitnodePlan`.

Do this once, in the game, to tailor the scripts to your save:

1. **See where you are.** `config` prints the settings the scripts will use, and `status` shows the Source-File level this BitNode gives and the next BitNode on the route.
2. **Set the route without an editor.** `afk-route 4:3 2:1 5:1` (bitNode:level, done in order; a bare `afk-route 5` means one more level of BitNode 5 than you will own once this BitNode ends) stores the BitNode route in `data/config.json`; `afk-route` alone shows it, `afk-route clear` empties it. `set-config set <path> <value>` and `set-config unset <path>` change any other setting. Or create your file by hand: `config --example` prints a starter `data/config.json`; paste it into `nano data/config.json`. Keep only the lines you want to change. If the file doesn't exist, the defaults apply.
3. **Set your route.** `bitnodeRoute` is a list of `{ "bitNode": N, "level": L }`, done in order. [`auto-destroy.js`](singularity/auto-destroy.js) enters the first entry whose Source-File level you don't have yet, counting the level the current destroy gives. Source-Files you already own are skipped automatically, so you can list your whole plan. With the route empty, the next BitNode is only *suggested* (in `status`, and in the notice) from `bitnodePlan` and the Source-Files you own, easiest multipliers first when you have Source-File 5; set `bitnodeRouteAuto` to `true` to let it follow that by itself. Your own route always wins. The default route is empty: with no route (or once it's done) nothing is destroyed, you get one sticky notice, and `next-bitnode <n>` ends the BitNode when you choose.
4. **Tune a single BitNode.** Put settings that only apply in one BitNode under `"bitnodes": { "<N>": { ... } }`. They are laid over your other settings while you are in BitNode N. Run [`startup.js`](startup.js) once in a new BitNode so it records which one you are in.
5. **Going for a challenge achievement?** `challenge bn1` (alias above) caps home at 128GB and 1 core while in BitNode 1, for "BN1: Challenge"; set it before that BitNode starts and `challenge clear` afterwards. Steps: [`achievements/bn1-challenge.md`](achievements/bn1-challenge.md).
6. **Pick a preset if one fits.** `"profile": "bladeburner"` (see `PRESETS` in [`config.js`](config.js)) swaps the augment weights for a Bladeburner run.
7. **Restart.** Scripts read the config when they start: `restart`. Bad JSON gives a sticky alert and falls back to the defaults.

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

Which BitNodes and Source-Files a script needs is in the "Requires" column of its folder README (see [Requirements](#requirements)). A BitNode with no support yet can still be on the route; the scripts just run the hacking core there.

## Folders

Each folder's README lists its scripts with flags and RAM cost, and links its design note.

| Folder | What it does |
| --- | --- |
| [`hack/`](hack/README.md) | Multi-target JIT hack/grow/weaken batcher and its workers |
| [`pserv/`](pserv/README.md) | Buys and upgrades purchased servers |
| [`hacknet/`](hacknet/README.md) | Buys hacknet upgrades while they pay back fast enough |
| [`stocks/`](stocks/README.md) | Stock market trading |
| [`contracts/`](contracts/README.md) | Finds and solves coding contracts |
| [`share/`](share/README.md) | Shares spare RAM for faction rep during faction work |
| [`singularity/`](singularity/README.md) | Player automation: study, programs, home upgrades, backdoors, factions, company work, augs, resets, next BitNode |
| [`gang/`](gang/README.md) | Gang manager, growth planner and metrics report |
| [`bladeburner/`](bladeburner/README.md) | Bladeburner: state manager, action pass and route estimate |
| [`darknet/`](darknet/README.md) | Darknet crawler, password solvers, phishing and stasis links |
| [`go/`](go/README.md) | IPvGO bot |
| [`achievements/`](achievements/README.md) | Which achievements the scripts earn by themselves, which need a step, and how |
| [`tools/`](tools/README.md) | Manual tools: status, settings, state dump, income tracker, backdoor list, server checks |
| [`utils/`](utils/README.md) | Shared helpers |
| [`docs/`](docs/README.md) | Design notes: why the scripts work the way they do, and [which BitNodes to do first](docs/bitnode-order.md) |
| [`archive/`](archive/README.md) | Older versions of scripts, kept for history (not synced to the game) |
| [`tests/`](tests/README.md) | Automated tests run with `npm test` on your PC (not synced to the game) |

[`startup.js`](startup.js) (the stage-based launcher) and [`config.js`](config.js) (default settings and presets) stay at the root.

## Requirements

Which scripts need which BitNode, Source-File or item is not decided per folder: a folder can mix scripts that work everywhere with ones that need an API. So every script table in a folder README has a **Requires** column, using these tags:

| Tag | Means | Check in the code |
| --- | --- | --- |
| `none` | Works in any run, on any home | |
| `SF4` | Singularity API: BitNode 4, or Source-File 4 (RAM costs 16x at SF4.1, 4x at SF4.2, normal at SF4.3) | [`utils/singularity.js`](utils/singularity.js) |
| `SF2` | Gang API: BitNode 2, or Source-File 2 (outside BitNode 2 the gang also needs karma -54,000) | [`utils/gang.js`](utils/gang.js) |
| `SF6/7` | Bladeburner API: BitNode 6 or 7, or Source-File 6 or 7 | [`utils/bladeburner.js`](utils/bladeburner.js) |
| `SF5` | BitNode multipliers: BitNode 5, or Source-File 5 (also gives Formulas.exe and the Intelligence stat) | [`utils/sf5.js`](utils/sf5.js) |
| `SF14.2` | IPvGO cheat API (`ns.go.cheat`): Source-File 14 level 2 | `ns.go.getCheatSuccessChance()` in [`go/anticheat.js`](go/anticheat.js) |
| `Formulas` | `Formulas.exe` on home | `ns.fileExists("Formulas.exe", "home")` |
| `Darknet` | `DarkscapeNavigator.exe` on home (the darknet API) | [`darknet/ready.js`](darknet/ready.js) |
| `TIX`, `4S` | Stock market API access and 4S market data; stock-trader buys them itself, so it only waits for cash | `ns.stock.hasTixApiAccess()` |

- A tag without a note is a **hard** requirement: without it the script exits cleanly, is left out by [`startup.js`](startup.js), or can't do its job.
- **`(opt)`** means the script uses the feature when it is there and falls back when it is not (for example `Formulas (opt)`: exact numbers with Formulas.exe, estimates without). Several tags are separated by commas; a script needs all its hard tags.
- A script that starts or reads another script's output lists that script's requirements too (`next-bitnode.js` starts a Singularity worker, so it is `SF4`). The capability helpers themselves are `none`: they are the check.
- A new script must state its requirement here and in its folder README; see [`AGENTS.md`](AGENTS.md).

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
| 36 | Bladeburner state, route estimate, Black Op progress, rank samples, efficiency figures, Black Op team plan and status lines (bladeburner/) |
| 37 | Last pass of each one-shot, for the debug report ([`utils/pass-log.js`](utils/pass-log.js)) |
| 38 | This run's money by source, for the augment weights ([`utils/income-mix.js`](utils/income-mix.js), posted by buy-augs.js) |
| 39 | The crime-faction invite to work on next, on the Bladeburner route ([`singularity/workers/crime-invites.js`](singularity/workers/crime-invites.js), for player-work.js) |

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
