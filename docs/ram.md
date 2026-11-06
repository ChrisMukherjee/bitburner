# RAM

Scripts are charged RAM up front by a static check, so RAM shapes the design more than anything else.

## Rules that follow from the static check

- **It matches names, not calls.** Any identifier or `.member` named like an NS function is charged, in the
  script and every imported function it reaches. A local helper called `attempt` cost 10GB; the bare word
  `window` (or `document`) costs 25GB. Never name helpers `hack`, `grow`, `weaken`, `exec`, `run`, `kill`,
  `scan`, `share`, `spawn`, `attempt`, `window` and so on. Object-literal keys are not charged.
- **Heavy, rare calls go into one-shot helpers** in the `workers/` subfolder of the concept they belong to
  ([`../contracts/workers/`](../contracts/workers/): the contract solver; [`../stocks/workers/`](../stocks/workers/): buying market access; [`../hack/workers/`](../hack/workers/): target stats;
  [`../singularity/workers/`](../singularity/workers/): faction goals, the city plan; [`../gang/workers/`](../gang/workers/)). The long-running manager stays small and
  pays the helper's RAM only for the moment it runs. Helpers report back on a port (list in
  [`../AGENTS.md`](../AGENTS.md)) and are started by path, never imported, or their cost would be charged
  to the caller.
- **Pure logic is free.** [`../go/choose-move.js`](../go/choose-move.js) and [`../config.js`](../config.js)
  make no NS calls, so importing them costs nothing.

- **Rarely needed Singularity scripts run as one-shots.** The home and program buyers, invites, backdoors and
  player work run `--once` from [`../startup.js`](../startup.js), only when their next purchase is affordable or a
  timer is due, instead of looping on home ([`startup.md`](startup.md)). State a pass needs next time goes on a port.

## Where helpers run

[`../utils/start-helper.js`](../utils/start-helper.js) runs a helper on home, else on the caller's server,
else on any rooted server with room, copying the helper and its imports over. At 64GB home the batcher left
too little of home free for a 17GB helper, so helpers that only tried home never ran.

**Reserved room.** Off home the batcher and share-manager fill every free GB, so a 17-30GB helper could still
wait a long time for a gap. When a helper (or a script [`../startup.js`](../startup.js) is starting) finds no room,
it reserves its size on one server through [`../utils/ram-reserve.js`](../utils/ram-reserve.js) (port 34). The RAM pool in
[`../utils/ram-pool.js`](../utils/ram-pool.js), which both the batcher and share-manager build from, leaves that RAM out,
so no new workers start there and the room frees up as running ones finish. The server picked is the one big
enough with the most free RAM right now. A reservation lasts 5 minutes unless the script asks again, and is dropped
as soon as it starts. A script that hands over to a bigger worker with `ns.spawn` (player-work-start.js) declares `needRam` in startup.js, so the room found and reserved is the worker's, not just its own. Tradeoffs: the reserved GB earns nothing until the script starts, and two scripts writing the
port at the same moment can lose one reservation until the next try. Rejected: pausing the batcher or killing its
workers to make room (lost batches cost more than a few seconds of waiting).

## Singularity costs depend on Source-File 4

Inside BitNode 4 Singularity functions cost their base price. Elsewhere they cost 16x with SF4.1, 4x with
SF4.2 and 1x with SF4.3, and aren't available at all without SF4. A script that fits in BitNode 4 may not fit
elsewhere until SF4.3, which is one reason big Singularity calls live in one-shot helpers.
