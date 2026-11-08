// Design: docs/ram.md
// @ts-check
// Room held free on other servers for scripts that are waiting to start. The batcher (and
// share-manager) fill every free GB off home, so a 17-30GB one-shot helper could wait a long time
// for a gap. A script that can't find room posts a reservation here; utils/ram-pool.js leaves that
// RAM out of the pool, so the batcher stops starting new workers there and the room frees up as
// its workers finish. 0GB: ports only.

// One JSON object on the port: { "<key>": { host, ram, time } }.
export const RESERVE_PORT = 34;
// A reservation that isn't posted again within this time is dropped (its script gave up or crashed).
const MAX_AGE_MS = 5 * 60_000;

/** Every live reservation: { key: { host, ram, time } }. */
export function readReservations(ns) {
	let posted = {};
	try {
		posted = JSON.parse(ns.peek(RESERVE_PORT));
	} catch {
		return {};
	}
	if (!posted || typeof posted !== "object") return {};
	const now = Date.now();
	return Object.fromEntries(Object.entries(posted).filter(([, entry]) => now - entry.time < MAX_AGE_MS));
}

/** GB reserved on each host: { host: GB }. */
export function reservedByHost(ns) {
	const byHost = {};
	for (const { host, ram } of Object.values(readReservations(ns))) byHost[host] = (byHost[host] ?? 0) + ram;
	return byHost;
}

/**
 * Asks for `ram` GB to be kept free on one of `hosts` (servers the caller can run scripts on, not home).
 * Keeps the server it already holds when that still works; otherwise picks the server with the most
 * free RAM right now among those big enough, so the room frees up soonest. Call it again each time the
 * script still can't start (that keeps it alive), and releaseRoom once it has started.
 * Returns the host, or null when no server is big enough.
 */
export function reserveRoom(ns, key, ram, hosts) {
	const all = readReservations(ns);
	const others = (host) => Object.entries(all)
		.filter(([other, entry]) => other !== key && entry.host === host)
		.reduce((sum, [, entry]) => sum + entry.ram, 0);
	const room = (host) => ns.getServerMaxRam(host) - others(host);
	const big = hosts.filter((host) => host !== "home" && room(host) >= ram);
	if (big.length === 0) {
		releaseRoom(ns, key);
		return null;
	}
	const held = all[key]?.host;
	const free = (host) => room(host) - ns.getServerUsedRam(host);
	const host = big.includes(held) ? held : big.sort((first, second) => free(second) - free(first))[0];
	all[key] = { host, ram, time: Date.now() };
	writeAll(ns, all);
	return host;
}

/** Drops the reservation for `key`, if any. */
export function releaseRoom(ns, key) {
	const all = readReservations(ns);
	if (!(key in all)) return;
	delete all[key];
	writeAll(ns, all);
}

function writeAll(ns, all) {
	ns.clearPort(RESERVE_PORT);
	ns.writePort(RESERVE_PORT, JSON.stringify(all));
}
