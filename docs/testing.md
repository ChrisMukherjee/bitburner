# Testing

**Decision:** test the decision logic outside the game with Node's built-in test runner (`node --test`), loading the
game scripts exactly as they are synced, with a small fake `ns`. Run it with `npm test` from the repo root (Node 22 or later).
No test framework, no build step, no npm packages. GitHub runs the same command and the type check on every push and pull
request ([`../.github/workflows/test.yml`](../.github/workflows/test.yml)), so a change nobody tested locally still shows a
red cross on its commit.

**Why:** most bugs found in game were logic slips (a rule that skipped a case, a setting not switched off on one route,
a running class never upgraded), found hours later from logs. Pure decisions, given plain numbers, can be checked in
milliseconds, and a fixed bug stays fixed when a test pins it.

**How it works**

- [`../tests/support/register.mjs`](../tests/support/register.mjs) is loaded with `node --import`. It adds a resolve hook
  so the game's import paths (`/utils/config.js`, and `darknet/x.js` without the slash) load from the repo folder. The
  scripts are not changed or copied for the tests.
- [`../tests/support/fake-ns.mjs`](../tests/support/fake-ns.mjs) gives files, ports and cash, records every call (so a test
  can check that `gymWorkout` was called with Powerhouse Gym), and throws on any `ns` member a test didn't set up, so a test
  can't pass because the code got `undefined` back.
- To test a function inside a script, the script exports it. Adding `export` changes neither behaviour nor RAM: the
  static RAM check already charges every function in the script that is run (checked with the offline RAM calculator for
  every script that gained exports). `buy-augs.js` has `setAugConfig`, which `main` uses too, so tests can set the
  reset rule's settings.
- Tests are `.mjs` files in [`../tests/`](../tests/README.md). filesync only pushes `.js` and `.txt`, so they never
  reach the game; `jsconfig.json` only checks `.js`, so they don't affect type checking either.

**Tests protect only if a failure is questioned**

A test written by the same change as the code records what that change meant to do; it catches later accidental
breakage, but it can't tell whether the original decision was right, and a test edited to match every new behaviour
protects nothing. So the suite separates what must not move from what may, and makes every edit to a test visible.

- **Kinds**, as a tag at the start of the test's name:
  - `regression: ...` a bug that was fixed; the test failed before the fix. If it fails, the bug is back.
  - `game: ...` a formula, constant or rule copied from the game's source (favor, skill levels, the price step, gang
    rates, Go captures). It changes only when the game does.
  - `choice: ...` a value we picked: a default (automation on unless switched off), a threshold, the wording of a status
    line. Updating it is fine when the change meant to change it.
  - No tag: a rule the script promises (batches land in order, more RAM never picks a smaller batch, a stale plan is
    ignored, the guarantee resets an old run). Most tests are rules.
- **When a test fails after a change**, decide whether the change or the test is wrong before editing either. A
  `regression:` or `game:` failure means the code is wrong unless the game changed or the test's premise was false. A rule
  failing is either a slip (fix the code) or the rule being changed on purpose (update the test and rename it to the new
  rule). A `choice:` failure on an intended change is just updated.
- **Every changed, removed or renamed test goes in the change report** with its kind and the reason.
  `npm run test:changed` ([`../tests/support/changed-tests.mjs`](../tests/support/changed-tests.mjs)) lists them against
  `HEAD` (or any ref), plus edits to shared fixtures, since nudging a fixture can make an old test pass under a new rule
  without touching its assertions.
- **Assert the rule, not the number.** Expected values come from the inputs, the config (`loadConfig`) or the game's
  formula, with a message saying why; a number copied from the code's own output only pins it.

**Does a test protect anything?** `npm run mutate -- <script>` ([`../tests/support/mutate.mjs`](../tests/support/mutate.mjs))
copies the repo to a temp folder, flips one condition at a time in the script (`<` to `>=`, `===` to `!==`, `&&` to `||`)
and runs the tests that import it. A flip no test notices is an untested condition. Use it on a new test's script to
check that the test fails when its rule breaks, and on a script before trusting its tests in a refactor.

**What gets a test**

- Every bug fix where the logic can run outside the game: a regression test that fails without the fix (named
  `regression: ...`). Checked by undoing each fix once: the matching test fails.
- Decisions with real consequences: when to reset, what the batcher launches, which gym or course, which route and
  BitNode, how the config layers merge.
