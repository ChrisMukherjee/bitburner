import { notify } from "/utils/notify.js";
/** @param {NS} ns **/
import { getAllServers } from "/utils/get-all-servers.js";
import { buildRamPool, freeRamTotal } from "/utils/ram-pool.js";
import { hasSingularity } from "/utils/singularity.js";

const WORKER = "share/workers/share.js";

const CONFIG = {
	headroom: 0.15,          // fraction of the network's RAM (home included) always left free for the batcher
	homeReservedGb: 128,     // home always keeps at least this much free for scripts started by hand...
	homeReservedShare: 0.05, // ...or this fraction of home's RAM, whichever is bigger
	waveGapMs: 1000,         // pause after a wave ends, so the batcher sees the freed RAM first
	idleCheckMs: 5000,       // how often to check again while not doing faction work
	logMs: 60000,
};

/**
 * Fills RAM the batcher isn't using with share/workers/share.js while the player does faction work,
 * which raises faction rep gain (ns.getSharePower()). Each worker shares once (~10s) and exits,
 * and the next wave only starts a second later, so the batcher always gets freed RAM back first
 * and share only ever gets the leftovers. A slice of the network (--headroom) is never touched.
 * Share power grows with the log of threads, so it's a modest boost; it's for idle RAM only.
 *
 * Home is used too (its cores raise share power), above a reserve of max(128GB, 5% of home).
 * Home is filled last, after the smaller servers.
 *
 *   run /share/share-manager.js                     home + purchased + rooted servers, only during faction work
 *   run /share/share-manager.js --no-home           leave home alone
 *   run /share/share-manager.js --always            share even when not doing faction work
 *   run /share/share-manager.js --headroom 0.3      leave 30% of network RAM free instead of 15%
 *   run /share/share-manager.js --max-threads 500   cap threads per wave
 *
 * Seeing faction work needs the Singularity API (BitNode 4 or Source-File 4). Without it, only
 * --always works (share all the time); otherwise it says so once and exits.
 */
export async function main(ns) {
	ns.disableLog("ALL");
	const flags = ns.flags([
		["no-home", false],
		["always", false],
		["headroom", CONFIG.headroom],
		["max-threads", 0],
	]);

	const workerRam = ns.getScriptRam(WORKER, "home");
	if (workerRam <= 0) {
		notify(ns, "[share]", `missing ${WORKER} on home. Aborting.`, "error", true);
		return;
	}

	// Costs 1GB (getResetInfo). With BN4/SF4 for sure, delete this check and the import to save it.
	if (!flags.always && !hasSingularity(ns)) {
		notify(ns, "[share]", "can't see faction work without BitNode 4 or Source-File 4. Run with --always to share anyway.", "warning", true);
		return;
	}

	const syncedServers = new Set();
	let lastLog = 0;
	let lastState = "";

	while (true) {
		const work = flags.always ? null : ns.singularity.getCurrentWork();
		const factionWork = work?.type === "FACTION";
		if (!factionWork && !flags.always) {
			const state = `[share] idle: not doing faction work (current work: ${work?.type ?? "none"})`;
			if (state !== lastState) ns.print(state);
			lastState = state;
			await ns.sleep(CONFIG.idleCheckMs);
			continue;
		}

		const servers = getAllServers(ns).filter((server) =>
			(!flags["no-home"] || server !== "home") && !ns.dnet.isDarknetServer(server)
		);
		for (const server of servers) {
			if (server === "home" || syncedServers.has(server) || !ns.hasRootAccess(server)) continue;
			ns.scp(WORKER, server, "home");
			syncedServers.add(server);
		}

		const homeReservedRam = Math.max(CONFIG.homeReservedGb, CONFIG.homeReservedShare * ns.getServerMaxRam("home"));
		const { ramPool, totalRam } = buildRamPool(ns, servers, {
			homeReservedRam,
			minFreeRam: workerRam,
		});
		// Smallest servers first: their scraps are the hardest for the batcher to use. Home last.
		ramPool.sort((a, b) => (a.host === "home") - (b.host === "home") || a.freeRam - b.freeRam);
		let budget = freeRamTotal(ramPool) - flags.headroom * totalRam;
		let threadsLeft = flags["max-threads"] > 0 ? flags["max-threads"] : Infinity;

		let launched = 0;
		for (const entry of ramPool) {
			const threads = Math.min(threadsLeft, Math.floor(Math.min(entry.freeRam, budget) / workerRam + 1e-9));
			if (threads <= 0) continue;
			if (ns.exec(WORKER, entry.host, threads) === 0) continue;
			launched += threads;
			threadsLeft -= threads;
			budget -= threads * workerRam;
			if (budget < workerRam || threadsLeft <= 0) break;
		}

		const state = launched > 0 ? "[share] sharing" : "[share] no spare RAM past the headroom";
		if (state !== lastState || Date.now() - lastLog > CONFIG.logMs) {
			ns.print(
				`${state} (${ns.format.ram(flags.headroom * totalRam)} kept back): ${launched} threads (${ns.format.ram(launched * workerRam)} of ` +
				`${ns.format.ram(totalRam)}), share power x${ns.getSharePower().toFixed(3)}` +
				(factionWork ? ` for ${work.factionName}` : "")
			);
			lastLog = Date.now();
		}
		lastState = state;

		// ns.share() takes ~10s; wait for this wave to finish plus a gap before the next one.
		await ns.sleep(launched > 0 ? 10_000 + CONFIG.waveGapMs : CONFIG.idleCheckMs);
	}
}
