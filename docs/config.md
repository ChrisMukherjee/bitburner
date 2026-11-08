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

- **Layers:** `DEFAULTS`, then the preset named by `profile` (`PRESETS`), then each challenge named in
  `challenges` (`CHALLENGES`, see [`challenges.md`](challenges.md)), then the player's in-game
  `data/config.json`. Objects merge key by key; lists and single values replace, so a list in the override
  is the whole list.
- **Per-BitNode overrides:** each layer can have a `bitnodes` section keyed by BitNode number; the
  current BitNode's entry is laid over that layer right after it (so the player's own top-level settings
  still beat a default per-BitNode value). `loadConfig` stays 0GB because it reads the BitNode number from
  `data/bitnode.txt`, which [`../startup.js`](../startup.js) writes (it already pays for `getResetInfo`) and
  copies along with `data/config.json`. Scripts never test the BitNode number themselves.
- **`data/config.json` lives only in the game.** Git and filesync never touch it, so each player keeps
  their own on a shared repo. Never assume it exists; bad JSON gives a sticky alert and the defaults.
- **`config.js` is plain data (0GB).** It's imported, so it costs no RAM. Workers copied to another server
  need it, `utils/config.js`, `utils/notify.js` (and `utils/aug-filter.js`) copied too, plus
  `data/config.json`, because `ns.read` reads the server the script runs on.
- **One "worth buying" rule.** `wantedBoosts` decides for buying augs, faction rep goals and city plans
  alike. It used to be copied in two places and drifted.
- **The BitNode route is the player's own.** `bitnodeRoute` is `[]` in `config.js`, since which Source-Files to chase is each player's plan; it goes in `data/config.json`. With it empty, a generic `bitnodePlan` is walked against the owned Source-Files and only *suggests* the next BitNode (`bitnodeRouteAuto: true` follows it by itself); see [`bitnode-mults.md`](bitnode-mults.md). Entries already owned are skipped, so a full plan can be listed. Step-by-step use is in the root README ("Planning your BitNode route and settings").
- **Read at start only.** Restart a script after changing settings.
- **Detected, not configured:** the BitNode multipliers (with Source-File 5) gate mechanics a BitNode makes worthless (`mechanicGates`) and rank the route suggestion; the player's settings win.  whether the Singularity API is usable (and its RAM multiplier) comes from
  the game. Rep and price multipliers are already in the game's own numbers.

## Presets and automatic adjustments

Presets: `hacking` (the defaults) and `bladeburner` (combat and Bladeburner augments instead of hacking
ones, for a Bladeburner route). `loadConfig` also adjusts the augment weights by itself while
Bladeburner is the route (state boot, train or run on port 36, or hold while the route estimate says combat): combat and
Bladeburner augments count and hacking ones do not, as the preset does, so the preset is only needed to force it. It also
weighs the money stats by where this run's money comes from (`augments.incomeMix`, "Income mix" in
[`aug-reset.md`](aug-reset.md)), so hacknet or a gang paying more needs no setting either. `bitnodes` in `config.js` is still empty:
entries get added as each BitNode is played (a `"2"` entry for the gang run is the likely first).
