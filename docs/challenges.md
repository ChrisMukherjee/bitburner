# Challenge achievements

[`../config.js`](../config.js) (`CHALLENGES`, `challenges`), [`../utils/config.js`](../utils/config.js)
(applies them), [`../tools/set-config.js`](../tools/set-config.js) (`challenge` command),
[`../singularity/home-upgrade-loop.js`](../singularity/home-upgrade-loop.js) (the home cap).
The steps for a player are in [`../achievements/bn1-challenge.md`](../achievements/bn1-challenge.md).

## Decision

Each "BNx: Challenge" achievement is a named set of config overrides in `CHALLENGES`. Naming it in
`challenges` (in `data/config.json`) lays its settings over the preset, before the player's own
overrides. A challenge's settings sit under `bitnodes`, so they only apply in the BitNode the challenge
is about: the player can switch it on any time before that BitNode starts, and the rest of the route is
untouched.

The scripts only get generic settings the challenge turns on. For BN1 ("at most 128GB and 1 core on
home") that is `homeUpgrades.ram.maxGB` and `homeUpgrades.cores.max`: the shared home upgrade loop stops
before an upgrade that would pass them, as if home were maxed. That covers every path that buys home
upgrades: startup's one-shots and `install-augs.js`'s `--spend-all` buy before an install.

## Why

- **The game checks the state at the destroy, and home upgrades survive installs.** One upgrade bought
  at any point in the BitNode fails the challenge, so the cap must hold in every script that buys,
  automatically, for the whole BitNode.
- **A setting, not a script or a code branch.** The rule "check what's available, keep BitNode tuning in
  config.js" (AGENTS.md) means no `if (bitNode === 1)` in a buyer. A cap is useful on its own too.
- **Reproducible for any player.** One command (`set-config challenge bn1`) and a doc; nothing to edit.

## Rejected

- **`startupSkip` for the two buyers.** `install-augs.js` runs them directly before every install, so
  the first reset would pass the limit.
- **A one-off script that edits `data/config.json` with the raw settings.** The player would have to
  remember to undo several keys; one name in `challenges` is easier to see and to clear.
- **Reading the core count without `getServer` (2GB).** There is no cheaper call, and deriving it from the
  upgrade price depends on BitNode multipliers. `upgrade-home-cores.js` is a short one-shot, so it pays the 2GB.

## BN10: no sleeve experience or augmentations

`bn10` (steps: [`../achievements/bn10-challenge.md`](../achievements/bn10-challenge.md)) is a different kind: instead of capping a purchase it switches a manager off. In BitNode 10 it sets `sleeves.manage: false` (no job, so no experience: [`../sleeves/sleeve-manager.js`](../sleeves/sleeve-manager.js) returns at once) and `sleeves.buy.augments: false` (the shop buys none). The game checks both at the destroy; owning sleeves is allowed, so sleeves and memory are still bought and [the hold](sleeves.md#holding-bitnode-10-for-the-covenants-sleeves) works. An augmentation install keeps a sleeve's experience and augmentations (only the BitNode's end resets them), so anything a sleeve gains during the run counts and the manager stays off for all of it. Rejected: letting sleeves work early and stop later (nothing wipes their experience in between).

## Current state

Only `bn1` and `bn10` exist. Later challenges (BN2 without a gang, BN3 without a corporation ...) would add an
entry whose settings skip or cap the mechanic the same way, once the scripts have a setting for it.
