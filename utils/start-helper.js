// Design: docs/ram.md
import { getAllServers } from "/utils/get-all-servers.js";

// The player's own settings, copied along so loadConfig sees them on another server too.
const USER_CONFIG_FILE = "data/config.json";

/**
 * Starts a one-shot helper script wherever it fits: home first, then the calling script's
 * server, then any other rooted server, most free RAM first. The helper and the files it
 * imports (`files`) are copied over from home when it runs somewhere else.
 * Returns the pid, or 0 if no server has room right now.
 */
export function startHelper(ns, script, files, ...args) {
	const ramNeeded = ns.getScriptRam(script, "home");
	const here = ns.getHostname();
	const copies = [script, ...files];
	if (ns.fileExists(USER_CONFIG_FILE, "home")) copies.push(USER_CONFIG_FILE);

	const others = getAllServers(ns)
		.filter((host) => host !== "home" && host !== here && ns.hasRootAccess(host))
		.map((host) => ({ host, freeRam: ns.getServerMaxRam(host) - ns.getServerUsedRam(host) }))
		.filter((entry) => entry.freeRam >= ramNeeded)
		.sort((first, second) => second.freeRam - first.freeRam)
		.map((entry) => entry.host);

	for (const host of ["home", ...(here === "home" ? [] : [here]), ...others]) {
		try {
			if (host !== "home" && !ns.scp(copies, host, "home")) continue;
			const pid = ns.exec(script, host, 1, ...args);
			if (pid !== 0) return pid;
		} catch {
			// e.g. a darknet server without a session: try the next one
		}
	}
	return 0;
}
