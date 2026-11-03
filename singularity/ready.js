// Design: docs/startup.md
// The Singularity one-shots (home RAM, cores, programs) leave a note here after each pass saying
// how much cash the next purchase needs, or that nothing is left to buy. startup.js imports the
// ready checks below and only starts a one-shot again once that cash is there, so the script's
// RAM (8GB in BitNode 4, about 75GB at SF4.1) is only used when there is something to do.
// Costs 0.1GB to import (getServerMoneyAvailable); the ports are free.

// One JSON object on the port: { "<key>": { needCash, done, time } }. One-shots run one at a time,
// so read-modify-write is safe. startup.js clears it when it starts (after every reset), so each
// one-shot checks again once in a new run (programs are lost on an aug install, home RAM isn't).
export const GATE_PORT = 33;

/** Every one-shot's last note, or {} when none is posted yet. */
export function readGates(ns) {
	try {
		const gates = JSON.parse(ns.peek(GATE_PORT));
		return gates && typeof gates === "object" ? gates : {};
	} catch {
		return {};
	}
}

/**
 * Posts a one-shot's note: { needCash } when it is waiting for money, { done: true } when there is
 * nothing left to buy this run.
 */
export function postGate(ns, key, note) {
	const gates = readGates(ns);
	gates[key] = { ...note, time: Date.now() };
	ns.clearPort(GATE_PORT);
	ns.writePort(GATE_PORT, JSON.stringify(gates));
}

/** Forgets every note (startup.js, at boot). */
export function clearGates(ns) {
	ns.clearPort(GATE_PORT);
}

/** A ready check for startup.js: true when the one-shot `key` has no note yet, or its cash is there. */
export function cashGate(key) {
	return (ns) => {
		const gate = readGates(ns)[key];
		if (!gate) return true;
		if (gate.done) return false;
		return ns.getServerMoneyAvailable("home") >= (gate.needCash ?? 0);
	};
}

export const homeRamReady = cashGate("home-ram");
export const homeCoresReady = cashGate("home-cores");
export const programsReady = cashGate("programs");

/** auto-backdoor.js: done once every target has a backdoor; until then startup.js runs it on a timer. */
export const backdoorReady = (ns) => !readGates(ns).backdoor?.done;
