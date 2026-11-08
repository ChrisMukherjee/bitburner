# Design notes

Short notes on **why** the scripts work the way they do: the decision, the tradeoffs that led to it,
and what was ruled out. The code and its header comments say *what* a script does and how to run it;
[`../README.md`](../README.md) is the overview. These notes are for the next person (or agent) about to
change a script, so they don't undo a choice that was made on purpose.

## Docs

- [`batcher.md`](batcher.md): just-in-time multi-target batching, target ranking, Formulas.exe optional.
- [`xp-farm.md`](xp-farm.md): spare RAM into weaken threads for hacking XP, yields to share.
- [`startup.md`](startup.md): one priority list, stages from home RAM, running off home, skipping what can't run.
- [`config.md`](config.md): one settings file with presets and per-player overrides, instead of per-BitNode copies.
- [`aug-reset.md`](aug-reset.md): when to buy and install augments (value per hour of run).
- [`player-work.md`](player-work.md): one script owns the player; start stage stand-in, short passes, focus, gang invite, gym.
- [`player-work-goals.md`](player-work-goals.md): real rep goals, which city factions to join, the goals and plan helpers.
- [`bitnode-order.md`](bitnode-order.md): not a design note; a guide to which BitNodes and Source-Files to do first, what each unlocks, how to set the route.
- [`NETSCRIPT.md`](NETSCRIPT.md): not a design note; the coding rules and port list to follow when writing scripts.
- [`typecheck.md`](typecheck.md): `// @ts-check` plus JSDoc against the game's typings, opt in per file, nothing synced to the game.
- [`testing.md`](testing.md): Node's built-in test runner on the game scripts as they are, a fake `ns`, regression tests for fixed bugs.
- [`ram.md`](ram.md): static RAM rules, one-shot helpers and where they run.
- [`darknet.md`](darknet.md): hint-driven cracking, earning, stasis links, no backdoors.
- [`stocks.md`](stocks.md): longs only, 4S or estimates, steering prices through the batcher.
- [`go-bot.md`](go-bot.md): Monte Carlo search at 0GB, opponent rotation, Illuminati on 5x5.
- [`gang.md`](gang.md): BitNode 2 gang manager (untested in game).
- [`reminders.md`](reminders.md): what a run without the Singularity API is told to do by hand, and why it is a one-shot.
- [`debug-report.md`](debug-report.md): why one-shots keep their last result on a port and one tool writes it to a file to paste.
- [`bitnode-mults.md`](bitnode-mults.md): BitNode multipliers saved once per run and read at 0GB, 1 when unknown.
- [`challenges.md`](challenges.md): challenge achievements as named config overrides; the home RAM and core cap for BN1.
- [`bladeburner.md`](bladeburner.md): state manager, action pass, route estimate, gym via player-work, state on a port.

## Writing one

- One file per area, named after the script or mechanic. Keep it to a page: the decision, why, the
  tradeoffs and alternatives that were rejected, and the current state. Leave out history that no
  longer matters, flag lists (those belong in the script header) and anything that will go stale fast.
- Update the note in the same change as the code when a decision changes. Delete parts that stop being true.
- Link the note from the script's header comment (`// Design: docs/<name>.md`) and list it above.
- Relative links only, to paths that exist; in-game commands and `data/` files stay plain code.
