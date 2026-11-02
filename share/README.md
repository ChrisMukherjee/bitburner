# share/

Shares spare RAM for faction reputation. No design note of its own; the worker pattern is in [`docs/ram.md`](../docs/ram.md). RAM figures are approximate; `mem <script>` in game gives the exact cost, and `?` means none is recorded.

| Script | What it does | Flags | RAM |
| --- | --- | --- | --- |
| [`share-manager.js`](share-manager.js) | Fills RAM the batcher isn't using with share workers, only during faction work | `--no-home`, `--always`, `--headroom N`, `--max-threads N` | ? |
| [`workers/share.js`](workers/share.js) | One `ns.share()` call, then exits | none | 4GB |
