/**
 * Whether ns.singularity can be used in this run: always in BitNode 4, elsewhere only with
 * Source-File 4. Without it every ns.singularity call throws, so scripts check this first.
 * Costs getResetInfo (1GB).
 *
 * Singularity RAM costs outside BitNode 4: x16 with SF4.1 (or none), x4 with SF4.2, x1 from SF4.3.
 */
export function singularityInfo(ns) {
	const info = ns.getResetInfo();
	const level = info.ownedSF.get(4) ?? 0;
	const available = info.currentNode === 4 || level > 0;
	const ramMultiplier = info.currentNode === 4 || level >= 3 ? 1 : level === 2 ? 4 : 16;
	return { available, level, ramMultiplier };
}

/** True when ns.singularity works in this run (BitNode 4 or Source-File 4). */
export function hasSingularity(ns) {
	return singularityInfo(ns).available;
}
