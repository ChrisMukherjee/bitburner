// Lets Node load the game scripts unchanged: maps game-style imports to the repo folder (game-path.mjs).
// Loaded with `node --import` before any test (see the "test" script in package.json).
import * as nodeModule from "node:module";
import { gamePath } from "./game-path.mjs";

if (typeof nodeModule.registerHooks === "function") {
	// Node 22.15 and later: synchronous hooks on the main thread.
	nodeModule.registerHooks({ resolve: (specifier, context, nextResolve) => nextResolve(gamePath(specifier) ?? specifier, context) });
} else {
	// Node 20.6 to 22.14: the async hooks API, which loads the hook from a module of its own.
	nodeModule.register("./hooks.mjs", import.meta.url);
}