- Repo-wide slips that otherwise show up only in game: imports and script paths pointing nowhere, scripts missing from
  their folder README, relative alias paths, `tools/status.js` reading `startup.js`'s list differently from `startup.js`.

**Tradeoffs and limits**

- The fake `ns` only knows what each test gives it, so a test checks the logic, not the game's API. Where the API's
  answer matters (formulas, augment stats), the test passes in numbers taken from the game.
- Scripts that start and place other scripts (startup.js, auto-reset.js, install-augs.js) run against
  [`../tests/support/fake-world.mjs`](../tests/support/fake-world.mjs): servers with RAM, a process table, files copied
  to servers, with the clock mocked (`t.mock.timers`) for waits. It checks what starts where and in what order, not the
  real RAM costs (every script is 2GB unless a test says otherwise).
- Long `main` loops run unchanged against small simulators, with `Date.now` following a simulated clock, instead of
  being split into testable pieces (which would mean rewriting working scripts):
  - [`../tests/support/fake-hacking.mjs`](../tests/support/fake-hacking.mjs) runs the batcher for simulated minutes:
    servers whose money and security follow the game's hack, grow and weaken formulas, and workers that land at
    `max(landing time, start + duration)` as the real ones do. Tests check what must hold over time (every hack lands on
    a prepped server, money comes back to max, one prep wave at a time, few dropped batches, retargeting drains without
    killing, recovery from a desync, Formulas.exe bought mid-run, home's cores, a fresh BitNode's network). Every hack
    succeeds and multipliers are 1, so it checks the loop's logic, not income figures.
  - [`../tests/support/fake-player.mjs`](../tests/support/fake-player.mjs) runs player-work.js pass after pass (`--once`,
    a simulated minute apart, as startup.js does): a player with a city, cash, levels, factions and one piece of work, the
    game's invite and rival rules for Tian Di Hui and the city factions, and helpers that answer at once. Tests check the
    order of the work, one city group and no rival, no work restarted every pass, the pass state and what an install
    clears, focus, how often the helpers run, company work, the gang invite's crime, and the done gate.
  - [`../tests/support/fake-gang.mjs`](../tests/support/fake-gang.mjs) runs the gang manager for simulated hours, one
    gang update at a time: respect, money, wanted level and experience through [`../gang/formulas.js`](../gang/formulas.js),
    and the game's rules for recruiting, ascension, power, clashes with the other gangs (their own power gains too) and
    deaths, with a seeded random number. Tests check creating the gang, recruiting the moment respect allows, the plan,
    buy and log clocks, focus, cooling and its hysteresis, when clashes go on and off, deaths, and the equipment helper.
  - [`../tests/support/fake-bladeburner.mjs`](../tests/support/fake-bladeburner.mjs) runs `bladeburner/bb-pass.js` pass after
    pass (30 s apart, as startup.js does) and `node-eta.js` on what it leaves on port 36: a division where the game repeats
    the running action until its count or the stamina runs out (the player then idles until the next pass), stamina falls per
    attempt and regenerates, rank follows the expected value (chance x gain, so a run is repeatable), Field Analysis narrows
    the estimate ranges, Training raises the chances, the Black Ops run in order, Recruitment adds a member. With a `route`
    option it also answers what the route estimate reads: BitNode and Source-Files, hacking exp that grows by the second,
    factions and a few augmentations, The Red Pill and Daedalus. Tests check what must hold over time (the best safe action
    started once and kept, the stamina rest and its hysteresis, the fallbacks, the Black Op sequence, the rank samples and the
    measured rate against what the game earned, the efficiency ceiling never below it; the exp rate, the income history, the
    plan's route and hold hysteresis, the first-guess commit, a failed estimate, running off home).
  - [`../tests/support/fake-go.mjs`](../tests/support/fake-go.mjs) plays the Go bot's `main` for many games with the real move
    search against scripted games: the opponent passes after the bot's moves, a win raises that opponent's bonus by a scripted
    gain, a loss ends the game at once. The clock is the real one plus an offset that games and sleeps move, so the search's
    time box still works while "an hour later" is one call. Tests check who is played and when it moves on, the hourly retry of
    a skipped opponent, a game in progress, history across restarts and installs, the plan and the flags. The scripted games say
    nothing about which point the search plays; that stays with the tiny-board tests.
- Not covered yet: the stock trader's `main` runs only a few ticks in a fake market; `bladeburner/bb-manage.js`'s state machine
  is tested one pass at a time, not over a run. The simulators above are the model for testing those loops.
- The Go search is random and time-boxed, so its tests use boards where one move is clearly right and check the move,
  not the win-chance figure.
- RAM is not checked by the tests. The offline port of the game's RAM check needs the game's source and npm packages, so
  it stays a separate tool.

**Rejected:** Jest or Vitest (an npm dependency and config for what Node already does); copying logic into test-only
modules (the tests would check a copy, not the synced script); end-to-end runs against the game (the Remote API can't
drive scripts or read their state); snapshot files of whole outputs (they fail on every intended change, so they get
re-recorded without a look); making tests read-only or needing approval to edit (a rule change has to update its test,
and the report already shows each edit); a line-coverage target (a line can run without any assertion depending on it;
the mutation check measures that directly); a full mutation tool such as Stryker (npm dependencies and long runs; the
negation flips catch most of what matters here).

**Audit (2026-11-10).** Of 428 tests, 16 were `regression:`, 21 checked the game's formulas (now tagged `game:`) and six
pinned a default or wording (five now tagged `choice:`, one removed); the rest assert a rule, mostly with a message saying
why, and few assert numbers copied from the code.
Git history so far shows tests mostly added, rarely edited: the existing assertions that changed (the gang clash rule,
the default BitNode plan, the install's leftover spending) followed deliberate redesigns, and one fixture change (rank
samples every 5 minutes) moved old tests onto a new rule; none was loosened to pass, but none of those edits was
explained anywhere, and the tags and report rule above fix that. A sampled mutation check (negation flips, 25 per script)
caught 62 % of flips overall: over 80 % in the Bladeburner model and team, stock math, darknet storm rule, config, Go
plan and aug filter; under 30 % in the reset rule, the batcher and player-work, whose long `main` loops, rate tracking and
messages have no tests. Tests added then for the reset rule's untested branches (rates not measured, the `maxRunHours`
guarantee, waiting for the Daedalus donation line, which resets the home-upgrade hold leaves alone) each fail with their
condition flipped. One test was removed: it only checked that a default was above the old default. The simulator tests
added next took the batcher from 27 % to 78 % of its flips caught and player-work from 31 % to 72 % (every flip in each
file); what is left is mostly log wording, the Bladeburner-route crime invites and the gang's gym step. The gang
simulator took the gang manager from 65 % to 77 % and found a bug: a member killed in a clash was never reported or
counted when respect let the next update recruit a replacement before the plan looked.

