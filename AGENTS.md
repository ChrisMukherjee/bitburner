# Agent rules for this repo

Bitburner automation scripts. See [README.md](README.md) for what each script does, setup and aliases.

## API

- Always use the **Bitburner v3.0.0** Netscript API. [`NetscriptDefinitions.d.ts`](NetscriptDefinitions.d.ts) (refreshed from the game on connect) is the reference.

## Versioning old scripts

- Only when replacing a **working** script with an improved one: rename the current file to `<name>-vX.js` (next unused X, matching [`archive/`](archive/) numbering) and write the new version under the original name. The user moves the `-vX` file into [`archive/`](archive/) themselves.
- Never version a broken script: bug fixes overwrite in place. Skip versioning for small fixes too.
- [`archive/README.md`](archive/README.md) has one line per archived file (what it did, what the next version changed). Add a line when a file is archived.
- Don't move files into [`archive/`](archive/) yourself.

## Aliases

- Use absolute script paths starting with `/`, single quotes outside, plain double quotes inside: `alias status='run /tools/status.js'`.

## Settings

- Choices that depend on the player's progress (aug stats worth buying, reset rule, faction/company order, study target, city groups, spending stages, startup stages, BitNode route) belong in [`config.js`](config.js) (`DEFAULTS`, `PRESETS`), read with `loadConfig(ns)` from [`utils/config.js`](utils/config.js) (0GB). Don't hardcode new ones in scripts.
- Each player's overrides are in-game `data/config.json`, merged over the defaults (objects merge, lists replace). Never assume it exists.
- "Worth buying" for augments is `wantedBoosts` in [`utils/aug-filter.js`](utils/aug-filter.js); buy-augs, faction-goals and city-plan all use it.
- Workers that load the config and are copied to another server need [`config.js`](config.js), [`utils/config.js`](utils/config.js), [`utils/notify.js`](utils/notify.js) (and [`utils/aug-filter.js`](utils/aug-filter.js)) copied too.

## Coding gotchas

- **RAM check matches names.** The static RAM checker charges any identifier named like an NS function (a local helper `attempt` cost 10GB, `window` 25GB). Never name helpers `attempt`, `hack`, `grow`, `weaken`, `spawn`, `exec`, `run`, `kill`, `scan`, `share`, `window`, etc.
- **Income:** never use `ns.getTotalScriptIncome` for money income (batcher hack workers exit on payout, so it reads ~$0). Use `readIncomeRate(ns)` from [`utils/income.js`](utils/income.js).
- **Alerts:** use `notify(ns, tag, message, variant, terminal)` from [`utils/notify.js`](utils/notify.js) (0GB). FYI/good news = toast only. Things the user must act on = `terminal = true` (sticky toast + terminal line + log). Routine chatter = `ns.print` only. Announce once, or only on change.
- **Ports** (keep unique; add new ones here and in README.md):
  20 darknet, 21 stock influence, 22 hacked total, 23 faction goals, 24 income rate, 25 city plan, 26 stock summary, 27 target stats, 28 gang summary, 29 gang equipment, 30 gang invite.
- **Player focus:** only [`singularity/player-work.js`](singularity/player-work.js) starts or stops player work (study, gang-invite crimes, faction, company) or travels. Add new player activities to it rather than writing another script that fights it for the player.
- Move heavy, rarely used NS calls into one-shot [`workers/`](workers/) scripts to keep manager RAM low.
- After editing a batcher worker ([`workers/hack.js`](workers/hack.js), [`grow.js`](workers/grow.js), [`weaken.js`](workers/weaken.js)), the batcher must be restarted.

## Sync to the game

- bitburner-filesync (`npm run sync`, port 12525) is **one way** (disk to game), never deletes in game, and skips [`archive/`](archive/). Moving or renaming a file must also be done in game.
- Files the game writes (e.g. `data/*.txt`) never reach disk; ask the user to paste them.

## Workflow

- The user commits and pushes themselves unless they ask otherwise.
- Writing to the user's PC from a cloud session: the shared project folder can serve a stale copy for a few seconds after an edit. After every copy to the device, read the file back from the device and confirm it has your change before saying it's done.

## Write for any user

Docs, rules, script output and code comments should make sense to anyone who uses these scripts. Don't name people or refer to one person's machine, folders or setup; say "the user" instead.

## Keep the READMEs up to date

Update docs in the same change as the code, not later.

- **[README.md](README.md)**: update it when a script is added, removed, renamed or moved, when its flags or behaviour change in a way the README describes, and when aliases, folders, ports or achievements (BitNode table, Go record) change.
- **[archive/README.md](archive/README.md)**: add a line (what the file did, what the next version changed) whenever a file is archived or removed.
- **AGENTS.md**: update it when a project rule, convention or port changes.
- **Links:** in docs (READMEs, AGENTS.md), write references to repo files and folders as relative Markdown links, relative to the doc they are in, so they work on GitHub: [`tools/exploits/README.md`](tools/exploits/README.md) from the root README, `../batcher.js` from `archive/README.md`. Only link paths that exist in the repo. Leave in-game commands (`run /tools/status.js`), code blocks and in-game files (`data/config.json`) as plain code.
