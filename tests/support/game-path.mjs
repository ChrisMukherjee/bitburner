// Where a game-style import lives in the repo. The game resolves imports from the home root
// ("/utils/config.js", and "darknet/x.js" without the slash); Node would look at the drive root or
// in node_modules instead.
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A game-style path ("/x.js" or "folder/x.js") as a file URL in the repo, or null for anything else. */
export function gamePath(specifier) {
	if (specifier.startsWith("/") && !specifier.startsWith("//")) return pathToFileURL(path.join(ROOT, specifier)).href;
	if (/^[\w-]+\/[\w./-]+\.js$/.test(specifier)) return pathToFileURL(path.join(ROOT, specifier)).href;
	return null;
}
