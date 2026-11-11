# Type checking

**Decision:** check scripts with the editor's TypeScript service and the game's own type definitions, one file at a time. Add `// @ts-check` to the top of a script (after its `// Design:` line) and annotate with JSDoc (`/** @param {NS} ns */`). No TypeScript source, no build step, no migration.

**How it works**

- [`NetscriptDefinitions.d.ts`](../NetscriptDefinitions.d.ts) is the game's API typing; filesync refreshes it on connect, so it always matches the game version. [`ns-global.d.ts`](../ns-global.d.ts) makes `NS` available to JSDoc without an import.
- [`jsconfig.json`](../jsconfig.json) covers every script folder (`/utils/x.js` style paths resolve through `paths`), excludes `archive/`, `node_modules/` and `data/`, and sets `noEmit`. `checkJs` is **off** and `strict` is off: only files that opt in with `// @ts-check` are checked, and untyped parameters are not errors.
- Command line check: `npx -p typescript tsc -p jsconfig.json` from the repo root. It prints nothing when every opted-in file is clean. GitHub runs it on every push, after the tests ([`../.github/workflows/test.yml`](../.github/workflows/test.yml), TypeScript version pinned there).

**Not synced to the game:** filesync only pushes `.js` and `.txt` (`allowedFiletypes` in [`filesync.json`](../filesync.json)), so the `.d.ts` files and `jsconfig.json` stay on disk. Comments cost no RAM, so `@ts-check` and JSDoc change nothing at runtime.

**Rules**

- Fixes must not change behaviour or RAM. Prefer JSDoc casts (`/** @type {any[]} */ (x)`), `Number(bool)` for boolean arithmetic, or `// @ts-expect-error <reason>` for deliberate cases (an API the typings say returns `void`, a probe for an API that needs a Source-File). Do not add imports or rename NS-like identifiers ([`NETSCRIPT.md`](NETSCRIPT.md)).
- A new script gets `// @ts-check` and must pass. If a file has many findings that are only `ScriptArg` or string-versus-enum noise, leave it unchecked and clean it up in a later pass instead of casting everything.

**Current state:** most scripts are checked. Still unchecked (findings are mostly `ns.args` typed `ScriptArg`, plain strings passed where the typings want an enum such as `FactionName`, `CrimeType` or `ProgramName`, and `darknet/` imports written without a leading `/`): the darknet scripts, the hack workers and `hack/xp-farm.js`, several singularity workers, `bladeburner/bb-pass.js`, `bladeburner/route-model.js`, `contracts/workers/contract-solver.js`, `gang/gang-manager.js`, `share/share-manager.js`, `stocks/workers/promote-stock.js`, and the undocumented-API files in `achievements/exploits/`. Find them with `Get-ChildItem -Recurse -Filter *.js | Select-String -NotMatch -Pattern "@ts-check" -List` (or `grep -L`).

**Rejected:** a TypeScript migration (a compile step between disk and game, and filesync would need to watch built output); `checkJs: true` globally (hundreds of untyped-parameter findings drown the real ones).
