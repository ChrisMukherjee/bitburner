// Design: docs/ram.md
import { getAllServers } from "/utils/get-all-servers.js";
import { reserveRoom, releaseRoom } from "/utils/ram-reserve.js";

// The player's own settings, copied along so loadConfig sees them on another server too.
const USER_CONFIG_FILE = "data/config.json";
const BITNODE_FILE = "data/bitnode.txt"; // read by loadConfig for the per-BitNode settings

/**
 * Starts a one-shot helper script wherever it fits: home first, then the calling script's
 * server, then any other rooted server, most free RAM first. The helper and the files it
 * imports (`files`) are copied over from home when it runs somewhere else.
 * Returns the pid, or 0 if no server has room right now. Then it reserves room for the helper on
 * another server (utils/ram-reserve.js), so the batcher lets it free up for the next try.
 */
export function startHelper(ns, script, files, ...args) {
	const ramNeeded = ns.getScriptRam(script, "home");
	const here = ns.getHostname();
	const copies = [script, ...files];
	for (const file of [USER_CONFIG_FILE, BITNODE_FILE]) if (ns.fileExists(file, "home")) copies.push(file);

	const rooted = getAllServers(ns).filter((host) => host !== "home" && ns.hasRootAccess(host));
	const others = rooted
		.filter((host) => host !== here)
		.map((host) => ({ host, freeRam: ns.getServerMaxRam(host) - ns.getServerUsedRam(host) }))
		.filter((entry) => entry.freeRam >= ramNeeded)
		.sort((first, second) => second.freeRam - first.freeRam)
		.map((entry) => entry.host);

	for (const host of ["home", ...(here === "home" ? [] : [here]), ...others]) {
		try {
			if (host !== "home" && !ns.scp(copies, host, "home")) continue;
			const pid = ns.exec(script, host, 1, ...args);
			if (pid !== 0) {
				releaseRoom(ns, script);
				return pid;
			}
		} catch {
			// e.g. a darknet server without a session: try the next one
		}
	}
	// Darknet servers need sessions to run on, so they are never reserved.
	reserveRoom(ns, script, ramNeeded, rooted.filter((host) => !ns.dnet.isDarknetServer(host)));
	return 0;
}
