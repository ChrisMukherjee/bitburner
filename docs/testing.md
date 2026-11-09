# Testing

**Decision:** test the decision logic outside the game with Node's built-in test runner (`node --test`), loading the
game scripts exactly as they are synced, with a small fake `ns`. Run it with `npm test` from the repo root (Node 22 or later).
No test framework, no build step, no npm packages.

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
- Not covered yet: the batcher's main loop (target choice over time, launch timing against a real clock), the Go bot's
  `main` loop (its plan order and move search are tested), the gang and stock traders' `main` loops (their per-pass
  decisions are tested), `bladeburner/bb-pass.js` and `node-eta.js`, player-work beyond the gym. These are mostly long
  `main` functions; split a piece into a function a test can call when a bug shows up there.
- The Go search is random and time-boxed, so its tests use boards where one move is clearly right and check the move,
  not the win-chance figure.
- RAM is not checked by the tests. The offline port of the game's RAM check needs the game's source and npm packages, so
  it stays a separate tool.

**Rejected:** Jest or Vitest (an npm dependency and config for what Node already does); copying logic into test-only
modules (the tests would check a copy, not the synced script); end-to-end runs against the game (the Remote API can't
drive scripts or read their state).

**Current state:** about 220 tests across the reset rule and the reset itself (sell, buy, install), home-upgrade hold,
Daedalus and Bladeburner settings, batcher thread math, landing order and prep with and without Formulas.exe, RAM pool,
startup.js stages and one-shots, gym and study choice, income curve, augment filter, BitNode route, Go plan order and move search,
the gang manager's per-pass decisions, the stock trader's sell and buy rules, the Bladeburner state machine and route model,
and repo checks.
