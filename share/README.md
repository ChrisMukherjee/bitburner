# share/

Shares spare RAM for faction reputation. No design note of its own; the worker pattern is in [`docs/ram.md`](../docs/ram.md). RAM figures are approximate; `mem <script>` in game gives the exact cost. Figures follow the game's static RAM check (base 1.6GB plus each NS function named in the script and what it imports).

| Script | What it does | Flags | Requires | RAM |
| --- | --- | --- | --- | --- |
| [`share-manager.js`](share-manager.js) | Fills RAM the batcher isn't using with share workers, only during faction work; leaves free the RAM the batcher claims on port 31 | `--no-home`, `--always`, `--headroom N`, `--max-threads N` | SF4 (or `--always`) | 5.75GB (13.25GB at SF4.1, 7.25GB at SF4.2) |
| [`workers/share.js`](workers/share.js) | One `ns.share()` call, then exits | none | none | 4GB |
