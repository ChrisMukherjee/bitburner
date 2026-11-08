// Design: docs/xp-farm.md
import { notify } from "/utils/notify.js";
import { loadConfig } from "/utils/config.js";
import { getAllServers } from "/utils/get-all-servers.js";
import { buildRamPool, freeRamTotal } from "/utils/ram-pool.js";

const WORKER = "hack/workers/weaken.js";
const BATCHER_CLAIM_PORT = 31; // hack/batcher.js posts { time, wantFree }: free RAM its planned batches still need
const SHARE_SCRIPT = "share/share-manager.js";

const CONFIG = {
	claimMaxAgeMs: 30000,    // ignore the batcher's claim if it is older than this (batcher not running)
	homeReservedGb: 128,     // home always keeps at least this much free for scripts started by hand...
	homeReservedShare: 0.05, // ...or this fraction of home's RAM, whichever is bigger
	waveGapMs: 1000,         // pause after a wave ends, so the batcher sees the freed RAM first
	idleCheckMs: 10000,
	logMs: 60000,
};

/**
 * Hacking XP from idle RAM: fills what the batcher leaves free with weaken threads on a cheap target
 * (xpFarm.target, or "auto": the rooted server with the most XP per thread-second), which pay XP every time they finish. Waves like share/share-manager.js: a
 * wave ends before the next starts, so the batcher always sees freed RAM first and this only gets
 * leftovers. Keeps free the larger of xpFarm.headroom of the network's RAM and the batcher's claim (port 31).
 * Stands down while share/share-manager.js is running (it uses the same spare RAM).
 *
 *   run /hack/xp-farm.js                     home + purchased + rooted servers
 *   run /hack/xp-farm.js --no-home           leave home alone
 *   run /hack/xp-farm.js --target n00dles    another target ("auto" picks the best one each wave)
 *   run /hack/xp-farm.js --max-threads 500   cap threads per wave
 */
/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	const settings = loadConfig(ns).xpFarm;
	const flags = ns.flags([["no-home", false], ["target", settings.target], ["headroom", settings.headroom], ["max-threads", 0]]);
	const requested = String(flags.target);

	const workerRam = ns.getScriptRam(WORKER, "home");
	if (workerRam <= 0) { notify(ns, "[xp]", `missing ${WORKER} on home. Aborting.`, "error", true); return; }
	if (requested !== "auto" && !ns.serverExists(requested)) { notify(ns, "[xp]", `target ${requested} does not exist.`, "error", true); return; }

	const synced = new Set();
	let lastLog = 0;
	let lastState = "";
	while (true) {
		const target = requested === "auto" ? bestTarget(ns, settings.maxWaveSeconds ?? 300) : requested;
		if (ns.isRunning(SHARE_SCRIPT, "home") && doingFactionWork(ns)) {
			lastState = "[xp] idle: share-manager is using the spare RAM";
			await ns.sleep(CONFIG.idleCheckMs);
			continue;
		}
		if (!ns.hasRootAccess(target) && !tryNuke(ns, target)) {
			lastState = `[xp] idle: no root access on ${target} yet`;
			await ns.sleep(CONFIG.idleCheckMs);
			continue;
		}
		if (ns.getServerRequiredHackingLevel(target) > ns.getHackingLevel()) {
			lastState = `[xp] idle: ${target} needs hacking ${ns.getServerRequiredHackingLevel(target)}`;
			await ns.sleep(CONFIG.idleCheckMs);
			continue;
		}

		const servers = getAllServers(ns).filter((server) => (!flags["no-home"] || server !== "home") && !ns.dnet.isDarknetServer(server));
		for (const server of servers) {
			if (server === "home" || synced.has(server) || !ns.hasRootAccess(server)) continue;
			ns.scp(WORKER, server, "home");
			synced.add(server);
		}
		const homeReservedRam = Math.max(CONFIG.homeReservedGb, CONFIG.homeReservedShare * ns.getServerMaxRam("home"));
		const { ramPool, totalRam } = buildRamPool(ns, servers, { homeReservedRam, minFreeRam: workerRam });
		ramPool.sort((a, b) => (a.host === "home") - (b.host === "home") || a.freeRam - b.freeRam);
		const keepFree = Math.max(Number(flags.headroom) * totalRam, batcherClaim(ns));
		let budget = freeRamTotal(ramPool) - keepFree;
		let threadsLeft = flags["max-threads"] > 0 ? flags["max-threads"] : Infinity;

		let launched = 0;
		for (const entry of ramPool) {
			const threads = Math.min(threadsLeft, Math.floor(Math.min(entry.freeRam, budget) / workerRam + 1e-9));
			if (threads <= 0) continue;
			if (ns.exec(WORKER, entry.host, { threads, temporary: true }, target, 0) === 0) continue;
			launched += threads;
			threadsLeft -= threads;
			budget -= threads * workerRam;
			if (budget < workerRam || threadsLeft <= 0) break;
		}

		const state = launched > 0 ? "[xp] weakening" : "[xp] no spare RAM past the headroom";
		if (state !== lastState || Date.now() - lastLog > CONFIG.logMs) {
			ns.print(`${state} ${target} (${ns.format.ram(keepFree)} kept back): ${launched} threads (${ns.format.ram(launched * workerRam)} of ${ns.format.ram(totalRam)})`);
			lastLog = Date.now();
		}
		lastState = state;
		await ns.sleep(launched > 0 ? ns.getWeakenTime(target) + 200 + CONFIG.waveGapMs : CONFIG.idleCheckMs);
	}
}

/**
 * The server that pays the most hacking XP per weaken thread-second: XP per thread is 3 + 0.3 x the server's base
 * security (the game's formula), a wave lasts one weaken time. Only rooted servers you can hack with money on them
 * (not purchased servers or home), and a weaken time under maxWaveSeconds, so a wave doesn't hold RAM the batcher wants
 * for minutes. Falls back to joesguns, the usual cheap choice.
 */
function bestTarget(ns, maxWaveSeconds) {
	let best = "joesguns";
	let bestRate = 0;
	for (const server of getAllServers(ns)) {
		if (server === "home" || ns.dnet.isDarknetServer(server) || !ns.hasRootAccess(server)) continue;
		if (ns.getServerMaxMoney(server) <= 0 || ns.getServerRequiredHackingLevel(server) > ns.getHackingLevel()) continue;
		const seconds = ns.getWeakenTime(server) / 1000;
		if (seconds > maxWaveSeconds) continue;
		const rate = (3 + 0.3 * ns.getServerBaseSecurityLevel(server)) / seconds;
		if (rate > bestRate) { bestRate = rate; best = server; }
	}
	return ns.serverExists(best) ? best : "joesguns";
}

/** True during faction work (when share-manager shares). False without the Singularity API. */
function doingFactionWork(ns) {
	try { return ns.singularity.getCurrentWork()?.type === "FACTION"; } catch { return false; }
}

/** Opens the target with whatever ports it needs; false when it can't be rooted yet. */
function tryNuke(ns, target) {
	try { ns.nuke(target); } catch { /* ports still closed */ }
	return ns.hasRootAccess(target);
}

// Free RAM hack/batcher.js still wants for its planned batches (0 if it isn't running). peek is 0GB.
function batcherClaim(ns) {
	const posted = ns.peek(BATCHER_CLAIM_PORT);
	if (!posted || typeof posted !== "object" || Date.now() - posted.time > CONFIG.claimMaxAgeMs) return 0;
	return Number(posted.wantFree) || 0;
}
