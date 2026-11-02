# Startup

[`../startup.js`](../startup.js). Type `run /startup.js` once per BitNode (or let a reset or
[`../singularity/next-bitnode.js`](../singularity/next-bitnode.js) do it).

## Decisions

- **One list in priority order.** Every long-running script is one entry tagged with the stage it starts
  in. Earlier entries get RAM first. It skips anything already running and exits once everything is launched,
  so it is safe to run again at any time. Other scripts do: home RAM upgrades, new port openers, aug installs.
- **Stages come from home RAM** (`startupStages` in [`../config.js`](../config.js): start below 64GB, early,
  mid at 128GB, late at 256GB). Home RAM is what decides what fits; `run /startup.js mid` forces one.
- **The `start` stage is lean on purpose.** In a fresh BitNode only the buyers, the batcher, invites,
  backdoors and player work run, so the batcher gets the free servers' RAM. Hacknet, servers, Go and the
  rest wait until home has grown.
- **Runs off home when home is full.** Scripts that don't read or write files on their own server go to
  rooted servers (at most 65% of off-home RAM, the rest stays for the batcher). That is what makes it work
  from an 8GB home. `homeOnly` marks the ones that must stay.
- **Skips what can't run instead of failing.** Without the Singularity API every [`../singularity/`](../singularity/)
  script is left out with one summary line, checked through [`../utils/singularity.js`](../utils/singularity.js).
  The gang manager starts only once a gang or gang faction exists.
- **`restartOnNewArgs`** swaps a running copy when the args change (for example the Go bot's opponent per
  stage), so two copies never fight over the same thing.

## Structure across BitNodes

The rules are in [`../AGENTS.md`](../AGENTS.md): one folder per mechanic with a manager that exits cleanly
when its API isn't available, capability checks rather than BitNode-number checks, per-BitNode tuning only
in the config, and a core that knows no mechanic's details. A new mechanic adds a folder and one line here.
