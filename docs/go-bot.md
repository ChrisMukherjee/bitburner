# Go bot

[`../go/go-bot.js`](../go/go-bot.js) (game loop, rotation) and
[`../go/choose-move.js`](../go/choose-move.js) (move search).

## Decisions

- **Monte Carlo tree search (UCT + RAVE) in pure JS.** `choose-move.js` makes no NS calls, so it costs no
  RAM; the game's own `ns.go.analysis` functions cost 8-16GB, so the bot does its own analysis. Playouts use
  simple tactics (capture, save groups in atari, don't fill own eyes, avoid self-atari). A cheap early bot
  plus a smart late bot was considered and dropped: the strong one is already free.
- **Exact v3.0.0 scoring:** stones plus empty regions touching one colour, komi for white, ties to black, no
  dead-stone removal. Passing is searched like any other move, since two passes end the game.
- **`--think` (ms per move)** trades speed for strength; 400ms is the default.
- **How the bonus grows** (game source): each game adds black's score x opponent difficulty x a win-streak
  multiplier; losses halve the streak multiplier, and resetting mid-game counts as a loss. The bonus grows
  roughly like log(power) x power^0.3, so each game adds less than the last.
- **Rotation.** Play the focus opponent until its bonus levels off (recent gains below a quarter of its best),
  then the next in `ROTATION`, most useful for a hacking run first. Opponents won against under 20% of the
  time are skipped. History is kept in `data/go-bonus.json` across resets; `--status` shows it.
- **Illuminati on 5x5.** The game multiplies difficulty by 8 for Illuminati on 5x5 versus 2 on 7x7, and the
  bot wins far more often there.
- **An offline simulator** with the game's real opponent AI was used to compare versions before running
  them in game; its predictions held up.

- **Plan-aware order.** `go/go-plan.js` puts opponents whose bonus the running plan uses ahead of the stage's
  focus, re-checked before every game: Bladeburner booting/training/running (port 36) -> Tetrads, an open
  Daedalus rep goal (port 23) -> Daedalus. The conditions come from posted state, not BitNode numbers, so a run
  without Bladeburner or goals gets the plain order. Lists live in `go` in `config.js`; `--no-plan`,
  `--rotation` and `--no-rotate` override it. A running gang (port 28) is a supported signal but boosts nothing
  by default: gang members never read the player's multipliers ([`aug-reset.md`](aug-reset.md)), so Slum Snakes
  and Tetrads would not help it. Fill `go.boosts.gang` to change that.
  Rejected: asking the game APIs directly (gang/Bladeburner calls would add RAM to a 9.6GB bot) and
  weighting by measured bonus value (the bonuses aren't comparable across mechanics).

## Skipped opponents

An opponent skipped as "losing" (under 20% wins) would never get a new result, so it gets one more game an hour after
its last (`lastPlayed` in `data/go-bonus.json`). One win lifts it back above the line only if the window's win rate does;
otherwise it goes back to skipped for another hour. `--reset` clears all history.
