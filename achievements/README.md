# achievements/

Which of Bitburner's v3.0.0 achievements the scripts earn by themselves, which need a small step, and which need
manual play or a custom script. The list comes from the game's own achievement data (`AchievementData.json` and
`Achievements.ts`, tag v3.0.0). Checking what the current save already has: `ns.getUnlockedAchievements()` returns
the unlocked IDs, so drop those from the lists below first.

Already covered elsewhere (not repeated here):

- **Exploit achievements** (11, plus Source-File -1): [`tools/exploits/`](../tools/exploits/README.md).
- **BitNode challenge achievements** (`BN1: Challenge` ... `BN15: Challenge`): done per BitNode over time. Several
  conflict with the default scripts, see [Challenges](#challenges).

This is analysis, not a promise: "happens naturally" was read from the code, not measured in a real run.

## Happens naturally (check only)

| Achievement | Why it happens |
| --- | --- |
| CyberSec, NiteSec, The Black Hand, BitRunners, Daedalus, The Covenant, Illuminati (faction joins) | `singularity/` joins factions for augments and the Red Pill |
| BruteSSH, FTPCrack, relaySMTP, HTTPWorm, SQLInject, Formulas.exe | [`singularity/buy-programs.js`](../singularity/buy-programs.js) and Source-File 5 |
| Source-File x.1 for each BitNode | the BitNode route (`afk-route`) |
| Install your first augmentation, NS2 script, 30 scripts on home, a script costing 32GB, TOR router, travel, gym workout, 4S data | normal play with the scripts |
| First hacknet node, 30 nodes, $10m from hacknet, 10m reputation, faction donations | hacknet manager, rep goals, Daedalus donation rule |
| Gangster, Don, 100% territory, a 10,000-skill member | [`gang/`](../gang/README.md) in BitNode 2 or with SF2 |
| Join the Bladeburner division | [`bladeburner/`](../bladeburner/README.md) |
| Discount (backdoor Powerhouse Gym) | [`singularity/auto-backdoor.js`](../singularity/auto-backdoor.js) |
| Run 1000 scripts at once | the batcher on large RAM probably reaches it |
| Destroy a BitNode in under 2 days | later runs of an early BitNode (SF bonuses); watch it on the first BN1 rerun |
| Ten Steps Ahead (win streak of 10 against Illuminati) | the Go bot (see the record in the [root README](../README.md)) |
| Ouch! (go to the hospital) | probably already from Bladeburner or crimes; if not, a failed crime or fight |

## Small tweak or a one-shot

| Achievement | What it takes | Requires |
| --- | --- | --- |
| It's time to install (40 augmentations queued at once) | `resetRule.holdForQueued`, see [40 queued](#40-queued-augmentations) | `SF4` |
| IPvGO anticheat (get ejected for cheating) | [`go/anticheat.js`](../go/anticheat.js) `--yes`, see [IPvGO anticheat](#ipvgo-anticheat) | `SF14.2` |
| Download more cores (8 home cores) | `upgrade-home-cores.js` buys cores already; conflicts with the BN1 challenge cap | `SF4` |
| Download more RAM (maximum home RAM) | very late: the cap is 2^30 GB and `upgrade-home-ram.js` only gets there with enormous money | `SF4` |
| That's the limit (max one hacknet node) | only counts without hacknet servers; the manager stops at payback, so a one-shot "max one node" worker is needed | none |
| Hashnet set: first hacknet server, all servers, a maxed server, $1b from servers, cap your hashes | needs hacknet servers (BitNode 9 or Source-File 9); the manager only handles money nodes. Do not do these in the BN9 challenge run | none |
| Make your Own Network (backdoors on 50 darknet servers) | the darknet scripts deliberately never backdoor ([`docs/darknet.md`](../docs/darknet.md)), so a one-shot backdoor worker | `Darknet` |
| Into the Depths (install the augment from the deepest darknet server) | crawler tweak to reach and buy it | `Darknet` |
| Overclock (max level), 100,000 unspent Bladeburner skill points | `bb-manage.js` buys Overclock already; the 100k hoard needs a spend-nothing flag | `SF6/7` |
| Smart (Intelligence 255) | long Intelligence farming, see [`docs/xp-farm.md`](../docs/xp-farm.md); low priority | `SF5` |

## Long-run milestones (no script needed, just a strong BitNode)

Power Overwhelming (100,000 hacking), One punch man (3000 in every combat stat), Neuroflux 255, I asked for this (100
augmentations installed at once), Here comes the money ($1q on home), Wolf of wall street (make 1q on the stock
market), Drain a server, Massive debt. These come from long runs with large multipliers. Do not reset early in a
strong BitNode.

## Custom script or manual play

- **Corporation set** (create a corporation, lobbying, production multiplier 1000, 3000 employees, Real Estate):
  there is no `corp/` folder yet, so this is a project. Do not do it in BN3 if you want the BN3 challenge.
- **You and what army (8 sleeves):** needs Source-File 10 level 3 and the extra sleeves. No sleeve scripts yet; the
  BN10 challenge forbids sleeves in that run.
- **Wretched hive (-1m karma):** a long crime farm.
- **While(true); (freeze and reload):** manual, reload using "reload and kill all".
- **Too many options:** leave the game on the Bitverse screen for an hour.
- **More BitNodes, please:** Source-File level 3 in every BitNode, i.e. the whole route.

## 40 queued augmentations

Set `augments.resetRule.holdForQueued` to a number and the reset rule waits until that many augmentations (NeuroFlux
levels count) are ready to install. The Red Pill, the Daedalus push and the end-game rule still reset first. In
game:

```text
set-config set augments.resetRule.holdForQueued 40
set-config unset augments.resetRule.holdForQueued     # afterwards
```

`augs` (preview) and the auto-reset log say "holding the reset until 40 are ready" while it waits. Restart
`auto-reset.js` after changing it, since scripts read the config at start.

Cost: each purchase raises the next price by about 1.9x (less with Source-File 11), so the last of 40 costs on the
order of 10^11 times the base price. Check `augs` partway through and lower the number if the total is out of reach.
Best spent on a BitNode with strong income and no challenge rule, e.g. the last BN1 level; avoid it on a run chasing
a fast destroy.

## IPvGO anticheat

Kill the Go bot, then `run /go/anticheat.js --yes`. It starts a throwaway 5x5 game against Netburners and plays cheat
moves until the game ejects you from the subnet (about a 10% chance per failed cheat after the first). It stops and
prints when the cheat API refuses to play. Without `--yes` it only says what it would do. Needs Source-File 14.2.
Do not run it in a BN14 challenge run (that challenge forbids cheating). Restart the Go bot afterwards.

## Challenges

The per-BitNode challenge rules, and which default scripts break them:

| Challenge | Rule | Conflict in the default setup |
| --- | --- | --- |
| BN1 | destroy with at most 128GB home and 1 core | home RAM/core upgrades (also run by `install-augs.js`); steps in [`bn1-challenge.md`](bn1-challenge.md) |
| BN2 | no gang | `gang/` starts by itself |
| BN3 | no corporation | none (no corp scripts) |
| BN6, BN7 | no Bladeburner division | `bladeburner/` is the default route in BN6 |
| BN8 | no 4S market data | `stocks/stock-trader.js` buys 4S |
| BN9 | no hacknet nodes or servers | `hacknet/hacknet-manager.js` |
| BN10 | no sleeves | none (no sleeve scripts) |
| BN12 | destroy BN12 50 times | none |
| BN13 | no Stanek's Gift | none (no Stanek scripts) |
| BN14 | no moves or cheating via the IPvGO APIs | the Go bot |
| BN15 | never call `dnet.heartbleed` | `darknet/` uses heartbleed |

## Suggested order

1. First BN1 rerun: BN1 challenge, and watch the under-2-days achievement.
2. A BitNode between BN1 runs: nothing special. Note the BN7 challenge forbids Bladeburner.
3. Last BN1 level: 40 queued augmentations, 8 cores, IPvGO anticheat (not while a BN14 challenge is active).
4. Any BitNode with Source-File 9 or 14: the hashnet and darknet sets.
5. Corporation and sleeves only for a full set, since each is a project.
