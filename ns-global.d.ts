// Lets `/** @param {NS} ns */` resolve in VS Code without an import.
// NetscriptDefinitions.d.ts is pulled from the game by `npm run sync`.
import type { NS as _NS } from "./NetscriptDefinitions";

declare global {
  type NS = _NS;
}
