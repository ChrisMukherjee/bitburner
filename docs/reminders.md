# Reminders without the Singularity API

[`../tools/reminders.js`](../tools/reminders.js), started by [`../startup.js`](../startup.js) only when the run has no Singularity API.

## Decision

Without the API nothing can backdoor a server or buy a program, so the player has to. One short pass every minute, on home,
announces each of these **once** (sticky toast plus a terminal line, since the player must act):

- a server worth backdooring is in reach and rooted, with the `home; connect ...; backdoor` line to paste (CyberSec, NiteSec,
  The Black Hand, BitRunners, Fulcrum, and w0r1d_d43m0n);
- TOR can be afforded, then the programs that can be afforded together.

With the API the pass exits at once: [`../singularity/auto-backdoor.js`](../singularity/auto-backdoor.js) and
[`../singularity/buy-programs.js`](../singularity/buy-programs.js) do the same by themselves.

## Why a one-shot

The original ran a resident loop for the backdoors and a one-shot for the shop. One pass every minute does both and holds
its 5.5GB only for a moment. What was announced is kept in `data/reminders.json` on home (hence `homeOnly`), so a restart does not
announce twice. Prices are the game's defaults; the list of servers is fixed because the invite servers are the same in every BitNode.

Rejected: porting `darkweb.js`/`scout.js` here; they are a second darknet implementation, see [`darknet.md`](darknet.md).
