# pserv/

Purchased servers. Design: [`../docs/startup.md`](../docs/startup.md) (when the manager stops). `mem <script>` in game gives the exact RAM cost.

| Script | What it does | Flags | RAM |
| --- | --- | --- | --- |
| [`pserv-manager.js`](pserv-manager.js) | Fills free slots, then upgrades the smallest server in place, within the `serverBuying` spending stages in the config. Exits once every server is maxed (one toast) and startup.js doesn't start it again until the next run or `--restart`. Design: [`../docs/startup.md`](../docs/startup.md) | none | 6.35GB |
| [`ready.js`](ready.js) | `pservReady` for startup.js: false once pserv-manager has posted on port 33 that the fleet is maxed this run | (imported) | 0GB |
