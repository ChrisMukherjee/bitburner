// @ts-check
/** @param {NS} ns **/
// Shared view of free RAM across every rooted server, and all-or-nothing thread placement on it.
import { reservedByHost } from "/utils/ram-reserve.js";

/**
 * Free RAM on every rooted server, biggest first with home last (so home is only used once
 * everything else is full). Pass only servers you can exec on (e.g. no darknet servers).
 *   homeReservedRam - RAM on home that is never handed out
 *   minFreeRam      - servers with less free RAM than this are left out (use the smallest script's RAM)
 * RAM that a waiting script has reserved on a server (utils/ram-reserve.js, port 34) is left out too,
 * so the batcher and share-manager let it free up.
 * Returns { ramPool: [{ host, freeRam }], totalRam } where totalRam is usable RAM whether free or not.
 */
export function buildRamPool(ns, servers, { homeReservedRam = 0, minFreeRam = 0 } = {}) {
	const ramPool = [];
	let totalRam = 0;
	const reserved = reservedByHost(ns);
	for (const server of servers) {
		if (!ns.hasRootAccess(server)) continue;
		const maxRam = ns.getServerMaxRam(server);
		if (maxRam <= 0) continue;
		const reservedRam = server === "home" ? homeReservedRam : 0;
		totalRam += Math.max(0, maxRam - reservedRam);
		const freeRam = maxRam - ns.getServerUsedRam(server) - reservedRam - (reserved[server] ?? 0);
		if (freeRam >= minFreeRam && freeRam > 0) ramPool.push({ host: server, freeRam });
	}
	ramPool.sort((a, b) => Number(a.host === "home") - Number(b.host === "home") || b.freeRam - a.freeRam);
	return { ramPool, totalRam };
}

/**
 * All-or-nothing placement of operations (threads may be split across servers).
 *   operations - [{ type, threads, ...anything else }], where scriptRam[type] is RAM per thread
 * Only modifies ramPool on success. Returns [{ host, threads, operation }], or null if it doesn't fit.
 */
export function allocate(ramPool, operations, scriptRam) {
	const remaining = ramPool.map((entry) => entry.freeRam);
	const assignments = [];

	for (const operation of operations) {
		let threadsLeft = operation.threads;
		for (let index = 0; index < ramPool.length && threadsLeft > 0; index++) {
			const fits = Math.floor(remaining[index] / scriptRam[operation.type] + 1e-9);
			const placed = Math.min(threadsLeft, fits);
			if (placed > 0) {
				assignments.push({ host: ramPool[index].host, threads: placed, operation });
				remaining[index] -= placed * scriptRam[operation.type];
				threadsLeft -= placed;
			}
		}
		if (threadsLeft > 0) return null;
	}

	for (let index = 0; index < ramPool.length; index++) {
		ramPool[index].freeRam = remaining[index];
	}
	return assignments;
}

/** How many threads of a script with this RAM per thread fit in the pool right now. */
export function threadCapacity(ramPool, ramPerThread) {
	let capacity = 0;
	for (const entry of ramPool) {
		capacity += Math.floor(entry.freeRam / ramPerThread + 1e-9);
	}
	return capacity;
}

/** Total free RAM left in the pool. */
export function freeRamTotal(ramPool) {
	return ramPool.reduce((sum, entry) => sum + entry.freeRam, 0);
}
