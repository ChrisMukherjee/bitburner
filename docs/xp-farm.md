# XP farm

[`../hack/xp-farm.js`](../hack/xp-farm.js) turns RAM the batcher leaves free into hacking XP.

## Decisions

- **A separate script, not part of the batcher.** The batcher stays small and about money. The farm only
  needs two facts from it: its RAM claim on port 31 and that it frees RAM when batches end. It follows the
  same wave pattern as [`../share/share-manager.js`](../share/share-manager.js): a wave finishes before the
  next starts, so the batcher always sees freed RAM first.
- **Plain weaken on a cheap target** (`xpFarm.target`, default joesguns). Weaken pays XP when it finishes and
  needs no prepared target. It reuses [`../hack/workers/weaken.js`](../hack/workers/weaken.js) with no land time.
- **Idle RAM only.** It keeps free the larger of `xpFarm.headroom` of the network and the batcher's claim.
- **Share wins during faction work.** Both want the same spare RAM; while share-manager runs and the player does
  faction work, the farm stands down (rep gain is worth more than XP then). Without the Singularity API it never
  stands down.

## Alternatives

- Inside the batcher's loop: rejected, it ties XP timing to the batcher's pool and adds to its RAM.
- Grow or hack for XP: more RAM per XP and they change the money target's state.

## Current state

Ported from the other player's batcher, where it ran as a step of the batcher itself. Tune `xpFarm` in the config.
