/** @param {NS} ns **/
import { getAllServers } from "/utils/get-all-servers.js";

// Returns the full list of available compute nodes (home + pservers + rooted botnet)
export function getWorkerPool(ns) {
	let servers = getAllServers(ns);
	let validServers = servers.filter(s => {
		let serverObj = ns.getServer(s);
		return serverObj.hasAdminRights;
	});

	// Separate remote servers/pservers from home, then put home last
	let pool = validServers.filter(s => s !== "home");
	if (validServers.includes("home")) {
		pool.push("home");
	}
	return pool;
}

// Dispatch an exact thread count across the pool with a timing delay
export async function dispatchBatchThreads(ns, workerFiles, scriptToRun, totalThreads, target, delay, homeBuffer = 10) {
	if (!scriptToRun || totalThreads <= 0 || target === undefined || target === null) {
		ns.print(`[ERROR] dispatchBatchThreads received invalid parameters -> Script: ${scriptToRun}, Target: ${target}`);
		return;
	}

	let pool = getWorkerPool(ns);

	let ramPerThread = ns.getScriptRam(scriptToRun);
	let remainingThreads = totalThreads;

	for (let server of pool) {
		if (remainingThreads <= 0) break;

		// Copy worker files to remote servers if missing
		if (server !== "home") {
			await ns.scp(workerFiles, server, "home");
		}

		let maxRam = ns.getServerMaxRam(server);
		let usedRam = ns.getServerUsedRam(server);
		if (server === "home") {
			usedRam = Math.max(usedRam, homeBuffer);
		}

		let ramAvailable = Math.max(0, maxRam - usedRam);
		let possibleThreads = Math.floor(ramAvailable / ramPerThread);

		if (possibleThreads > 0) {
			// Only run what this specific batch step requires, capped by available RAM
			let threadsToRun = Math.min(remainingThreads, possibleThreads);
			let pid = ns.exec(scriptToRun, server, threadsToRun, target, delay);

			if (pid > 0) {
				remainingThreads -= threadsToRun;
			} else {
				ns.print(`[WARNING] Failed to execute ${scriptToRun} on ${server} with ${threadsToRun} threads`);
			}
		}
	}

	if (remainingThreads > 0) {
		ns.print(`[WARNING] Insufficient pool RAM! ${remainingThreads} threads could not be dispatched.`);
	}
}

// Automatically copies required worker files and executes the chosen script across the pool
export async function deployToPool(ns, workerFiles, scriptToRun, target, homeBuffer = 10) {
	// Safeguard: Ensure required parameters are valid before attempting execution
	if (!scriptToRun || target === undefined || target === null) {
		ns.print(`[ERROR] deployToPool received invalid parameters -> Script: ${scriptToRun}, Target: ${target}`);
		return;
	}

	let pool = getWorkerPool(ns);
	let ramPerThread = ns.getScriptRam(scriptToRun);

	for (let server of pool) {
		// Copy worker files to remote servers if missing
		if (server !== "home") {
			await ns.scp(workerFiles, server, "home");
		}

		// Calculate available RAM with safety buffer on home
		let maxRam = ns.getServerMaxRam(server);
		let usedRam = ns.getServerUsedRam(server);
		if (server === "home") {
			usedRam = Math.max(usedRam, homeBuffer);
		}

		let ramAvailable = Math.max(0, maxRam - usedRam);
		let threads = Math.floor(ramAvailable / ramPerThread);

		// Launch if capacity exists
		if (threads > 0) {
			let result = ns.exec(scriptToRun, server, threads, target);
			if (result === 0) {
				ns.print(`[WARNING] Failed to execute ${scriptToRun} on ${server} with ${threads} threads (Target: ${target})`);
			}
		}
	}
}

// Deploy to a specific subset of servers instead of the whole pool
export async function deployToPoolSubset(ns, workerFiles, scriptToRun, target, poolSubset, homeBuffer) {
	let ramPerThread = ns.getScriptRam(scriptToRun);

	for (let server of poolSubset) {
		if (server !== "home") {
			await ns.scp(workerFiles, server, "home");
		}

		let maxRam = ns.getServerMaxRam(server);
		let usedRam = ns.getServerUsedRam(server);
		if (server === "home") {
			usedRam = Math.max(usedRam, homeBuffer);
		}

		let ramAvailable = Math.max(0, maxRam - usedRam);
		let threads = Math.floor(ramAvailable / ramPerThread);

		if (threads > 0) {
			ns.exec(scriptToRun, server, threads, target);
		}
	}
}