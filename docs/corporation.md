# Corporation

[`../corp/`](../corp/README.md) (scripts), [`../utils/corporation.js`](../utils/corporation.js) (what this run can do), settings: `corp` in
[`../config.js`](../config.js). Tests: [`../tests/corp.test.mjs`](../tests/corp.test.mjs) (formulas and rules) and
[`../tests/corp-sim.test.mjs`](../tests/corp-sim.test.mjs) (the manager against a simulated corporation).

## Decision

A corporation runs itself once it is set up, and its money comes back to the player as dividends and as bribes for faction
reputation, so the manager does the whole thing with no input: it creates the corporation, follows the in-game guide's
strategy (Documentation -> Advanced Mechanics -> Corporation) through the four investment rounds, goes public, and from then on
grows it and pays out what it can't use. It is on by default (`corp.enabled: false` stops it), starts by itself when the
Corporation API works and a corporation exists or can be made ([`../corp/ready.js`](../corp/ready.js)), and says what is missing
otherwise ([`api-advice.md`](api-advice.md)).

**The rules of the game it relies on** (bitburner-src v3.0.0; the one place they live is
[`../utils/corporation.js`](../utils/corporation.js)):

- The API works in BitNode 3 and anywhere with Source-File 3. A BitNode whose `CorporationSoftcap` is below 0.15 (or an advanced
  option) rules corporations out; the game's own `canCreateCorporation` (0GB) says so, and the manager stops with that reason.
- In BitNode 3 a corporation starts on seed money: free, 1.5b shares of which the player owns 1b. Elsewhere it is self-funded:
  $150b of the player's own cash, all 1b shares the player's. The manager self-funds once the cash is `selfFundCash` (2) x the
  price, so the rest of the run isn't left broke; `selfFund: false` waits for BitNode 3.
- In BitNode 3, or with Source-File 3.3, the corporation comes with the Office and Warehouse APIs. Otherwise each is a $50b unlock
  paid from the corporation's funds, and nothing past creating divisions can be scripted without them, so they are bought first.
  That leaves a self-funded corporation $50b, and $40b of that is the first division: the start outside BitNode 3 below SF3.3
  is slow (see below).
- The corporation is kept through an augmentation install and deleted when the BitNode ends
  ([`install-persistence.md`](install-persistence.md)). The BN3 challenge checks that none exists when BitNode 3 is destroyed,
  so `challenge bn3` forbids creating one there (`forbid: ["corporation"]`, [`challenges.md`](challenges.md)); one that already
  exists keeps running.
- The BitNode multipliers are already inside what the game reports: `CorporationValuation` in the offers, and
  `CorporationDivisions` caps the divisions (read through [`../utils/bitnode-mults.js`](../utils/bitnode-mults.js), 1 when unknown).

## How a pass works

The corporation's functions cost 10GB (reads) and 20GB (actions) each; a script naming the ones the manager uses would need
over 1TB. So [`../corp/corp-manager.js`](../corp/corp-manager.js) names none of them: every call goes through
[`../corp/workers/call.js`](../corp/workers/call.js), which runs a list of calls by name (1.6GB static) and is started with
`RunOptions.ramOverride` set to exactly 1.6GB plus each distinct function's cost once (`ns.getFunctionRamCost`, 0GB). The game
checks every call against that, so a batch that names a function it wasn't charged for fails, never more. Batches are packed in
order to fit the largest free RAM block (`packBatches`), and placed like other helpers ([`../utils/start-helper.js`](../utils/start-helper.js)).

Each START state (one market cycle, 10 seconds) the manager reads the corporation in three batches (the corporation, offer,
unlocks and upgrades; any new division; offices, warehouses, materials, products and research), hands that snapshot to the pure
planner [`../corp/plan.js`](../corp/plan.js), runs the calls it returns, and posts the planner's lines to port 48 for `status`.
The planner's memory (offer history, product prices, research rates) rides along on port 48, so a restart keeps it.

## The plan

