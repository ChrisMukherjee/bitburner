# Sleeves

[`../sleeves/`](../sleeves/README.md) (scripts), [`../utils/sleeves.js`](../utils/sleeves.js) (what this run can do), settings: `sleeves` in
[`../config.js`](../config.js). Tests: [`../tests/sleeves.test.mjs`](../tests/sleeves.test.mjs).

## Decision

Sleeves are free labour: each one works on its own while the player does something else, and every job is one the player would
otherwise have to give up time for. So the manager gives every sleeve a job every minute, computed from the state of the run, and
**never touches the player** ([`../singularity/player-work.js`](../singularity/player-work.js) owns that, see
[`player-work.md`](player-work.md)). It is on by default (`sleeves.enabled: false` stops it), starts by itself when the Sleeve API
works (BitNode 10, or Source-File 10; the one rule is in [`../utils/sleeves.js`](../utils/sleeves.js)) and says what is missing
otherwise ([`api-advice.md`](api-advice.md)).

**Per sleeve, first match wins** ([`../sleeves/plan.js`](../sleeves/plan.js), pure functions):

1. **Shock recovery** at shock >= `shock.enter` until <= `shock.exit`; **synchronize** below `sync.enter` until `sync.exit`. Work gains
   are scaled by shock and sync, and an install sets sleeves back to synchronizing or recovering, so this comes first. Both have
   hysteresis so a sleeve does not flip between work and recovery every pass.
2. **Training** where a stat is missing. The combat target comes from the run: Bladeburner's floor (`trainFloor`) while it is the
   route (state boot, train or run on port 36), the gym level the gang invite asks for (port 30), else 0; the gang invite counts only while the route has no clear next step (`gangInviteOpen`, port 44, [`route-focus.md`](route-focus.md)): on the hacking route its gym and Homicide would only take sleeves from rep; `train.combat` in the
   config replaces it with a number. The lowest combat stat goes to the best gym its city has, the better one only with cash for
   `GYM_CASH_SECONDS` of it, as the player does ([`../utils/gyms.js`](../utils/gyms.js)); a city with no gym means a flight, only with the
   cash for it. Hacking below the study target (`studying.hackLevel`) studies at the configured university (the sleeve's experience is
   shared with the player scaled by sync, so it also helps the player's own level).
3. **Jobs, one sleeve each, best value first** (`sleeves.priority: "auto"`, the default; `"fixed"` is the old order karma, Bladeburner,
   factions, companies with `factionShare` and `companyShare` as caps). Each job has a value in one unit, the worth of a sleeve-hour
   (`jobValues` in [`../sleeves/plan.js`](../sleeves/plan.js)): a base weight (`sleeves.weights`) scaled by what the run says. Sleeves go
   to the highest-valued job instances, and jobs worth no more than cash crime are dropped, so the leftover sleeves earn cash.
   - *Karma for the gang* (weight 100, it is a gate): while (and `gangInviteOpen`) the invite's missing need is karma (`gain` "karma" on port 30), Homicide.
     Sleeve crimes count toward the player's karma, and Homicide wins on karma at any chance (3 karma in 3 seconds, a failure still
     gives a quarter), the same result [`../gang/workers/invite.js`](../gang/workers/invite.js) reaches for the player. Worth 0 where
     the gang can't run (`GangSoftcap` below `mechanicGates.minMultiplier`). Once a karma rate per sleeve-hour is measured (the karma
     drop between passes while sleeves grind it, smoothed; the summary on port 40 keeps the last sample), only as many sleeves take
     it as finish the karma still missing within `weights.karmaHours` (2), at least one; the rest go to other jobs.
   - *Bladeburner contracts* (50) while the state is `run`, in `sleeves.bladeburner.contracts` order. x `BladeburnerRank` (0 = no
     division), x 0.25 while the route estimate says hacking, x the share of passes where counts are left (1 - `freeShare` from
     bb-pass.js on port 36).
   - *Infiltrate Synthoids* (the Bladeburner weight x `freeShare`): the sleeve-only action that adds action counts. Worth little while
     contracts still have counts, and takes over the Bladeburner sleeves once every safe action's counts are used up.
   - *Faction rep* (20): each joined faction in `factionWork.order` with a rep goal above 0 (port 23), except the faction the player
     grinds now (`lastGoalFaction` on port 35), one sleeve each. x `FactionWorkRepGain`, x 0.5 on the Bladeburner route. Work types
     are tried in order (`factionWork.workType` first), since the game refuses types a faction does not offer.
   - *Company rep* (6): each company in `companyWork.companies` where the player holds a job, one sleeve each; the slowest rep there is.
   - *Cash* (10, the bar the others must beat): x `CrimeMoney`, times the share of the money the sleeve's crime would be next to the
     run's income, so cash is worth little once hacking pays millions a second. Half the weight where the crime stats are unknown.
   Further sleeves on the same job (karma, contracts) are worth `weights.decay` (0.6) of the one before, so the jobs share the sleeves:
   with three sleeves and a karma gap, two do Homicide and one takes contracts. Multipliers read 1 without Source-File 5. A sleeve
   already doing a job's first option keeps it (no restart, no flapping). The manager's summary shows the current job values.
