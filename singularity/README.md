# singularity/

Player automation. Design: [`docs/player-work.md`](../docs/player-work.md) and [`docs/aug-reset.md`](../docs/aug-reset.md). RAM figures are approximate at normal Singularity cost; `mem <script>` in game gives the exact cost, and `?` means none is recorded.

> **Needs BitNode 4 or Source-File 4.** Everything here uses the Singularity API, which only works in
> BitNode 4 or with Source-File 4. Outside BitNode 4 every Singularity function also costs more RAM: 16x at
> SF4.1, 4x at SF4.2 and the normal cost at SF4.3, so these scripts may not fit in a small home until SF4.3.
>
> Without it, [`startup.js`](../startup.js) leaves out every Singularity script by itself (one line says how
> many) and starts the rest: batcher, servers, hacknet, Go, contracts, darknet, stocks. Buy home RAM and
> programs by hand and run `startup` again for the next stage. [`share-manager.js`](../share/share-manager.js) can't see
> faction work, so startup skips it; run it with `--always` to share anyway. [`tools/status.js`](../tools/status.js)
> shows work and faction goals as unknown. The check is in [`utils/singularity.js`](../utils/singularity.js).
> [`utils/aug-filter.js`](../utils/aug-filter.js) also uses the API, but only Singularity scripts run it.

| Script | What it does | Flags | RAM |
| --- | --- | --- | --- |
| [`player-work.js`](player-work.js) | The one script that moves the player: free CS course until hacking 75, then faction work for the next faction below its real rep goal (order in `factionWork`), megacorp jobs when no faction needs rep; in BitNode 2 crimes for the gang invite first (after study); also flies to get Tian Di Hui and the one city-faction group whose augs are still wanted | `--focus`, `--study N`, `--no-company`, `--plan` | ? |
| [`buy-programs.js`](buy-programs.js) | TOR (only once cash also covers the next program, which is bought straight after), port openers, DarkscapeNavigator.exe, Formulas.exe | `--once` | ? |
| [`upgrade-home-ram.js`](upgrade-home-ram.js) | Home RAM upgrades within `homeRamBuying` | `--once` | ? |
| [`upgrade-home-cores.js`](upgrade-home-cores.js) | Home core upgrades within `homeCoresBuying` | `--once` | ? |
| [`home-upgrade-loop.js`](home-upgrade-loop.js) | Library: the loop both upgraders share | import only | ? |
| [`auto-backdoor.js`](auto-backdoor.js) | Backdoors faction and company servers | `--once`, `--no-company`, `--daemon` (also w0r1d_d43m0n) | under 8GB |
| [`join-factions.js`](join-factions.js) | Accepts invites; city ones only when they lock out no wanted city faction (same rival group already joined, or the city plan wants nothing) | `--once`, `--cities` (accept all) | ? |
| [`buy-augs.js`](buy-augs.js) | Plans and buys useful augs, most expensive first; what counts as useful is `augments` in the config. Reset rule: most augment value per hour of run | `--dry`, `--all`, `--no-neuroflux`, `--reserve N`, `--plan` | about 33GB |
| [`auto-reset.js`](auto-reset.js) | Watches the plan and, when the rule says reset, sells stocks, buys and installs augs; on by default in the mid stage | `--dry` (only logs) | about 4GB |
| [`install-augs.js`](install-augs.js) | Installs augs and runs a script afterwards; refuses unless the advice says RESET | `--force` | ? |
| [`next-bitnode.js`](next-bitnode.js) | Destroys w0r1d_d43m0n and enters BitNode n | arg: n | about 34GB |
| [`auto-destroy.js`](auto-destroy.js) | Runs next-bitnode.js by itself once The Red Pill is installed and hacking level and root allow; the next BitNode comes from `bitnodeRoute` in the config | `--bn N`, `--dry` | about 5GB |
| [`workers/faction-goals.js`](workers/faction-goals.js) | One-shot: real rep goal per faction, on port 23 | args: factions | about 22GB, for a moment |
| [`workers/city-plan.js`](workers/city-plan.js) | One-shot: which city factions still sell something wanted, on port 25 | arg: JSON | about 17GB, for a moment |
