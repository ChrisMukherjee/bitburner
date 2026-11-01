import { notify } from "/utils/notify.js";
// Servers whose backdoor does something (same list as list-backdoors.js, checked against
// the v3.0.0 source). Lower priority = done first. Kept here rather than imported, because
// importing list-backdoors.js would drag its getPlayer/cloud calls into this script's RAM.
const TARGETS = {
	// Hacker faction invites
	"CSEC": 1, "avmnite-02h": 1, "I.I.I.I": 1, "run4theh111z": 1, "fulcrumassets": 1,
	// Megacorps: company faction at 300k rep instead of 400k, easier promotions
	"ecorp": 2, "megacorp": 2, "b-and-a": 2, "blade": 2, "nwo": 2,
	"clarkinc": 2, "omnitek": 2, "4sigma": 2, "kuai-gong": 2, "fulcrumtech": 2,
	// Gyms and universities: 10% off
	"rothman-uni": 3, "summit-uni": 3, "zb-institute": 3, "powerhouse-fitness": 3,
	"iron-gym": 3, "crush-fitness": 3, "snap-fitness": 3, "millenium-fitness": 3,
};

// Other company servers: promotions there need 25% less rep. Done by default; --no-company skips them.
const COMPANY_SERVERS = [
	"helios", "vitalife", "icarus", "univ-energy", "galactic-cyber", "aerocorp", "omnia", "solaris",
	"deltaone", "global-pharm", "nova-med", "lexo-corp", "rho-construction", "alpha-ent", "aevum-police",
	"syscore", "computek", "netlink", "stormtech", "defcomm", "omega-net", "n00dles", "foodnstuff", "joesguns",
];

const LOOP_MS = 60_000;

/**
 * Installs backdoors on the useful servers as soon as they are rooted and your hacking
 * level is high enough. It doesn't root anything itself (to stay under 8GB); the batcher
 * and nuke-all already do that.
 *
 * It walks your terminal along the path (connect, connect, ..., backdoor) and goes back
 * home afterwards, so the terminal will jump around while it works.
 *
 * Flags:
 *   --once     one pass, then exit
 *   --no-company  skip the other company servers (they only give a small promotion bonus)
 *   --daemon   also backdoor w0r1d_d43m0n. THIS ENDS THE BITNODE. Off by default.
 */
export async function main(ns) {
	ns.disableLog("ALL");
	const flags = ns.flags([["once", false], ["no-company", false], ["daemon", false]]);

	const priority = { ...TARGETS };
	if (!flags["no-company"]) for (const host of COMPANY_SERVERS) priority[host] ??= 4;
	if (flags.daemon) priority["w0r1d_d43m0n"] = 5;

	let lastWaiting = "";
	while (true) {
		const routes = findRoutes(ns);
		const waiting = [];
		let remaining = 0;

		const hosts = Object.keys(priority)
			.filter((host) => routes.has(host))
			.sort((first, second) => priority[first] - priority[second]);

		for (const host of hosts) {
			const server = ns.getServer(host);
			if (server.backdoorInstalled) continue;
			remaining++;
			if (!server.hasAdminRights) { waiting.push(`${host} (no root)`); continue; }
			if (ns.getHackingLevel() < server.requiredHackingSkill) {
				waiting.push(`${host} (hack ${server.requiredHackingSkill})`);
				continue;
			}
			if (await backdoorHost(ns, routes.get(host))) {
				remaining--;
				notify(ns, "[backdoor]", `installed on ${host}`, "success");
			} else {
				waiting.push(`${host} (failed, will retry)`);
			}
		}

		if (remaining === 0) {
			ns.print("[backdoor] every target is backdoored, nothing left to do.");
			return;
		}
		const message = `[backdoor] waiting on ${waiting.length}: ${waiting.join(", ")}`;
		if (message !== lastWaiting) ns.print(message);
		lastWaiting = message;

		if (flags.once) return;
		await ns.sleep(LOOP_MS);
	}
}

/** Walks the terminal along the route, backdoors the last server, then goes home. */
async function backdoorHost(ns, route) {
	try {
		ns.singularity.connect("home"); // the terminal may have been left somewhere else
		for (const hop of route.slice(1)) {
			if (!ns.singularity.connect(hop)) return false;
		}
		await ns.singularity.installBackdoor();
		return ns.getServer(route[route.length - 1]).backdoorInstalled;
	} finally {
		ns.singularity.connect("home");
	}
}

/** Breadth-first search from home: hostname -> ["home", ..., hostname]. */
function findRoutes(ns) {
	const routes = new Map([["home", ["home"]]]);
	const queue = ["home"];
	while (queue.length > 0) {
		const current = queue.shift();
		for (const neighbor of ns.scan(current)) {
			if (routes.has(neighbor)) continue;
			routes.set(neighbor, [...routes.get(current), neighbor]);
			queue.push(neighbor);
		}
	}
	return routes;
}
