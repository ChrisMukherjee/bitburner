// Async resolve hook for Node versions without module.registerHooks (see register.mjs).
import { gamePath } from "./game-path.mjs";

export async function resolve(specifier, context, nextResolve) {
	return nextResolve(gamePath(specifier) ?? specifier, context);
}
