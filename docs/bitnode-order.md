# Which BitNodes to do first

A guide for a new save: which BitNodes (and so which Source-Files) are worth doing early, what each one unlocks
in these scripts, and how to tell the scripts your route. The order matches `bitnodePlan` in
[`../config.js`](../config.js); what a script needs is the `Requires` column of its folder README (tags in the
root README's [Requirements](../README.md#requirements)). Parts marked **(game rule)** come from how the game works,
not from this repo, so check them in game.

## The short version

1. **BitNode 1 once** (you start there). Destroying it gives Source-File 1.
2. **BitNode 4 up to Source-File 4.3.** This is the gate for automation. Do it before anything else that costs time.
3. **BitNode 5** (Formulas.exe, BitNode multipliers, Intelligence) and **BitNode 2** (gangs), in either order.
4. **BitNode 6 and 7** (Bladeburner).
5. **BitNode 1 up to Source-File 1.3** (a bigger starting home).

That is the default `bitnodePlan`. Replace it in `data/config.json` if your goals differ.

## Source-File 4: the automation gate

The Singularity API lets a script study, buy programs and home upgrades, backdoor servers, join factions, work for
them, buy and install augmentations and end the BitNode. Everything in [`../singularity/`](../singularity/README.md)
uses it, plus `share-manager.js` and parts of the Bladeburner and gang scripts. It works in BitNode 4, or anywhere once
you own Source-File 4 ([`../utils/singularity.js`](../utils/singularity.js)).

Outside BitNode 4 its RAM cost is multiplied: **16x at SF4.1, 4x at SF4.2, normal at SF4.3**. A Singularity script
that costs 30GB in BitNode 4 costs 480GB at SF4.1. So:

- **SF4.1 is not enough on its own.** Most singularity scripts will not fit on a small home. Treat SF4.2 as the
  minimum and SF4.3 as comfortable. This is why the plan asks for level 3.
- Inside BitNode 4 itself there is no multiplier, so the first run through it is the cheapest way to see the whole
  automation work.

Without SF4, [`../startup.js`](../startup.js) leaves out every Singularity script with one summary line and runs the
rest: batcher, purchased servers, hacknet, Go, contracts, darknet, stocks. You buy programs and home RAM by hand and
back door servers by hand ([`reminders.md`](reminders.md) tells you when). The run works; it just is not hands off.

## Source-File 5: numbers instead of guesses

BitNode 5, or Source-File 5, gives permanently:

- **Formulas.exe.** The batcher and hacknet use exact numbers instead of estimates (`Formulas (opt)`).
- **`getBitNodeMultipliers()`.** [`startup.js`](../startup.js) saves them once per run
  ([`bitnode-mults.md`](bitnode-mults.md)). With them it skips the batcher where hacking pays almost nothing, skips
  hacknet or the gang where their multiplier is below 0.1, and, with `bitnodeRoute` empty, suggests the next BitNode
  whose multipliers are easiest.
- **The Intelligence stat.** Nothing here depends on it; scripts that read it work without.

Everything falls back to a multiplier of 1 without SF5, so skipping it costs efficiency, not function. It is early in
the plan because the multipliers also steer every later choice.

## Source-File 2: gangs

The Gang API ([`../gang/`](../gang/README.md), `SF2`) works in BitNode 2 or with Source-File 2. In BitNode 2 a gang
only needs a gang faction's invite; elsewhere it also needs karma of -54,000, which
[`../singularity/player-work.js`](../singularity/player-work.js) grinds with crimes when it has SF4
([`../utils/gang.js`](../utils/gang.js)). A gang is a strong second income, so SF2 pays back in every later run. The
gang manager has not been run in game by the repo's authors, so watch its first hour.

## Source-Files 6 and 7: Bladeburner

The Bladeburner API ([`../bladeburner/`](../bladeburner/README.md), `SF6/7`) works in BitNode 6 or 7, or with
Source-File 6 or 7; either one is enough for the scripts. Bladeburner is a second way to finish a BitNode (all Black
Ops done) and the route that suits BitNodes where hacking is weak, so it sits after the others in the plan. Combat
training goes through `player-work.js`, which needs SF4. The `bladeburner` preset in [`../config.js`](../config.js)
swaps the augment weights for combat; `bladeburner.route` picks between playing it and holding it.

## Source-File 1: a bigger starting home

**(game rule)** Source-File 1 raises the home RAM you start each run with (32GB at level 1, 64GB at level 2, 128GB at
level 3, as far as the game's description says) and gives a small bonus to all stat multipliers. Those are the exact
numbers to double-check in game; the repo itself only relies on home RAM being larger at the start. [`../startup.js`](../startup.js)
picks its stage from home RAM (under 64GB it runs the lean `start` stage), so a bigger start gets every run to the full
automation sooner. That is why level 3 is last: it makes each later run faster rather than unlocking anything new.

## Not covered by scripts yet

Other Source-Files (for example 3, 8, 9, 10, 11, 12, 13, 14) have no manager here. They can be on your route and the
hacking core still runs; no script is built around them, and the Go bot ([`go-bot.md`](go-bot.md)) works from a fresh
save. What each one gives is not documented in this repo, so check the BitVerse screen before spending a run on one.

## Setting the route

Three ways, from least to most control. All of them are read when [`../singularity/auto-destroy.js`](../singularity/auto-destroy.js)
decides the next BitNode, and nothing is destroyed unless the conditions are met (The Red Pill installed, hacking level
for `w0r1d_d43m0n`, or every Black Op done).

- **Do nothing.** With `bitnodeRoute` empty the scripts only *suggest* the next BitNode from `bitnodePlan` (in `status`
  and in the "ready" notice). Set `bitnodeRouteAuto` to `true` to let auto-destroy follow the suggestion itself. Within
  a tier it picks the BitNode whose multipliers make it easiest when you own SF5, otherwise the listed order.
- **Set your own route.** `afk-route 4:3 2:1 5:1` stores `bitnodeRoute` in `data/config.json`: BitNode:level pairs, done
  in order. Source-Files you already have are skipped, so you can list the whole plan. `afk-route` alone shows it,
  `afk-route clear` empties it. A route of your own always wins over the plan.
- **Go now.** `next-bitnode 5` ends the BitNode (same checks) and enters BitNode 5 directly; use it for a one-off
  choice or an achievement run.

To change the default order, put your own `bitnodePlan` (list of `{ bitNode, level, tier }`) in `data/config.json`;
lists replace the default. Lower tier numbers go first. Settings that should differ per BitNode go under `bitnodes`
([`config.md`](config.md)).

## Why this order

- SF4 first because it is what makes the scripts hands off, and the level matters (the RAM multiplier above).
- SF5 and SF2 next because they change what the scripts do in every later run, not just the one that earned them.
- Bladeburner after, because it is a different way to play a BitNode rather than something every run uses.
- SF1 last because it speeds runs up and unlocks nothing; each level costs a full BitNode 1 clear.

Rejected: a fixed route in code. The right order depends on how far a save already is, so the plan is a list in the
config that skips what you own, and the suggestion is advice unless you turn on `bitnodeRouteAuto`.
