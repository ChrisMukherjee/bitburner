import { notify } from "/utils/notify.js";
// Darkweb programs in the order they are worth buying. maxFraction caps the share of current
// cash one purchase may take, so the expensive ones don't drain the other managers.
// Port openers come first: each one unlocks more servers for nuke-all and the batcher.
const PROGRAMS = [
	{ name: "BruteSSH.exe", maxFraction: 1.0 },
	{ name: "FTPCrack.exe", maxFraction: 1.0 },
	{ name: "relaySMTP.exe", maxFraction: 1.0 },
	{ name: "HTTPWorm.exe", maxFraction: 0.9 },
	{ name: "SQLInject.exe", maxFraction: 0.8 },
	{ name: "DarkscapeNavigator.exe", maxFraction: 0.8 },
	{ name: "Formulas.exe", maxFraction: 0.5 },
];
const TOR_COST = 200e3;
// A new port opener roots more servers (more room for scripts), so startup.js runs again after one.
const PORT_OPENERS = ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe", "HTTPWorm.exe", "SQLInject.exe"];
const RELAUNCH = "startup.js";
const LOOP_MS = 10_000;

/**
 * Buys the TOR router, then the darkweb programs above as money comes in (Singularity).
 * Exits once everything is owned. nuke-all (run by the batcher) uses new port openers on its own,
 * and after each port opener it runs startup.js on home (retrying until home has room).
 *   run singularity/buy-programs.js          keep buying as money comes in
 *   run singularity/buy-programs.js --once   buy what's affordable now, then exit
 */
/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	const flags = ns.flags([["once", false]]);
	const cash = () => ns.getServerMoneyAvailable("home");
	let lastWaiting = "";
	let relaunchPending = false;

	while (true) {
		if (!ns.hasTorRouter()) {
			if (cash() >= TOR_COST && ns.singularity.purchaseTor()) {
				notify(ns, "[programs]", "bought the TOR router", "success");
			}
		}

		if (ns.hasTorRouter()) {
			// Buy in order, and stop at the first one we can't afford so cheaper later items
			// never jump the queue ahead of a port opener.
			const missing = PROGRAMS.filter((program) => !ns.fileExists(program.name, "home"));
			if (missing.length === 0) {
				ns.print(`[programs] everything owned, exiting.`);
				return;
			}
			for (const program of missing) {
				let cost = -1;
				try { cost = ns.singularity.getDarkwebProgramCost(program.name); } catch { }
				if (cost < 0) continue; // not sold on the darkweb in this version
				if (cost > cash() * program.maxFraction) {
					const waiting = `[programs] waiting: ${program.name} costs $${ns.format.number(cost)}`;
					if (waiting !== lastWaiting) ns.print(waiting);
					lastWaiting = waiting;
					break;
				}
				if (!ns.singularity.purchaseProgram(program.name)) break;
				notify(ns, "[programs]", `bought ${program.name} for $${ns.format.number(cost)}`, "success");
				if (PORT_OPENERS.includes(program.name)) relaunchPending = true;
			}
		} else {
			const waiting = `[programs] waiting: TOR router costs $${ns.format.number(TOR_COST)}`;
			if (waiting !== lastWaiting) ns.print(waiting);
			lastWaiting = waiting;
		}

		if (relaunchPending && ns.exec(RELAUNCH, "home") !== 0) relaunchPending = false;
		if (flags.once) return;
		await ns.sleep(LOOP_MS);
	}
}
