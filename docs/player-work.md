# Player work

[`../singularity/player-work.js`](../singularity/player-work.js), with helpers
[`../singularity/workers/faction-goals.js`](../singularity/workers/faction-goals.js) (port 23),
[`../singularity/workers/city-plan.js`](../singularity/workers/city-plan.js) (port 25) and
[`../gang/workers/invite.js`](../gang/workers/invite.js) (port 30).
Invites are accepted by [`../singularity/join-factions.js`](../singularity/join-factions.js).

## One script owns the player

Study, faction work, company work, crimes and travel used to be five scripts. They fought over the
player's focus and flew them around behind each other's backs. Now only this script starts or stops work
or travels; a new player activity is a new step in it, not another script. It also saves RAM (one set of
Singularity calls instead of five).

Order, one at a time: study (free course to hacking 75), gang-invite crimes (BitNode 2, no gang yet),
faction work, then megacorp jobs when no faction needs rep.

## Real rep goals

A faction is worked until its **goal**: the highest rep needed among the augments still worth buying there
(not owned, not queued) **that this run can get**, with the BitNode's rep multiplier. Fixed goals (75k
everywhere) kept the player grinding factions that had nothing left to sell. An aug sold by several factions
counts for the first joined one in `factionWork.order`. Until the goals helper has run once, no faction work
happens.

"Can get" means two budgets over the reset rule's horizon (`resetRule.horizonHours`, see
[`aug-reset.md`](aug-reset.md)):

- **Money:** cash + stocks + income x horizon must cover the picked set bought most expensive first, each
  purchase making the rest 1.9x dearer (as buy-augs does).
- **Time:** the rep still missing, summed over factions (they're worked one at a time), at the measured rep
  rate (from `data/aug-plan.json`; factions not worked yet get the best rate seen). Skipped until a rate
  is measured.

Augments are picked best value per dollar first (`augValue`, the reset rule's value), each with the
prerequisites it still needs. The Red Pill (`resetRule.keyAugs`) always counts, so Daedalus keeps its goal for
the Daedalus favor rule. The rest are "out of reach" for now; the goals refresh every 10 minutes, so they come
back as income and rep rate grow.

Why: rep-only goals ground to the dearest wanted aug even when it and the markup were far beyond what the run
would earn; that rep only became favor. Tradeoffs: value per dollar is a greedy pick, not the best possible
set; the goals move with income (a big spend can lower them); rep rate ignores favor differences between
factions. Rejected: using the reset rule's best moment as the horizon (it changes every check and would make
goals jumpy).

## City factions

City factions come in rival groups: joining one locks the others out for that run.

- One group per run, in the order in `cities.groups`: Sector-12 + Aevum (CashRoot, PCMatrix), then
  Chongqing (Neuregen). New Tokyo, Ishima and Volhaven sell nothing a hacking run wants that isn't sold
  elsewhere, so they're never sought out.
- A group is only joined if it sells a wanted aug that no faction in `cities.otherSources` sells. Owned and
  queued augs decide the group, so no state file is needed across resets.
- A city invite is still accepted when it locks out nothing wanted (a faction of the same group is already
  joined, or the plan wants nothing from any city): the favor is free.
- Tian Di Hui comes first. It's not a city faction, locks nobody out, and its Neuroreceptor Manager
  removes the penalty for unfocused work.

## Helpers

The goals and plan helpers are big (about 29GB and 17GB) but run only for a moment, on home or any rooted
server with room (see [`ram.md`](ram.md)). They're not imported, so their Singularity calls aren't charged
to this script.
