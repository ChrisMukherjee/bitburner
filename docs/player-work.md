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
(not owned, not queued), with the BitNode's rep multiplier. Fixed goals (75k everywhere) kept the player
grinding factions that had nothing left to sell. An aug sold by several factions counts for the first joined
one in `factionWork.order`. Until the goals helper has run once, no faction work happens.

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

The goals and plan helpers are big (about 22GB and 17GB) but run only for a moment, on home or any rooted
server with room (see [`ram.md`](ram.md)). They're not imported, so their Singularity calls aren't charged
to this script.
