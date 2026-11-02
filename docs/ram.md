# RAM

Scripts are charged RAM up front by a static check, so RAM shapes the design more than anything else.

## Rules that follow from the static check

- **It matches names, not calls.** Any identifier or `.member` named like an NS function is charged, in the
  script and every imported function it reaches. A local helper called `attempt` cost 10GB; the bare word
  `window` (or `document`) costs 25GB. Never name helpers `hack`, `grow`, `weaken`, `exec`, `run`, `kill`,
  `scan`, `share`, `spawn`, `attempt`, `window` and so on. Object-literal keys are not charged.
- **Heavy, rare calls go into one-shot helpers** in [`../workers/`](../workers/): the contract solver,
  buying market access, faction goals, the city plan, target stats. The long-running manager stays small and
  pays the helper's RAM only for the moment it runs. Helpers report back on a port (list in
  [`../AGENTS.md`](../AGENTS.md)) and are started by path, never imported, or their cost would be charged
  to the caller.
- **Pure logic is free.** [`../go/choose-move.js`](../go/choose-move.js) and [`../config.js`](../config.js)
  make no NS calls, so importing them costs nothing.

## Where helpers run

[`../utils/start-helper.js`](../utils/start-helper.js) runs a helper on home, else on the caller's server,
else on any rooted server with room, copying the helper and its imports over. At 64GB home the batcher left
too little of home free for a 17GB helper, so helpers that only tried home never ran.

## Singularity costs depend on Source-File 4

Inside BitNode 4 Singularity functions cost their base price. Elsewhere they cost 16x with SF4.1, 4x with
SF4.2 and 1x with SF4.3, and aren't available at all without SF4. A script that fits in BitNode 4 may not fit
elsewhere until SF4.3, which is one reason big Singularity calls live in one-shot helpers.
