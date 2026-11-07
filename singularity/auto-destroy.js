import { loadConfig } from "/utils/config.js";
import { nukeAllServers } from "/utils/nuke-all.js";
import { notify } from "/utils/notify.js";
import { blackOpsDone } from "/bladeburner/state.js";
import { nextRouteStep } from "/utils/bitnode-route.js";

const DAEMON = "w0r1d_d43m0n";
const DESTROYER = "singularity/next-bitnode.js";
const LOOP_MS = 60_000;

// Which BitNode to go to next: `bitnodeRoute` in the config (config.js, data/config.json),
// a list of { bitNode, level }, read by utils/bitnode-route.js. The first entry whose Source-File level isn't reached yet wins,
// counting the level this destroy is about to give. When every entry is done, it waits for
// you to pick (run next-bitnode.js <n>, or use --bn). It never backdoors w0r1d_d43m0n itself, so the
// BitNode stays open until you choose.

/**
 * Destroys w0r1d_d43m0n as soon as it can, so the BitNode ends without anyone at the keyboard.
 * The daemon only appears once The Red Pill is installed (buy-augs.js buys it and auto-reset.js
 * resets for it straight away). Then this waits until your hacking level reaches the daemon's
 * requirement and it has root (5 port openers), stops the other scripts on home to make room,
 * and runs next-bitnode.js, which checks and hands over to workers/destroy-daemon.js to destroy it and starts startup.js in the next BitNode.
 *
 * With no BitNode left on the route it only tells you once (sticky toast + terminal) and keeps waiting.
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

		const nextBN = flags.bn > 0 ? flags.bn : (nextRouteStep(ns, route)?.bitNode ?? null);
		if (nextBN === null) {
			if (!toldReady) notify(ns, "[daemon]", `${DAEMON} is ready, but bitnodeRoute is done, so nothing is destroyed and the BitNode stays as it is (go for achievements first if you like). ` +
				`When you want to move on, run: run /singularity/next-bitnode.js <n>  (n = the BitNode to enter, e.g. 5; with alias next-bitnode='run /singularity/next-bitnode.js' just: next-bitnode 5). ` +
				`Or add entries to bitnodeRoute in data/config.json and this goes by itself.`, "warning", true);
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

		// Ending the BitNode stops everything anyway, so free home for the 34GB destroy (next-bitnode.js, then its worker).
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
	if (blackOpsDone(ns)) return ""; // Bladeburner route: the last Black Op ends the BitNode, no daemon needed
	if (!ns.serverExists(DAEMON)) return "The Red Pill isn't installed yet";
	const needed = ns.getServerRequiredHackingLevel(DAEMON);
	if (ns.getHackingLevel() < needed) return `hacking ${ns.getHackingLevel()} of ${needed}`;
	if (!ns.hasRootAccess(DAEMON)) nukeAllServers(ns);
	if (!ns.hasRootAccess(DAEMON)) return "no root yet (needs all 5 port openers)";
	return "";
}
