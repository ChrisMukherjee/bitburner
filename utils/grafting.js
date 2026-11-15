// Design: docs/grafting.md
// @ts-check
/**
 * What this run can do with grafting. The one place that knows the rule: the Grafting API works in BitNode 10 and anywhere
 * once you own Source-File 10 (it needs the Singularity API too, which the callers check). Costs nothing: the caller
 * passes ns.getResetInfo().
 */

/** Whether the Grafting API works by BitNode and Source-Files alone, from a getResetInfo() result. Pure, 0GB. @param {{ currentNode: number, ownedSF: Map<number, number> }} info */
export function graftingApiFromInfo(info) {
	return info.currentNode === 10 || info.ownedSF.has(10);
}