**Main-loop simulators for the rest (2026-11-11).** `bb-pass.js`, `node-eta.js` and the Go bot's `main` got simulators and
85 tests. Mutation checks (negation flips): `bb-pass.js` 92 % of all 89 flips caught (with `tests/bladeburner.test.mjs`),
`go-bot.js` 91 % of 45, `node-eta.js` 58 % of a fixed sample of 60 of its 125 (the simulator tests alone; the model's own
branches live in `route-model.js`). What is left is mostly log wording, the rank-per-second pricing of a waiting Black Op and
model inputs that only change the figures. No script bug turned up; the tests only pin behaviour.

**Current state:** about 633 tests across the reset rule and the reset itself (sell, buy, install), the augmentation price
step, home-upgrade hold, Daedalus and Bladeburner settings, batcher thread math, landing order and prep with and without
Formulas.exe, RAM pool, the batcher's main loop in a hacking simulator, startup.js stages and one-shots, gym and study
choice, player-work's passes in a player simulator, income curve, augment filter, BitNode route,
Go plan order and move search, the gang manager's per-pass decisions and its main loop in a gang simulator, the sleeve planner and the sleeve manager and shop in a sleeve world, the stock trader's sell and buy rules (cost-aware buying, cycle clock, rotation, cash held for other buyers), the Bladeburner
state machine (with the wait for Stanek's Gift), route model, `bb-pass.js` and `node-eta.js` in a Bladeburner simulator, the Go bot's main loop in a Go simulator, the darknet's solvers, migration and storm rule, the program order, repo checks,
and the two test tools. Tagged: 19 `regression:`, 21 `game:`, 5 `choice:`; the rest are rules. GitHub runs them and the type check on every push.
