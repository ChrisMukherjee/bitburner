// Design: docs/startup.md
// @ts-check
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
// donate-rep.js: done once the key augments are owned or no seller can take donations this run.
export const donateReady = cashGate("donate");

/** auto-backdoor.js: done once every target has a backdoor; until then startup.js runs it on a timer. */
export const backdoorReady = (ns) => !readGates(ns).backdoor?.done;

/** player-work.js: done once study, travel and every work part are finished this run. */
export const playerWorkReady = (ns) => !readGates(ns)["player-work"]?.done;

/**
 * The least cash at which a home RAM or cores upgrade is next in line (Infinity when none is waiting).
 * It comes from the notes the home buyers post (cost plus their income reserve). No note yet (the
 * first moments of a run, or startup.js isn't running) or home maxed counts as no upgrade, so a
 * missing note never keeps cash from NeuroFlux. Cores post nothing below the stage that runs them.
 */
export function homeUpgradeNeed(ns) {
	const gates = readGates(ns);
	return Math.min(...["home-ram", "home-cores"].map((key) => {
		const gate = gates[key];
		return gate && !gate.done ? gate.needCash ?? 0 : Infinity;
	}));
}

/**
 * Should leftover cash go to a home upgrade instead of NeuroFlux Governor? Home RAM and cores survive
 * an install and raise income, so while one is affordable it wins; NeuroFlux gets the cash only when
 * no home upgrade is affordable (from the other player's NeuroFlux rule).
 */
export function homeUpgradeBeatsNeuroFlux(ns, cash) {
	return cash >= homeUpgradeNeed(ns);
}
