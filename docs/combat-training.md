# Combat training: the fastest way, not always the gym

Whenever a combat stat has to reach a level (Bladeburner's join floor or its route target, a gang or crime-faction invite, The
Covenant's 850), [`../singularity/player-work.js`](../singularity/player-work.js) `trainStep` picks the fastest way to get every
short stat there right now: the gym for the lowest stat, a crime that feeds several short stats at once, or Bladeburner's Training.
The rates and the choice are pure functions in [`../utils/training.js`](../utils/training.js). `combatTraining.enabled: false`
keeps the gym only.

## The game's rates (v3.0.0)

Exp per second, before the player's exp multiplier `m` for the stat:

| Way | Exp per second | Stats |
| --- | --- | --- |
| Powerhouse Gym (Sector-12, $2,400/s) | 10 | the one trained |
| Snap Fitness (Aevum) / Millenium (Volhaven) / Crush (Aevum) / Iron Gym (Sector-12) | 5 / 4 / 2 / 1 | the one trained |
| Bladeburner Training (members) | 1 x `m` (the game applies `m` twice) | all four |
| Faction security work | 1.5 x FactionWorkExpGain | all four (and rep) |
| Mug, Heist / Assassination / Homicide, Kidnap | 0.75 / 1 / 0.67 each, at 100 % success | all four |
| Shoplift | 1 each | dexterity, agility |

- **Gym** (`calculateClassEarnings`): the gym's expMult x `m` x the hash upgrade's training multiplier. No focus penalty and,
  although a `ClassGymExpGain` BitNode multiplier exists, the v3.0.0 code never applies it.
- **Crimes** (`calculateCrimeWorkStats`, `CrimeWork.commit`): exp per success x `m` x the BitNode's CrimeExpGain; a failure
  gives a quarter; unfocused without the Neuroreceptor Management Implant, 80 %.
- **Bladeburner Training** (`Bladeburner.completeAction`): 30 exp to each combat stat every 30 s, already times `m`, and
  `Player.gainStats` multiplies by `m` again, so `m²` a second. Bonus time runs it up to 5x as fast. It needs membership, which
  an install keeps, so after an install it is open even with every stat back at 1.

## The decision

Every exp a method adds to a stat still under the floor saves `1 / gymRate` seconds of gym, so a method's score is the sum of
`rate / gymRate` over the short stats; the gym is worth 1, exp to a stat already there counts nothing, and the highest score
wins (the gym on ties). It is re-decided every pass (about a minute), so as stats reach the floor the choice moves on by itself:
with one stat left the gym wins unless Training's `m` is above the gym's expMult.

What this means in practice:

- **With cash for Powerhouse the gym wins** for crimes: three short stats at best give about 3 x 1 = 3 exp a second against
  the gym's 10, and no crime reaches 1 a second per stat.
- **Without it the crimes win**: at Iron Gym (1 a second) Mug at a good chance gives over twice the useful exp, and earns the cash
  for the better gym.
- **Bladeburner Training wins once `m` > gym expMult / short stats** (Powerhouse, three stats short: `m` above 3.33; all four
  short: 2.5), and with bonus time much sooner. With The Blade's Simulacrum it costs nothing: it runs beside the gym or crime.
- **No gym in reach** (waiting in a gym-less city for an invite, or no cash for the flight) scores the gym 0, so a crime trains
  meanwhile instead of nothing.

## How it is wired

- [`../singularity/workers/train-options.js`](../singularity/workers/train-options.js) (7.1GB at SF4.3) posts the crime chances
  and the hash multiplier on port 47 every 2 minutes while a stat trains, so player-work keeps its RAM; until it has answered,
  only the gym and Training are compared. Crime times and exp are a table from the game's source.
- [`../bladeburner/bb-manage.js`](../bladeburner/bb-manage.js) posts `member` and `bonusMs` on port 36 (`bonusMs` is 0 for a non-member: the game's `getBonusTime` throws unless the player has joined the division, so it is only asked of members). When Training is picked,
  [`../bladeburner/workers/train.js`](../bladeburner/workers/train.js) starts it and notes `training: { time }`; bb-manage's
  "clear a leftover action" leaves Training alone while that note is under 10 minutes old. Training is never picked while
  `bb-pass.js` plays (`run`).

## Rejected

- **Faction work as a training option**: security work gives 1.5 a second to all four, under half the Powerhouse gym's useful
  exp for three short stats. Its rep is worth something, but the faction-work step already gets the player to it once the
  levels are there.
- **Counting the exp still missing per stat** (levels from exp with the level multipliers): the greedy per-pass score already
  moves on when a stat arrives, and the deficit only matters for a time estimate.
- **A switch band**: the inputs change slowly (a stat crossing the floor, a gym tier, a crime chance), so the choice doesn't flap.
