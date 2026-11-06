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

Order, one at a time: study (free course to hacking 75), the gang invite (BitNode 2, no gang yet: a crime for
the karma, the gym for the combat stats), faction work, then megacorp jobs when no faction needs rep.

## Start stage: a small stand-in

player-work.js costs 32.5GB, so below a 64GB home (a fresh BitNode) it fits neither on home nor on any
server (the early network's biggest are 32GB). A run once sat idle for 4.5 hours that way. So below the early
stage [`../singularity/player-work-start.js`](../singularity/player-work-start.js) (7.35GB, fits a 16GB server)
moves the player instead: the free course to `studying.hackLevel`, then a missing port opener it can create (`createPrograms.maxMinutes`), then the crime that earns the most per
second at the current chance. Crime is there for cash: at the start the batcher earns little and cash buys
home RAM and the port openers, which matter more than faction rep then. Creating beats buying here: BruteSSH at hacking 113 takes about 5 minutes (600s x 50/113) against $500k the
batcher hasn't made yet; FTPCrack about 18 minutes. It blocks crime meanwhile, and creating gets slower as the
required level rises, hence the 30 minute cap; the cash buyer still buys whatever becomes affordable first. It leaves other work alone. Crime
base times and money are hardcoded from the game source (getCrimeStats would add 5GB; the BitNode multiplier
scales them all alike). The 5GB create and crime calls sit in workers it hands over to with `ns.spawn` (which
frees its own RAM first), so the pass never needs more than the biggest worker (12.1GB). The stages split the two (start vs early), so they never alternate.
Rejected: shrinking player-work.js below 32GB (it still wouldn't fit beside the batcher on a 32GB home) and
splitting every step into workers (many scripts for one stage).

## Short passes

[`../startup.js`](../startup.js) runs it `--once` about every minute as a one-shot. A pass refreshes what's due,
takes one travel step and one work step, and exits; the game keeps the work going without a script. So its
30GB is used for a moment instead of all the time, which matters most at a BitNode start (8GB home), when it
otherwise came out of the batcher's RAM. What the next pass needs (goals, city plan, what was started or
announced) is kept on port 35, tagged with the last install time so a new run starts clean; the helpers' own
ports aren't enough because the state also says what this script did (e.g. the class was started, so a
stopped class is left alone). Ports, not a file, because the pass may run on any server. Each pass logs one
line per part saying what it did or why it did nothing. When every part is done it posts `done` on port 33
([`../singularity/ready.js`](../singularity/ready.js)) and startup.js stops running it until the next reset.
Tradeoffs: a reaction can take up to a minute (it was 30 seconds), and getResetInfo adds 1GB to each pass.
Run by hand without `--once` it still loops (startup.js stops such a copy, as with every one-shot).
Rejected: a small resident loop that starts the big pass (two scripts to keep in step, for little gain).

## Focus

Work is focused by default until the Neuroreceptor Management Implant is installed, then unfocused.
Unfocused work runs at 80% speed without the implant, which costs more rep and study time than having the
screen taken over; with it there's no penalty, so the screen is left to the user. The goals helper already
reads the owned augments, so it reports whether the implant is installed (`focusPenalty` on port 23) and
player-work.js pays no extra RAM for the check. Until the helper first runs, work is focused. The switch
only happens at a reset (the implant counts once installed), when player-work.js starts again anyway.
Work already running unfocused when the script starts is focused once (`setFocus`, 0.1GB); after that the
user can unfocus by hand and it's left alone until the next new work.
`--focus` and `--no-focus` force one or the other, and so does `playerFocus: true` or `false` in the config
(`"auto"`, the default, is the rule above; a flag wins over the config). Rejected: unfocused by default with `--focus` to opt in
(the old behaviour), since nothing passed the flag and every run before the implant lost a fifth of its
work speed.

## Bladeburner

When the state on port 36 is `run`, `bb-pass.js` plays and anything started here would cancel its action, so
player-work starts nothing (invites, travel and city joins still go on). When it is `train`, the lowest combat
stat goes to the gym first, before study or faction work (see "The gym" below). It never reports done while the Bladeburner API is usable. See
[`bladeburner.md`](bladeburner.md).

## Gang invite: karma, then the gym

In BitNode 2 a gang needs only the invite of `gang.factions[0]` (Slum Snakes: karma -9, every combat stat 30,
$1m); karma -54,000 is the rule everywhere else (Source-File 2). `gang/workers/invite.js` decides every 2 minutes:

- **Karma first, by expected karma per minute.** Each crime (`gang.inviteCrimes`, default every
  `ns.enums.CrimeType`) is rated `(chance + 0.25 x (1 - chance)) x karma / minutes` at the current success
  chance: a failure still gives a quarter of the karma and stat exp (v3.0.0 `CrimeWork.ts`). With the game's
  numbers Homicide wins at any chance (3 karma in 3 s, so 0.25/s even when it always fails, more than any
  other crime that always succeeds). Karma -9 takes well under a minute.
- **Then the combat stats in the gym** (`gang.inviteGym`). A gym gives several times the exp of any crime,
  and the crimes that give strength and defense exp need strength and defense to succeed. With the gym off,
  the crime with the most expected exp per minute for the stats still missing is used instead.
- **Rejected: the old score** `chance x (karma + 0.02 x all stat exp) / seconds`. It ignored what a failure gives,
  and once karma was met it counted exp of every stat, so Shoplift (dexterity and agility only, near 100%) beat
  Mug for good: strength and defense never grew, Mug's chance never rose, and the invite never came.

Where a gang also needs karma -54,000 (outside BitNode 2) that grind takes hours, so it comes last: only when no
faction or company work needs the player. Rejected: running it before faction work, which would stall the rep the
augments need.

## The gym

Bladeburner and the gang invite share one gym step: the lowest combat stat trains until all reach the floor, at
the best gym in the current city (Sector-12: Powerhouse x10 exp, Iron x1; Aevum: Snap Fitness x5, Crush x2;
Volhaven: Millenium x4), the better one only with cash for ten minutes of it. In a city without a gym it flies
to Sector-12, unless the travel step is waiting there for a faction invite (it would otherwise fly back and
forth every pass and the invite would never come): then the gang's crime stands in, and Bladeburner waits.

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
