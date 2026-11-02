import { loadConfig } from "/utils/config.js";
import { nukeAllServers } from "/utils/nuke-all.js";
import { notify } from "/utils/notify.js";

const DAEMON = "w0r1d_d43m0n";
const DESTROYER = "singularity/next-bitnode.js";
const LOOP_MS = 60_000;

// Which BitNode to go to next: `bitnodeRoute` in the config (config.js, data/config.json),
// a list of { bitNode, level }. The first entry whose Source-File level isn't reached yet wins,
// counting the level this destroy is about to give. When every entry is done, it waits for
// you to pick (run next-bitnode.js, or use --bn).

/**
 * Destroys w0r1d_d43m0n as soon as it can, so the BitNode ends without anyone at the keyboard.
 * The daemon only appears once The Red Pill is installed (buy-augs.js buys it and auto-reset.js
 * resets for it straight away). Then this waits until your hacking level reaches the daemon's
 * requirement and it has root (5 port openers), stops the other scripts on home to make room,
 * and runs next-bitnode.js, which destroys it and starts startup.js in the next BitNode.
 *
 * Small (about 5GB) and cheap to leave running: until the daemon exists it only checks once a minute.
 *
 *   run singularity/auto-destroy.js           next BitNode from bitnodeRoute in the config
 *   run singularity/auto-destroy.js --bn 5    go to BitNode 5 instead
 *   run singularity/auto-destroy.js --dry     only say what it would do
 */
/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	const flags = ns.flags([["bn", 0], ["dry", false]]);
	const route = loadConfig(ns).bitnodeRoute;

	let lastWaiting = "";
	let toldReady = false;
	while (true) {
		const waiting = waitingOn(ns);
		if (waiting) {
			if (waiting !== lastWaiting) ns.print(`[daemon] waiting: ${waiting}`);
			lastWaiting = waiting;
			await ns.sleep(LOOP_MS);
			continue;
		}

		const nextBN = flags.bn > 0 ? flags.bn : routeNext(ns, route);
		if (nextBN === null) {
			if (!toldReady) notify(ns, "[daemon]", `${DAEMON} is ready to destroy, but bitnodeRoute in the config is done. Pick the next BitNode: run /singularity/next-bitnode.js <n>`, "warning", true);
			toldReady = true;
			await ns.sleep(LOOP_MS);
			continue;
		}
		if (flags.dry) {
			if (!toldReady) notify(ns, "[daemon]", `would destroy ${DAEMON} now and enter BitNode ${nextBN} (--dry, not doing it)`, "warning", true);
			toldReady = true;
			await ns.sleep(LOOP_MS);
			continue;
		}

		// Ending the BitNode stops everything anyway, so free home for the 34GB destroyer.
		ns.toast(`Destroying ${DAEMON}, next stop BitNode ${nextBN}`, "success", 10_000);
		for (const proc of ns.ps("home")) {
			if (proc.pid !== ns.pid) ns.kill(proc.pid);
		}
		if (ns.exec(DESTROYER, "home", 1, nextBN) === 0) {
			notify(ns, "[daemon]", `couldn't start ${DESTROYER} (${ns.format.ram(ns.getScriptRam(DESTROYER))}) on home. Run it by hand: run /${DESTROYER} ${nextBN}`, "error", true);
			return;
		}
		await ns.sleep(LOOP_MS); // if the destroy worked, the BitNode is gone before this ends
	}
}

/** Why the daemon can't be destroyed yet, or "" when it can. */
function waitingOn(ns) {
	if (!ns.serverExists(DAEMON)) return "The Red Pill isn't installed yet";
	const needed = ns.getServerRequiredHackingLevel(DAEMON);
	if (ns.getHackingLevel() < needed) return `hacking ${ns.getHackingLevel()} of ${needed}`;
	if (!ns.hasRootAccess(DAEMON)) nukeAllServers(ns);
	if (!ns.hasRootAccess(DAEMON)) return "no root yet (needs all 5 port openers)";
	return "";
}

/** The first route BitNode still short of its level after this destroy, or null when the route is done. */
function routeNext(ns, route) {
	const info = ns.getResetInfo();
	const levels = new Map(info.ownedSF);
	levels.set(info.currentNode, (levels.get(info.currentNode) ?? 0) + 1); // what destroying now gives
	const next = route.find((step) => (levels.get(step.bitNode) ?? 0) < step.level);
	return next ? next.bitNode : null;
}
