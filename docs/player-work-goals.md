# Player work: goals, city factions and helpers

The faction-work half of [`../singularity/player-work.js`](../singularity/player-work.js): what it works towards, which
city factions it joins and the helpers that compute both. The rest (one owner of the player, the start-stage stand-in, short
passes, focus, Bladeburner, the gang invite, the gym) is in [`player-work.md`](player-work.md).

## Real rep goals

A faction is worked until its **goal**: the highest rep needed among the augments still worth buying there
(not owned, not queued) **that this run can get**, with the BitNode's rep multiplier. Fixed goals (75k
everywhere) kept the player grinding factions that had nothing left to sell. An aug sold by several factions
counts for the first joined one in `factionWork.order`. Until the goals helper has run once, no faction work
happens.

"Can get" means two budgets over the reset rule's horizon (`resetRule.horizonHours`, see
[`aug-reset.md`](aug-reset.md)):

- **Money:** cash + stocks + what income earns over the horizon (along buy-augs' income curve, see
  [`aug-reset.md`](aug-reset.md); flat until it has one) must cover the picked set bought most expensive first, each
  purchase making the rest dearer by the price step (1.9, less with Source-File 11; as buy-augs does).
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

- One group per run, the best first: `city-plan.js` ranks the groups in `cities.groups` by the summed
  `augValue` of the augments each still sells (the reset rule's value, so a combat or Bladeburner run values
  combat augments higher and may pick Chongqing + New Tokyo + Ishima or Volhaven over Sector-12 + Aevum).
  Ties keep the config order. A group that sells nothing wanted is never sought out.
- While Bladeburner is `boot`, `train` or `run` and the route estimate hasn't been posted yet, no group is
  picked: the augment weights follow the route and a join can't be undone this run. A group already joined
  stays. (The rule that flies only when the invite needs nothing else is `pursue()`'s existing cash check.)
- A group is only joined if it sells a wanted aug that no faction in `cities.otherSources` sells. Owned and
  queued augs decide the group, so no state file is needed across resets.
- A city invite is still accepted when it locks out nothing wanted (a faction of the same group is already
  joined, or the plan wants nothing from any city): the favor is free.
- Tian Di Hui comes first. It's not a city faction, locks nobody out, and its Neuroreceptor Management
  Implant removes the penalty for unfocused work.

## Helpers

The goals and plan helpers are big (about 29GB and 17GB) but run only for a moment, on home or any rooted
server with room (see [`ram.md`](ram.md)). They're not imported, so their Singularity calls aren't charged
to this script.

**Daedalus push.** When buy-augs reports that the Daedalus invite only lacks installed augments
(`daedalusPush` in `data/aug-plan.json`), player-work passes it to faction-goals, which first counts
the augments closest to unlocking at joined factions, useful or not, until the missing count is
covered ([`aug-reset.md`](aug-reset.md)).
