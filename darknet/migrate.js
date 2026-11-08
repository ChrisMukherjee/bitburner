// Design: docs/darknet.md
// @ts-check
import { REPORT_PORT, MIGRATE } from "/darknet/config.js";

const MOVED_AWAY = 351; // the server moved and isn't our neighbour any more (see auth.js)
const MAX_FAILS = 5; // refused calls in a row before giving up

// Pushes one neighbour of the server this runs on until it moves, with as many threads as the crawler gave it
// (the effect scales with threads and charisma). A moved server carries its crawler across gaps in the darknet.
// Reports { kind: "migrate", host, from, moved, calls } to the manager. Arg: the neighbour to push.
/** @param {NS} ns */
export async function main(ns) {
	const target = String(ns.args[0]);
	const started = Date.now();
	let calls = 0;
	let fails = 0;
	let moved = false;
	while (Date.now() - started < MIGRATE.pushMs && fails < MAX_FAILS) {
		if (!ns.dnet.probe().includes(target)) { moved = true; break; }
		const result = await ns.dnet.induceServerMigration(target);
		calls++;
		if (result.code === MOVED_AWAY) { moved = true; break; }
		fails = result.success ? 0 : fails + 1;
	}
	ns.getPortHandle(REPORT_PORT).tryWrite(JSON.stringify({
		kind: "migrate", host: target, from: ns.getHostname(), moved, calls, at: Date.now(),
	}));
}