The guide's three divisions, one role each (`corp.industries`): a **material** division (Agriculture) from round 1, a
**support** division (Chemical) from round 2 that feeds it, and a **product** division (Tobacco) from round 3 fed by both. Each
division is set up in full before the next is bought (all six cities, a warehouse in each, the round's office size), with
Smart Supply bought first so the cities already open earn while the rest waits, and Export with the first division that
takes materials. Setup steps block cheaper spending until they are paid for.

- **Rounds 1 and 2** (`corp.rounds`): the guide's office sizes and Adverts, and everyone on research until the round's research
  target (55; 700 and 390), then production jobs. While a division researches, growth spending waits (nothing it buys raises
  the offer before production resumes) and the reserve keeps the loss until the target, from the research rate measured
  between passes. Then the money goes where it raises the material division's production most per dollar: boost materials
  (the guide's closed-form optimum for the warehouse's free space, `boostQuantities`), Smart Storage, a warehouse level, Smart
  Factories; each option is scored with the game's production formula.
- **Round 3 on**: budget shares of what is left each pass (`corp.budget`): Wilson Analytics, the product division's Advert and
  main office, the corporation upgrades cheapest level first, warehouses and boosts, the other offices, the support divisions,
  and before going public cheap dummy divisions while the valuation each adds (1.1^(1/12) per office or warehouse, so 10% for a
  six-city division) is worth more than its price. Research from round 3 in the guide's order (`corp.researchOrder`), each when it
  costs at most its share of the points. Products: always one in development (1% of funds each for design and marketing),
  the lowest-rated discontinued when full; prices from Market-TA.II once researched, before that a search for the highest
  price that still sells what is made (`priceStep`: grow the step until both sides are bracketed, then halve the gap; reopen by
  one step when the bounds meet, since demand drifts).
- **Upkeep every pass**: jobs (material and support divisions weight Engineers double from round 3), tea and parties within
  `keepUpWithin` of the maximum (the party cost solves the game's morale formula), sell orders MAX at MP, Smart Supply, and the
  guide's exports in its order (Plants to the product division first, then the support division; Chemicals back).
- **Offers**: taken once the round's setup is done, its research target is met, and the offer has stopped growing faster than
  `minGrowthPerHour` over `windowMinutes`, or after `maxHours` anyway. A self-funded corporation that has paid for the APIs can't
  finish its setup from profit, so when the setup waits on a purchase, there is no profit (and no research phase about to end),
  and the offer pays for that purchase, the offer is taken: on the first pass, before the spending lowers the valuation behind it.
  After round 4 it goes public with no new shares (`ipo`).
- **Public**: dividends keep enough of each cycle's profit to afford the next thing the planner wants within `waitMinutes` and
  pay out the rest, up to `maxRate`. Shady Accounting and Government Partnership (less tribute) from the budget.
- **Bribes**: once the valuation passes the game's $100t threshold, `bribes.cashShare` of what is left goes to the reputation
  the augmentation plan still needs (port 23 goals), for factions the player has joined. Reading a faction's reputation needs
  the Singularity API at 1x or 4x RAM; without it nothing is bribed.

## Tradeoffs and rejected alternatives

- **The guide's route, not a search over industries.** Agriculture -> Chemical -> Tobacco is the route the game's own guide
  works out and the community uses; the industries are config, so another route is a setting, but the planner's phases assume
  a material, a support and a product role.
- **Hurdle rate for offers, not a plateau.** From round 3 the planner keeps reinvesting, so the offer never plateaus. A growth
  hurdle (20% an hour) plus a cap on the wait trades a little equity value for not waiting forever.
- **Rejected: our own Smart Supply** (exact input purchases each cycle). The unlock costs $25b once and the game's own version
  is exact enough with its default "leftovers" option.
- **Rejected: a markup solver for product prices** (the guide's formula needs the product's markup and the market's
  elasticity, which the API doesn't give). A bracketing search on what sells works on what can be read; Market-TA.II replaces it.
- **Rejected for now: selling shares, issuing new shares, buy-backs, and hacknet hashes for corporation funds.** Each can add
  money but interacts with the valuation and the player's cash in ways the dividends already cover; worth a look once the
  manager has run in game.
- **Self-funded start below SF3.3 is slow.** $100b of the $150b goes on the two APIs, so the first division opens one city at
  a time from its own profit. Waiting for more of the player's cash doesn't help (it can't be moved into the corporation);
  SF3.3 is the fix, and the advice says so.
- **Material and support divisions stop researching after round 2.** Their points went into quality for the offers; from
  round 3 they produce. Their research list stays in the config for anyone who gives them R&D jobs.

## Current state

New. The simulator ([`../tests/support/fake-corp.mjs`](../tests/support/fake-corp.mjs): the game's prices, unlock rules, RAM
costs and dynamic RAM check, a simplified economy) takes a BitNode 3 corporation through the four rounds to public in about two
simulated hours without spending money it doesn't have or a worker over its RAM. Its economy is not the game's, so the
timings and amounts are untested against the real game; the first run in BitNode 3 is the check.
