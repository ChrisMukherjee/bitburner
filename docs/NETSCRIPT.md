# Netscript coding rules

Rules and gotchas to follow when writing or changing scripts. Unlike the design notes in this folder
(which record why a choice was made), these are things to get right every time. For the design of the RAM
rules see [`ram.md`](ram.md).

- **RAM check matches names.** The static RAM checker charges any identifier named like an NS function (a local helper `attempt` cost 10GB, `window` 25GB). Never name helpers `attempt`, `hack`, `grow`, `weaken`, `spawn`, `exec`, `run`, `kill`, `scan`, `share`, `window`, etc.
- **Income:** never use `ns.getTotalScriptIncome` for money income (batcher hack workers exit on payout, so it reads ~$0). Use `readIncomeRate(ns)` from [`utils/income.js`](../utils/income.js).
- **Alerts:** use `notify(ns, tag, message, variant, terminal)` from [`utils/notify.js`](../utils/notify.js) (0GB). FYI/good news = toast only. Things the user must act on = `terminal = true` (sticky toast + terminal line + log). Routine chatter = `ns.print` only. Announce once, or only on change.
- **Ports** (keep unique; add new ones here and in [`README.md`](../README.md)):
  20 darknet, 21 stock influence, 22 hacked total, 23 faction goals, 24 income rate, 25 city plan, 26 stock summary, 27 target stats, 28 gang summary, 29 gang equipment, 30 gang invite, 31 batcher RAM claim, 32 contract failures, 33 one-shot gates, 34 RAM reservations, 35 player-work state, 36 Bladeburner state, 37 last pass of each one-shot (utils/pass-log.js, for tools/debug-report.js), 38 income mix by source (utils/income-mix.js, for the augment weights).
- **Player focus:** only [`singularity/player-work.js`](../singularity/player-work.js) starts or stops player work (study, gang-invite crimes, faction, company) or travels. Add new player activities to it rather than writing another script that fights it for the player. The one exception is [`singularity/player-work-start.js`](../singularity/player-work-start.js), its small stand-in for the start stage (below 64GB home), when player-work.js fits nowhere; the two never run in the same stage.
- Move heavy, rarely used NS calls into one-shot worker scripts (in the concept's own `workers/` subfolder) to keep manager RAM low.
- After editing a batcher worker ([`hack/workers/hack.js`](../hack/workers/hack.js), [`grow.js`](../hack/workers/grow.js), [`weaken.js`](../hack/workers/weaken.js)), the batcher must be restarted.
