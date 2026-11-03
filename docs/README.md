# Design notes

Short notes on **why** the scripts work the way they do: the decision, the tradeoffs that led to it,
and what was ruled out. The code and its header comments say *what* a script does and how to run it;
[`../README.md`](../README.md) is the overview. These notes are for the next person (or agent) about to
change a script, so they don't undo a choice that was made on purpose.

## Docs

- [`batcher.md`](batcher.md): just-in-time multi-target batching, target ranking, Formulas.exe optional.
- [`startup.md`](startup.md): one priority list, stages from home RAM, running off home, skipping what can't run.
- [`config.md`](config.md): one settings file with presets and per-player overrides, instead of per-BitNode copies.
- [`aug-reset.md`](aug-reset.md): when to buy and install augments (value per hour of run).
- [`player-work.md`](player-work.md): one script owns the player; real rep goals; which city factions to join.
- [`ram.md`](ram.md): static RAM rules, one-shot helpers and where they run.
- [`darknet.md`](darknet.md): hint-driven cracking, earning, stasis links, no backdoors.
- [`stocks.md`](stocks.md): longs only, 4S or estimates, steering prices through the batcher.
- [`go-bot.md`](go-bot.md): Monte Carlo search at 0GB, opponent rotation, Illuminati on 5x5.
- [`gang.md`](gang.md): BitNode 2 gang manager (untested in game).
- [`bladeburner.md`](bladeburner.md): state manager, action pass, gym via player-work, state on a port.

## Writing one

- One file per area, named after the script or mechanic. Keep it to a page: the decision, why, the
  tradeoffs and alternatives that were rejected, and the current state. Leave out history that no
  longer matters, flag lists (those belong in the script header) and anything that will go stale fast.
- Update the note in the same change as the code when a decision changes. Delete parts that stop being true.
- Link the note from the script's header comment (`// Design: docs/<name>.md`) and list it above.
- Relative links only, to paths that exist; in-game commands and `data/` files stay plain code.
