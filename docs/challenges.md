# Challenge achievements

[`../config.js`](../config.js) (`CHALLENGES`, `challenges`), [`../utils/config.js`](../utils/config.js)
(applies them), [`../tools/set-config.js`](../tools/set-config.js) (`challenge` command),
[`../singularity/home-upgrade-loop.js`](../singularity/home-upgrade-loop.js) (the home cap), [`../utils/forbid.js`](../utils/forbid.js) and [`../utils/challenge.js`](../utils/challenge.js) (forbidden mechanics, retiring).
The steps for a player are in [`../achievements/bn1-challenge.md`](../achievements/bn1-challenge.md) (BN1), [`../achievements/bn6-7-challenge.md`](../achievements/bn6-7-challenge.md) and [`../achievements/bn2-challenge.md`](../achievements/bn2-challenge.md).

## Decision

Each "BNx: Challenge" achievement is a named set of config overrides in `CHALLENGES`. Naming it in
`challenges` (in `data/config.json`) lays its settings over the preset, before the player's own
overrides. A challenge's settings sit under `bitnodes`, so they only apply in the BitNode the challenge
is about, and from the start of the next run (see "When it applies" below), so the player can name it any time before
that run and the rest of the route is untouched.

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

`bn10` (steps: [`../achievements/bn10-challenge.md`](../achievements/bn10-challenge.md)) is a `forbid` challenge like the ones below (`forbid: ["sleeves"]`, retiring when BitNode 10 ends), but what it forbids is not owning sleeves: `loadConfig` (`forbidAdjust`) turns it into `sleeves.manage: false` (no job, so no experience: [`../sleeves/sleeve-manager.js`](../sleeves/sleeve-manager.js) returns at once) and `sleeves.buy.augments: false` (the shop buys none); the sleeve scripts read those two settings, so they didn't change. The game checks both at the destroy; owning sleeves is allowed, so sleeves and memory are still bought and [the hold](sleeves.md#holding-bitnode-10-for-the-covenants-sleeves) works. An augmentation install keeps a sleeve's experience and augmentations (only the BitNode's end resets them), so anything a sleeve gains during the run counts and the manager stays off for all of it. Rejected: letting sleeves work early and stop later (nothing wipes their experience in between).

## Forbidden mechanics (BN2, BN3, BN6, BN7, BN10)

`bn6`, `bn7` (the same rule; `bn6-7` sets both, see `CHALLENGE_GROUPS`), `bn2`, `bn3` and `bn10` forbid a mechanic for the whole BitNode. The game checks
`Player.bladeburner === null` (BN6, BN7), `Player.gang === null` (BN2) or `Player.corporation === null` (BN3) when `w0r1d_d43m0n` is destroyed (v3.0.0
`Achievements.ts`), and none is undone by an augmentation install, so one join, one `createGang` or one `createCorporation` anywhere in the run loses it.
Steps: [`../achievements/bn6-7-challenge.md`](../achievements/bn6-7-challenge.md), [`../achievements/bn2-challenge.md`](../achievements/bn2-challenge.md), [`../achievements/bn3-challenge.md`](../achievements/bn3-challenge.md).

- **One setting, `forbid`** (`"bladeburner"`, `"gang"`, `"corporation"`, `"sleeves"`; default empty; the challenge sets it under `bitnodes` for its own BitNode). The
  capability helpers [`../utils/bladeburner.js`](../utils/bladeburner.js) `bladeburnerAccess(ns, config)`,
  [`../utils/gang.js`](../utils/gang.js) `gangAccess(ns, config)` and [`../utils/corporation.js`](../utils/corporation.js) `corpAccess(ns, config)` report a forbidden mechanic as not available (with `forbidden: true` and a
  reason), so startup's ready checks, the managers, `node-eta.js`, `player-work.js` (its route becomes hacking and it can finish) and `status`
  stand down through the check they already make, with no per-BitNode branch. A gang or corporation that already exists is left alone
  (`inGang`, `hasCorp` win): the attempt is lost, and the manager keeps running what exists.
- **Settings that would still steer around it** are dropped by `forbidAdjust` in [`../utils/config.js`](../utils/config.js): the route is
  `hacking`, the `bladeburner` augment group leaves `wantStats`, the sleeves' Bladeburner and karma jobs are worth 0, and the start-stage
  gang invite is off. `routeAdjust` can't put them back (it runs from the Bladeburner state on port 36, which nothing posts).
- **When it applies.** A challenge named in `challenges` applies from the start of the NEXT BitNode run, not at once: a run that
  is already going may have broken the rule (a division joined, a sleeve trained), and the player should be able to set it for the run
  after, without being there when it starts (set in BitNode 7.1, active for 7.2). [`../utils/challenge.js`](../utils/challenge.js)
  keeps `data/challenge-state.json`: the run (`run` = `getResetInfo().lastNodeReset`, `node`), the names that apply in it (`active`,
  which `loadConfig` lays over the config), and one record per named challenge (`named`: the run it was named in, whether `--now` made
  it apply in that run too, and `again` when it was named again while it applied). `startup.js` rolls it over at every start
  (`retireChallenges`), and `challenge` rolls it over first too, so a name is always recorded against the run it was given in.
  `challenge <name> --now` makes it apply in this run (for a run that is still clean), and `challenge clear` takes effect at once.
  A challenge costs nothing outside its BitNode, since its settings sit under `bitnodes`.
- **A name with no record waits.** A challenge in `data/config.json` with no record (written by hand, or by a version from before the
  records) is taken as named now and queued for the next run, with a sticky notice that `--now` applies it at once. The other choice,
  treating it as applying in the run going on, is what lost a queued `bn7`: the records arrived mid-run in BitNode 7.1, the first start
  after that took the `bn7` named for 7.2 as 7.1's attempt, and the end of 7.1 retired it before 7.2 began. Rejected: guessing from
  the BitNode the player is in (a challenge named in 7.1 is about 7, and still meant for 7.2).
- **Retiring.** A leftover `bn7` would silently block the division in the next run of BitNode 7, so these challenges are marked `retire`:
  when a run of their BitNode ends and they applied in it, `retireChallenges` takes them out of `data/config.json` and says so (with the
  command to try again). A challenge named during that run (queued, not applying) stays and starts now, and so does one named again
  while it applied (the player wants the next run too, for example after the division was joined by hand). That covers won and lost
  attempts alike (the game checks only at the destroy). `bn1` doesn't retire: a cap that does nothing outside its BitNode is harmless,
  and the BN1 steps keep the challenge on for retries.
- **Why not detect and clear automatically.** Reading achievements (`getUnlockedAchievements`) costs 5GB x 16/4/1, and a
  join can't be told from the outside for free, so the retire rule uses the one cheap fact there is: the BitNode ended.
- **Rejected:** a `challenge` flag that every script checks (the capability helpers are the single place scripts already ask, as in
  AGENTS.md); `if (bitNode === 7)` anywhere; turning the challenge on by itself (a player who wants Bladeburner in BN6 would be blocked,
  so the player opts in, like `bn1`).
- **Cost.** The hacking route is slow in BitNodes 6 and 7 (35% hacking level multiplier, [`bitnode-order.md`](bitnode-order.md#challenge-achievements)):
  that is the point of the challenge, not a bug. In BitNode 2 income loses the gang.

## Current state

`bn1`, `bn2`, `bn3`, `bn6`, `bn7`, `bn10` exist (`bn6-7` sets both). Later challenges would add an entry whose
settings skip or cap the mechanic the same way: a `forbid` name and a check in its capability helper, once the scripts have one.
