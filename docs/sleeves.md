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
   route (state boot, train or run on port 36), the gym level the gang invite asks for (port 30), else 0; `train.combat` in the
   config replaces it with a number. The lowest combat stat goes to the best gym its city has, the better one only with cash for
   `GYM_CASH_SECONDS` of it, as the player does ([`../utils/gyms.js`](../utils/gyms.js)); a city with no gym means a flight, only with the
   cash for it. Hacking below the study target (`studying.hackLevel`) studies at the configured university (the sleeve's experience is
   shared with the player scaled by sync, so it also helps the player's own level).
3. **Jobs, one sleeve each, best value first** (`sleeves.priority: "auto"`, the default; `"fixed"` is the old order karma, Bladeburner,
   factions, companies with `factionShare` and `companyShare` as caps). Each job has a value in one unit, the worth of a sleeve-hour
   (`jobValues` in [`../sleeves/plan.js`](../sleeves/plan.js)): a base weight (`sleeves.weights`) scaled by what the run says. Sleeves go
   to the highest-valued job instances, and jobs worth no more than cash crime are dropped, so the leftover sleeves earn cash.
   - *Karma for the gang* (weight 100, it is a gate): while the invite's missing need is karma (`gain` "karma" on port 30), Homicide.
     Sleeve crimes count toward the player's karma, and Homicide wins on karma at any chance (3 karma in 3 seconds, a failure still
     gives a quarter), the same result [`../gang/workers/invite.js`](../gang/workers/invite.js) reaches for the player. Worth 0 where
     the gang can't run (`GangSoftcap` below `mechanicGates.minMultiplier`).
   - *Bladeburner contracts* (50) while the state is `run`, in `sleeves.bladeburner.contracts` order. x `BladeburnerRank` (0 = no
     division), x 0.25 while the route estimate says hacking.
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

**Buying** ([`../sleeves/sleeve-shop.js`](../sleeves/sleeve-shop.js)): in BitNode 10 a sleeve first (the Covenant's `purchaseSleeve`, up to the game's limit of 8 in all; it may use `sleeves.sleeveFraction` of the cash above the reserve, since it is permanent and priced far above a stage's share), then memory upgrades for the
lowest-memory sleeve (memory sets the sync a sleeve starts from), then sleeve augmentations with the most value per dollar. Source-File
10 outside BitNode 10 gives its sleeves free and sells nothing, so only augmentations are bought there. Spending follows the same
stage idea as the gang and hacknet ([`../utils/spending.js`](../utils/spending.js)): the stage comes from the measured income
(`sleeves.buying`), at most `maxFraction` of the cash per pass and never below `reserve`. An augmentation's value is the shared rule in
[`../utils/aug-filter.js`](../utils/aug-filter.js) over `sleeves.augments.wantStats`; it needs the Singularity API, so it is only asked
for where its RAM is 1x or 4x. Without it the cheapest augmentation goes first (an unknown value counts as 1, so value per dollar
becomes cheapest first). Sleeve augmentations are kept through installs ([`install-persistence.md`](install-persistence.md)).

## RAM

Every Sleeve API call costs 4GB per distinct function, so one script holding them all would cost 50GB or more. The manager reads
three (see the README for the figure); each kind of job is a one-shot worker that holds only its own calls (4 to 12GB) and runs on any
server with room ([`../utils/start-helper.js`](../utils/start-helper.js)). Workers report on port 41. The shop is the largest
(37.9GB, for a moment): it needs the memory and purchase calls and is only started where the API works.

## Gang and Bladeburner

- **Gang:** sleeves feed it karma (the biggest karma source outside BitNode 2's invite), and a gang manager never competes with them
  for anything: sleeves cannot join the gang. A gang's income does not use sleeve augmentations.
- **Bladeburner:** while the state is `run`, free sleeves take contracts, which adds action counts (counts are what limit
  [`bladeburner.md`](bladeburner.md) late on). They do not use the support or infiltration actions, and bb-pass.js does not know
  about them: it reads action counts from the game, so a sleeve's finished contract just shows up as fewer counts left.

## Rejected and open

- **Reading shock recovery's speed and deciding recover-or-work by break-even.** With work scaled by (1 - shock) and recovery
  finishing in a fixed time, a fully recovered sleeve always wins over a long horizon, so the only live question is how long the
  recovery takes. The rate is not exposed by the API, so thresholds with hysteresis stand in; measure it from successive passes if sleeves
  turn out to sit in recovery too long.
- **One script that does everything.** 50GB or more of static RAM for a manager that mostly sleeps.
- **A fixed job order.** The first version listed jobs in a fixed order (it is still there as `priority: "fixed"`). It ignored the
  BitNode: a BitNode with no Bladeburner rank still sent sleeves on contracts, and a fixed share rule meant three sleeves never reached
  company work. The base weights are still judgement, not measurement (they are in the config); what the data changes is how they
  scale and which jobs drop out. Not built: measuring each job's real rate (karma per hour per sleeve, rep per hour) from successive
  passes, which would replace the weights and the decay.
- **A hardcoded crime table.** The game's own stats are read where Singularity is cheap, and a ladder by combat level covers the rest.
- **Open:** sleeves do not use `Infiltrate synthoids`, `Support main sleeve` or grafting; leftover cash is not spent on sleeve
  augmentations just before an install ([`install-persistence.md`](install-persistence.md)); the cost of sleeves bought in BitNode 10
  (the Covenant, up to $100q) means the shop usually waits for the late game there.
