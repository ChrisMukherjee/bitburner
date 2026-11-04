# Debug report

[`../tools/debug-report.js`](../tools/debug-report.js) and [`../utils/pass-log.js`](../utils/pass-log.js) (port 37).

## The problem

Most work is done by one-shot passes (player-work, Bladeburner, the route estimate): they run for a moment on whichever server has
room and exit, so their log is gone by the time anyone looks. The other player's scripts left `.txt` files with the last result,
which could be read in game and pasted into a chat. State here lives on ports, which is right for scripts but awkward for a person.

## Decision

- A one-shot keeps the lines of its last pass on **port 37** (`postPass`), a few short lines per script, timestamped.
- `run /tools/debug-report.js` writes everything worth pasting into **one file**, `data/debug-report.txt` (`cat` it, copy it):
  the run (BitNode, Source-Files, home, factions), what is running, the last pass of every one-shot, `data/startup-why.txt`
  (why startup.js did not start something), `data/node-eta.txt`, `data/config.json`, and the raw content of every port.
- Reads only, 5.5GB, run by hand when something looks wrong. `--full` lifts the length limits.

## Why not a text file per script

Files belong to one server (a pass on another server would have to `scp` its file home), and a stale file reads as current.
Ports are free, shared by every server and cleared by a reset, so the data is always about this run. The one file the report
writes is for people, not scripts.

## Current state

Passes posting today: `player-work.js`, `bb-manage.js`, `bb-pass.js`, `node-eta.js`. Add `postPass(ns, ns.getScriptName(), lines)`
at the end of any other one-shot worth debugging (buy-augs, the home upgrade buyers, join-factions, auto-backdoor).
Long-running scripts keep their own log (`tail`), and the batcher, gang and stock summaries are already in the port dump.
