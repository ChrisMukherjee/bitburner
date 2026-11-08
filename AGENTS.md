# Agent rules for this repo

Bitburner automation scripts. See [README.md](README.md) for setup, aliases and the folder list; each folder's README lists its scripts.

## API

- Always use the **Bitburner v3.0.0** Netscript API. [`NetscriptDefinitions.d.ts`](NetscriptDefinitions.d.ts) (refreshed from the game on connect) is the reference.

## Versioning old scripts

- Only when replacing a **working** script with an improved one: rename the current file to `<name>-vX.js` (next unused X, matching [`archive/`](archive/) numbering) and write the new version under the original name, then archive the `-vX` file as below.
- Never version a broken script: bug fixes overwrite in place. Skip versioning for small fixes too.
- [`archive/README.md`](archive/README.md) has one line per archived file (what it did, what the next version changed). Add a line when a file is archived.
- Archive the `-vX` file yourself, to the same subfolder under [`archive/`](archive/). With a shell on the user's machine (Remote Control), use `git mv` (plain move if the file is untracked). With folder access only, which can't move or delete, write the copy into [`archive/`](archive/) and tell the user which original to delete. Either way, remind the user to `rm` the old path in game, since filesync never deletes.

## Aliases

- Use absolute script paths starting with `/`, single quotes outside, plain double quotes inside: `alias status='run /tools/status.js'`.

## Structure across BitNodes

Each BitNode adds a mechanic. These rules keep the scripts from growing a branch per BitNode.

- **One folder per mechanic.** [`gang/`](gang/) is the model; later ones get their own (`bladeburner/`, `corp/`, `sleeves/` ...). The mechanic's manager, its helpers and its one-shot workers live in that folder, workers in a `workers/` subfolder ([`gang/workers/`](gang/workers/), [`singularity/workers/`](singularity/workers/)). The same goes for the core concepts ([`hack/`](hack/), [`stocks/`](stocks/), [`contracts/`](contracts/), [`share/`](share/), [`pserv/`](pserv/), [`hacknet/`](hacknet/)); there is no top-level `workers/`. Only [`startup.js`](startup.js) and [`config.js`](config.js) stay at the root. Helpers used by one concept live in its folder, shared ones in [`utils/`](utils/). Its manager checks that the API is usable and exits cleanly (one message, no error) when it isn't. If it should only start once there's work, the folder exports a ready check that [`startup.js`](startup.js) imports, like [`gang/ready.js`](gang/ready.js).
- **Say what each script needs.** Requirements vary per script, not per folder. Every script table in a folder README has a `Requires` column using the tags in the root README's [Requirements](README.md#requirements) section (`none`, `SF4`, `SF2`, `SF6/7`, `SF5`, `Formulas`, `Darknet`, `TIX`/`4S`; `(opt)` after a tag when the script falls back without it). Derive the value from the code (the API calls it makes, the capability helper it imports, what it starts), not from the folder. A hard tag means the script exits cleanly without it (see the capability rule below). Folder-wide notes (what happens without an API, RAM multipliers) are plain prose under the README intro, not a "Needs" quote, and BitNode numbers stay out of the intro line. A new tag or capability helper goes in the root legend.
- **Check what's available, not which BitNode you're in.** Ask "can this run use the Gang API?", never `currentNode === 2`. Capability checks live in one helper per API, like [`utils/singularity.js`](utils/singularity.js) and [`utils/gang.js`](utils/gang.js); scripts import it instead of reading `getResetInfo()` themselves. A real game rule that does depend on the BitNode number (e.g. no karma needed for a gang in BitNode 2) is written once, inside that helper.
- **BitNode tuning only in [`config.js`](config.js).** Values that should differ between BitNodes go in its `bitnodes` section (keyed by BitNode number, applied automatically by `loadConfig`), never `if (bn === N)` in a script. Script `CONFIG` blocks are for engine timing and game constants only.
- **Small, stable core.** The core ([`startup.js`](startup.js), [`hack/batcher.js`](hack/batcher.js), [`pserv/pserv-manager.js`](pserv/pserv-manager.js), [`hacknet/hacknet-manager.js`](hacknet/hacknet-manager.js), [`stocks/stock-trader.js`](stocks/stock-trader.js), [`tools/status.js`](tools/status.js), [`utils/`](utils/)) works the same in every BitNode and doesn't know about any one mechanic's details. A new mechanic adds a folder, one line (plus its ready-check import) to `startup.js`, and its summary port to `MECHANIC_PORTS` in `status.js`, where its manager posts `{ time, title, script, lines }`; no branches in the core. The one exception is player focus: a mechanic that needs the player (e.g. crimes for a gang invite) adds a step to [`singularity/player-work.js`](singularity/player-work.js).

