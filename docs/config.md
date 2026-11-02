# Settings

[`../config.js`](../config.js) (defaults and presets), [`../utils/config.js`](../utils/config.js)
(`loadConfig`), [`../utils/aug-filter.js`](../utils/aug-filter.js) (what's worth buying),
[`../tools/show-config.js`](../tools/show-config.js) (prints the merged result).

## Why one config

The scripts started out tuned for one run: a hacking build in BitNode 4. Other players, or the same
player in another BitNode, want different things (combat and crime augs with a gang, bigger reset batches
when multipliers are high, another BitNode route). Per-BitNode script copies (`buy-augs-bn4.js` ...) were
ruled out because the choices combine: "BitNode 4 after BitNode 2.3" is neither copy. So every choice that
depends on progress is a setting, and scripts don't hardcode new ones.

## How it fits together

- **Layers:** `DEFAULTS`, then the preset named by `profile` (`PRESETS`), then the player's in-game
  `data/config.json`. Objects merge key by key; lists and single values replace, so a list in the override
  is the whole list.
- **`data/config.json` lives only in the game.** Git and filesync never touch it, so each player keeps
  their own on a shared repo. Never assume it exists; bad JSON gives a sticky alert and the defaults.
- **`config.js` is plain data (0GB).** It's imported, so it costs no RAM. Workers copied to another server
  need it, `utils/config.js`, `utils/notify.js` (and `utils/aug-filter.js`) copied too, plus
  `data/config.json`, because `ns.read` reads the server the script runs on.
- **One "worth buying" rule.** `wantedBoosts` decides for buying augs, faction rep goals and city plans
  alike. It used to be copied in two places and drifted.
- **Read at start only.** Restart a script after changing settings.
- **Detected, not configured:** whether the Singularity API is usable (and its RAM multiplier) comes from
  the game. Rep and price multipliers are already in the game's own numbers.

## Not done yet

Only the `hacking` preset exists. The planned `gang` preset and automatic per-BitNode overrides are open.