4. **Cash crime** for the rest: with the game's crime stats (`workers/crime-stats.js`, once per BitNode run, Singularity at 1x or 4x
   RAM) the crime with the most money per second at the sleeve's chance, among those that succeed at least `minCrimeChance` of the
   time (chance = weighted skills / 975 / difficulty x the crime success multiplier, the game's formula); without them
   `crimeLadder` (least average combat level per crime).

If the game refuses a job (a faction another sleeve works for, a work type the faction lacks, Bladeburner not joined), the manager tries
the job's next candidate, and then falls back to the cash crime in the same pass, so a sleeve is never idle because of a refusal.

**Buying** ([`../sleeves/sleeve-shop.js`](../sleeves/sleeve-shop.js)): in BitNode 10 a sleeve first (the Covenant's `purchaseSleeve`: five at most, $10t, $100t, $1q, $10q and $100q, on top of the three Source-File 10 gives, so eight in all; it may use `sleeves.sleeveFraction` of the cash above the reserve, since it is permanent and priced far above a stage's share), then memory upgrades for the
lowest-memory sleeve (memory sets the sync a sleeve starts from), then sleeve augmentations with the most value per dollar. Source-File
10 outside BitNode 10 gives its sleeves free and sells nothing, so only augmentations are bought there. Spending follows the same
stage idea as the gang and hacknet ([`../utils/spending.js`](../utils/spending.js)): the stage comes from the measured income
(`sleeves.buying`), at most `maxFraction` of the cash per pass and never below `reserve`. An augmentation's value is the shared rule in
[`../utils/aug-filter.js`](../utils/aug-filter.js) over `sleeves.augments.wantStats`; it needs the Singularity API, so it is only asked
for where its RAM is 1x or 4x. Without it the cheapest augmentation goes first (an unknown value counts as 1, so value per dollar
becomes cheapest first). Sleeve augmentations are kept through installs ([`install-persistence.md`](install-persistence.md)), so
`singularity/install-augs.js` runs the shop with `--spend-all [--reserve n]` just before an install (after the home upgrades, stock
access and gang equipment): the whole cash above the reserve may go, not only the stage's share. Skipped where the Sleeve API does
not work or `sleeves.enabled` is false, and with `persistence.spendLeftover` off.

## Holding BitNode 10 for the Covenant's sleeves

Facts from the game's source (v3.0.0, `SleeveCovenantPurchases.tsx`): `purchaseSleeve` works only inside BitNode 10, only as a member
of The Covenant (invite: hacking and every combat skill 850, 20 installed augmentations, $75b), and costs $10t x 10^(sleeves bought
so far), five at most. The count is kept for good (`sleevesFromCovenant` survives installs and BitNode destroys; the number of
sleeves is Source-File 10's level, up to 3 (one in BitNode 10 itself), plus those bought). Memory upgrades are also BitNode 10 only.
So a sleeve not bought before the BitNode ends costs another BitNode 10 run to get.

**Decision.** [`../sleeves/sleeve-shop.js`](../sleeves/sleeve-shop.js) ends every BitNode 10 pass by asking
[`../utils/sleeve-hold.js`](../utils/sleeve-hold.js) whether the next sleeve is worth keeping the BitNode open for, and posts the answer
on port 45. The test uses live numbers only: the game's price for the next sleeve, the cash on hand, the measured income
([`../utils/income.js`](../utils/income.js)) and the age of this BitNode run. The wait to afford it (missing cash over income) is
held for when it is at most `sleeves.hold.runShare` (1) times the time this run has already taken, because the alternative is a whole
new BitNode 10 run, which takes about as long again and meets the same price. Each sleeve is judged at its own price, so the first
is held for early and the $1q+ ones only once income is large; nothing is held for when the Covenant is out of reach (not a member
and hacking or a combat skill under 850), when income has not been measured, or when all five are bought.

**What obeys it** (all default on; `sleeves.hold.enabled: false` turns every one off):

- [`../singularity/auto-destroy.js`](../singularity/auto-destroy.js) waits ("holding BitNode 10 for a Covenant sleeve ...", one toast) instead of destroying
  `w0r1d_d43m0n`, on the Black Ops ending too. `--no-hold` ignores it for one run. The shop buys the sleeve on its next pass once it
  is affordable and the hold ends by itself.
- [`../singularity/auto-reset.js`](../singularity/auto-reset.js) skips an install once the cash on hand has reached `sleeves.hold.progress` (half) of the price and it is
  still short: the reset would wipe it. Short of half-way the install's gains win; at the price the install's `--spend-all` shop pass
  buys the sleeve first. The reset that installs The Red Pill is never held, since the BitNode can't end without it.
- [`../utils/spending.js`](../utils/spending.js) `getBudget` (hacknet and server managers) keeps the price out of the budget from the same half-way point; before it, investing in
  income shortens the wait.

**Without the API or in other BitNodes** nothing posts, so nothing is held: the decision only exists in BitNode 10 with the Sleeve API.
A stale post (older than 10 minutes, a stopped shop) is ignored.

**Rejected.** A fixed number of hours or a target sleeve count (the right wait depends on the run and the income); holding when the
Covenant is far away (nothing here trains toward its 850 skills, and a hold that cannot end would stall the route); making the
reset rule value the wipe exactly (an install's gain is the reset rule's job, so only the half-way line is added).

**Open.** Nothing trains or works toward the Covenant's invite on purpose: hacking 850 comes with the run, combat 850 comes from
Bladeburner or the gym, so a run with neither gets no hold. Five sleeves in all means more BitNode 10 runs after level 3, which the
plan (levels only) cannot ask for: run `next-bitnode 10` by hand once income allows $1q and up.

## The BN10 challenge

`challenge bn10` (see [`challenges.md`](challenges.md)) sets `sleeves.manage: false` (the manager gives no sleeve a job, so none gains
experience) and `sleeves.buy.augments: false` while in BitNode 10. The game checks, at the destroy, that no sleeve holds an
augmentation or experience; owning idle sleeves is allowed, so the shop still buys sleeves and memory and the hold above still works.
It is the cheapest in the first BitNode 10 run (see [`bitnode-order.md`](bitnode-order.md#challenge-achievements)).

## RAM

Every Sleeve API call costs 4GB per distinct function, so one script holding them all would cost 50GB or more. The manager reads
three (see the README for the figure); each kind of job is a one-shot worker that holds only its own calls (4 to 12GB) and runs on any
server with room ([`../utils/start-helper.js`](../utils/start-helper.js)). Workers report on port 41. The shop is the largest
(37.9GB, for a moment): it needs the memory and purchase calls and is only started where the API works.

## Gang and Bladeburner

- **Gang:** sleeves feed it karma (the biggest karma source outside BitNode 2's invite), and a gang manager never competes with them
  for anything: sleeves cannot join the gang. A gang's income does not use sleeve augmentations.
- **Bladeburner:** while the state is `run`, free sleeves take contracts, which adds action counts (counts are what limit
  [`bladeburner.md`](bladeburner.md) late on). Sleeves also infiltrate when counts run out (see the jobs above). They do not use the support action, and bb-pass.js
  does not know about them: it reads action counts from the game, so a sleeve's finished contract just shows up as fewer counts left.

## Rejected and open

- **Reading shock recovery's speed and deciding recover-or-work by break-even.** With work scaled by (1 - shock) and recovery
  finishing in a fixed time, a fully recovered sleeve always wins over a long horizon, so the only live question is how long the
  recovery takes. The rate is not exposed by the API, so thresholds with hysteresis stand in; measure it from successive passes if sleeves
  turn out to sit in recovery too long.
- **One script that does everything.** 50GB or more of static RAM for a manager that mostly sleeps.
- **A fixed job order.** The first version listed jobs in a fixed order (it is still there as `priority: "fixed"`). It ignored the
  BitNode: a BitNode with no Bladeburner rank still sent sleeves on contracts, and a fixed share rule meant three sleeves never reached
  company work. The base weights are still judgement, not measurement (they are in the config); what the data changes is how they
  scale and which jobs drop out. Built so far: the measured karma rate only caps how many sleeves grind karma. Not built: measuring
  the other jobs' real rates (rep per hour) from successive passes, which would replace the weights and the decay.
- **A hardcoded crime table.** The game's own stats are read where Singularity is cheap, and a ladder by combat level covers the rest.
- **Open:** sleeves do not use `Support main sleeve` (grafting is the player's, see [`grafting.md`](grafting.md)); the cost of sleeves bought in BitNode 10
  (the Covenant, up to $100q) means the shop usually waits for the late game there, and the BitNode now waits for it (see above).