## Settings

- Choices that depend on the player's progress (aug stats worth buying, reset rule, faction/company order, study target, city groups, spending stages, startup stages, BitNode route) belong in [`config.js`](config.js) (`DEFAULTS`, `PRESETS`), read with `loadConfig(ns)` from [`utils/config.js`](utils/config.js) (0GB). Don't hardcode new ones in scripts.
- Each player's overrides are in-game `data/config.json`, merged over the defaults (objects merge, lists replace). Never assume it exists.
- "Worth buying" for augments is `wantedBoosts` in [`utils/aug-filter.js`](utils/aug-filter.js); buy-augs, faction-goals and city-plan all use it.
- Workers that load the config and are copied to another server need [`config.js`](config.js), [`utils/config.js`](utils/config.js), [`utils/notify.js`](utils/notify.js) (and [`utils/aug-filter.js`](utils/aug-filter.js)) copied too.

## Coding gotchas

Before writing or changing a script, read [`docs/NETSCRIPT.md`](docs/NETSCRIPT.md): RAM-checker name matching, income, alerts, the port list, who owns player focus, and when to use one-shot workers.

## Sync to the game

- bitburner-filesync (`npm run sync`, port 12525) is **one way** (disk to game), never deletes in game, and skips [`archive/`](archive/). Moving or renaming a file must also be done in game.
- Files the game writes (e.g. `data/*.txt`) never reach disk; ask the user to paste them.

## Workflow

- The user commits and pushes themselves unless they ask otherwise.
- Writing to the user's PC from a cloud session: the shared project folder can serve a stale copy for a few seconds after an edit. After every copy to the device, read the file back from the device and confirm it has your change before saying it's done.

## Which model for which task

Advice only; the user or coordinator picks per thread.

- **Default:** Sonnet 5.5 (`claude-sonnet-5-5`) at medium effort for routine work: small fixes, READMEs and docs, config tweaks, ports, archiving, status checks.
- **Hard logic:** Opus (`claude-opus-5-5`) at high effort for batcher timing and bugs, aug-reset and Red Pill decisions, income-curve forecasting, root-causing stalls, and multi-file redesigns.
- **Trivial edits:** low effort.
- **If a Sonnet fix fails in game,** rerun it on Opus.

## Write for any user

Docs (including [`docs/`](docs/)), rules, script output and code comments should make sense to anyone who uses these scripts. Don't name people or refer to one person's machine, folders or setup; say "the user" instead.

## Design notes

- Record design decisions in [`docs/`](docs/): one short note per area (the decision, why, tradeoffs and rejected alternatives, current state). Not flag lists or history; see [`docs/README.md`](docs/README.md).
- When a change makes or reverses a design decision, update its note in the same change. A new area gets a new note, listed in [`docs/README.md`](docs/README.md).
- Link the note from the script's first line: `// Design: docs/<name>.md`. Read the note before changing a script that has one.

## Keep the READMEs up to date

Update docs in the same change as the code, not later.

- **Folder READMEs**: every script must be listed in its folder's `README.md`, one line with what it does, its flags, what it requires (the `Requires` tag, see above), its RAM cost and a link to its [`docs/`](docs/) note if it has one. Update the line in the same change when any of these change. A new folder gets a README and a row in the root README.
- **[README.md](README.md)**: update it when folders, aliases or ports change, or when a script's behaviour changes in a way it describes.
- **[archive/README.md](archive/README.md)**: add a line (what the file did, what the next version changed) whenever a file is archived or removed.
- **AGENTS.md** and **[docs/NETSCRIPT.md](docs/NETSCRIPT.md)**: update them when a project rule, convention or port changes (ports and coding gotchas live in NETSCRIPT.md).
- **Links:** in docs (READMEs, AGENTS.md), write references to repo files and folders as relative Markdown links, relative to the doc they are in, so they work on GitHub: [`tools/exploits/README.md`](tools/exploits/README.md) from the root README, `../hack/batcher.js` from `archive/README.md`. Only link paths that exist in the repo. Leave in-game commands (`run /tools/status.js`), code blocks and in-game files (`data/config.json`) as plain code.
