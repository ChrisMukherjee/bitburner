import { notify } from "/utils/notify.js";
import { postGate } from "/singularity/ready.js";
// Darkweb programs in the order they are worth buying. maxFraction caps the share of current
// cash one purchase may take, so the expensive ones don't drain the other managers.
// Port openers come first: each one unlocks more servers for nuke-all and the batcher.
// cost is the darkweb price, used only before TOR is owned (getDarkwebProgramCost returns -1
// without TOR); null = unknown, so TOR is bought on its own cost alone.
const PROGRAMS = [
	{ name: "BruteSSH.exe", maxFraction: 1.0, cost: 500e3 },
	{ name: "FTPCrack.exe", maxFraction: 1.0, cost: 1.5e6 },
	{ name: "relaySMTP.exe", maxFraction: 1.0, cost: 5e6 },
	{ name: "HTTPWorm.exe", maxFraction: 0.9, cost: 30e6 },
	{ name: "SQLInject.exe", maxFraction: 0.8, cost: 250e6 },
	{ name: "DarkscapeNavigator.exe", maxFraction: 0.8, cost: null },
	{ name: "Formulas.exe", maxFraction: 0.5, cost: 5e9 },
];
const TOR_COST = 200e3;
const LOOP_MS = 10_000;
// Key of this script's note for startup.js (singularity/ready.js).
const GATE = "programs";

/**
 * Buys the TOR router, then the darkweb programs above as money comes in (Singularity).
 * TOR alone does nothing, so it is only bought once cash covers TOR plus the next program
 * (within that program's maxFraction), and that program is bought in the same pass. Until then
 * the money stays free for servers, hacknet and home upgrades.
 * Exits once everything is owned. nuke-all (run by the batcher) uses new port openers on its own,
 * and startup.js sees the newly rooted servers on its next pass.
 * After each pass it posts the cash the next purchase needs (or that it is done), and startup.js
 * runs it with --once only when that cash is there.
 *   run singularity/buy-programs.js          keep buying as money comes in
 *   run singularity/buy-programs.js --once   buy what's affordable now, then exit
 */
/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	const flags = ns.flags([["once", false]]);
	const cash = () => ns.getServerMoneyAvailable("home");
	let lastWaiting = "";

	while (true) {
		const missing = PROGRAMS.filter((program) => !ns.fileExists(program.name, "home"));
		if (missing.length === 0) {
			ns.print(`[programs] everything owned, exiting.`);
			postGate(ns, GATE, { done: true });
			return;
		}

		// TOR is only worth buying once the next program can be bought right after it.
		const next = missing[0];
		const torNeeds = TOR_COST + (next.cost ?? 0) / next.maxFraction;
		if (!ns.hasTorRouter()) {
			if (cash() >= torNeeds && ns.singularity.purchaseTor()) {
				notify(ns, "[programs]", "bought the TOR router", "success");
			}
		}

		// Cash the next purchase needs; stays null when nothing left is sold on the darkweb.
		let needCash = null;
		if (ns.hasTorRouter()) {
			// Buy in order, and stop at the first one we can't afford so cheaper later items
			// never jump the queue ahead of a port opener.
			for (const program of missing) {
				let cost = -1;
				try { cost = ns.singularity.getDarkwebProgramCost(program.name); } catch { }
				if (cost < 0) continue; // not sold on the darkweb in this version
				if (cost > cash() * program.maxFraction) {
					needCash = cost / program.maxFraction;
					const waiting = `[programs] waiting: ${program.name} costs $${ns.format.number(cost)}`;
					if (waiting !== lastWaiting) ns.print(waiting);
					lastWaiting = waiting;
					break;
				}
				if (!ns.singularity.purchaseProgram(program.name)) {
					needCash = cash() + 1; // refused although affordable: try again once more money is in
					break;
				}
				notify(ns, "[programs]", `bought ${program.name} for $${ns.format.number(cost)}`, "success");
			}
		} else {
			needCash = torNeeds;
			const waiting = `[programs] waiting: TOR router + ${next.name} need $${ns.format.number(torNeeds)}`;
			if (waiting !== lastWaiting) ns.print(waiting);
			lastWaiting = waiting;
		}

		postGate(ns, GATE, needCash === null && ns.hasTorRouter() ? { done: true } : { needCash: needCash ?? 0 });
		if (flags.once) return;
		await ns.sleep(LOOP_MS);
	}
}
