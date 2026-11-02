/** @param {NS} ns **/
import { getAllServers } from "/utils/get-all-servers.js";
import { getBestTarget, scoreTarget } from "/utils/get-best-target.js";
import { nukeAllServers } from "/utils/nuke-all.js";

const WORKERS = {
	hack: "/workers/hack.js",
	grow: "/workers/grow.js",
	weaken: "/workers/weaken.js",
};

// --- STABILIZED & FULLY SCALED JIT CONFIGURATION ---
const CONFIG = {
	homeReservedRam: 64,
	gapMs: 100,              // ms between the four landings inside one batch
	hackPercent: 0.10,     // fraction of max money stolen per batch (auto-shrinks if RAM is tiny)
	growSafety: 1.05,      // extra grow threads
	retargetMs: 60000,
	tickMs: 200,
	maxBatchesPerTick: 300,
};

const SPACING = CONFIG.gap * 4; // time between consecutive batches' hack landings

const WORKER_FILENAMES = Object.values(WORKERS).map(stripSlash);

export async function main(ns) {
	ns.disableLog("ALL")

	const ram = {};
	for (const script in WORKERS) {
		ram[script] = ns.getScriptRam(WORKERS[script], "home");
		if (ram[script] <= 0) {
			ns.tprint(`[batcher] Missing worker script ${WORKERS[script]} on home. Aborting.`);
			return;
		}
	}
	const minRam = Math.min(...Object.values(ram));

	const syncedServers = new Set();
	let target = null;
	let pendingTarget = null;     // better target waiting for current one to drain
	let mode = "prep";      // "prep" or "batch"
	let timings = null;        // times and hack fraction measured while target is at min security
	let nextLandTime = 0;      // absolute ms: earliest hack landing for the next batch
	let lastRetarget = 0;
	let lastLog = 0;
	let lastPlan = null;
	let batchId = 0;

	ns.tprint("[batcher] Initialized Separate-Worker Network-Saturation Engine...");

	while (true) {
		// Automatically nuke and gain root on any newly available servers/ports
		nukeAllServers(ns);

		const servers = getAllServers(ns);

		// Copy fresh workers to every newly rooted server (and everything on first pass)
		for (const server of servers) {
			if (server === "home" || syncedServers.has(server) || !ns.hasRootAccess(server)) continue;
			await ns.scp(Object.values(WORKERS), server, "home");
			syncedServers.add(server);
		}

		// Build the pool of servers with free RAM
		const pool = [];
		let totalRam = 0;
		for (const server of servers) {
			if (!ns.hasRootAccess(server)) continue;
			const maxRam = ns.getServerMaxRam(server);
			if (maxRam <= 0) continue;
			const reserved = server === "home" ? CONFIG.homeReservedRam : 0;
			totalRam += Math.max(0, maxRam - reserved);
			const freeRam = maxRam - ns.getServerUsedRam(server) - reserved;
			if (freeRam >= minRam) pool.push({ host: server, freeRam });
		}
		// Keep home last so it is only used when everything else is full
		pool.sort((a, b) => (a.host === "home") - (b.host === "home") || b.freeRam - a.freeRam);

		// Target selection (with hysteresis; only switch after the old target drains)
		if (!target) {
			target = getBestTarget(ns, servers);
			lastRetarget = Date.now();
			ns.tprint(`[batcher] Target: ${target}`);
		} else if (Date.now() - lastRetarget > CONFIG.retargetMs) {
			lastRetarget = Date.now();
			const candidate = getBestTarget(ns, servers);
			const isClearlyBetter = scoreTarget(ns, candidate) > 1.25 * scoreTarget(ns, target);
			pendingTarget = (candidate !== target && isClearlyBetter) ? candidate : null;
		}

		const inFlight = countInFlight(ns, servers, target);
		if (pendingTarget && inFlight === 0) {
			target = pendingTarget;
			pendingTarget = null;
			mode = "prep";
			timings = null;
			nextLandTime = 0;
			ns.tprint(`[batcher] Target: ${target}`);
		}

		const minSecurity = ns.getServerMinSecurityLevel(target);
		const security = ns.getServerSecurityLevel(target);
		const maxMoney = ns.getServerMaxMoney(target);
		const money = ns.getServerMoneyAvailable(target);
		const atMinSecurity = security <= minSecurity + 0.01;
		const atMaxMoney = money >= maxMoney * 0.999;

		// Timings are only trustworthy at min security, which is when ops will actually start
		if (atMinSecurity) {
			timings = {
				hack: ns.getHackTime(target),
				grow: ns.getGrowTime(target),
				weaken: ns.getWeakenTime(target),
				hackPerThread: ns.hackAnalyze(target),
			};
		}

		// Mode latch: enter batch only when fully prepped and idle; leave only if badly desynced
		if (mode === "prep" && inFlight === 0 && atMinSecurity && atMaxMoney
			&& timings && timings.hackPerThread > 0) {
			mode = "batch";
			nextLandTime = 0;
			ns.tprint(`[batcher] ${target} prepped. Batching.`);
		}
		if (mode === "batch" && (security > minSecurity + 3 || money < maxMoney * 0.3)) {
			mode = "prep";
			ns.tprint(
				`[batcher] ${target} desynced (security ${security.toFixed(1)}, ` +
				`money ${(100 * money / maxMoney).toFixed(0)}%). Draining, then re-prepping.`
			);
		}

		if (mode === "prep") {
			if (inFlight === 0) {
				const didLaunch = prepWave(ns, target, pool, ram, minSecurity, security, maxMoney, money);
				if (!didLaunch && Date.now() - lastLog > 10000) {
					const freeTotal = pool.reduce((sum, entry) => sum + entry.freeRam, 0);
					ns.print(
						`[prep] nothing launched: ${pool.length} servers with free RAM, ` +
						`${freeTotal.toFixed(1)} GB free (min worker size ${minRam} GB)`
					);
				}
			}
		} else if (mode === "batch" && !pendingTarget && timings) {
			// Pick the largest hack fraction whose batch fits in the whole network
			let plan = null;
			for (let fraction = CONFIG.hackFraction; fraction >= 0.0005; fraction /= 2) {
				const candidatePlan = makePlan(ns, target, timings, fraction, ram);
				if (candidatePlan.ramCost <= totalRam) {
					plan = candidatePlan;
					break;
				}
			}

			if (!plan) {
				if (Date.now() - lastLog > 10000) ns.print("[WARN] Not enough total RAM for even a tiny batch.");
			} else {
				lastPlan = plan;
				const gap = CONFIG.gapMs;
				let launched = 0;

				while (launched < CONFIG.maxBatchesPerTick) {
					const now = Date.now();
					// Every op must be able to start now or later (delay >= 0)
					const earliestLandTime = now + 50 + Math.max(
						timings.hack,
						timings.weaken - gap,
						timings.grow - 2 * gap,
						timings.weaken - 3 * gap
					);
					const landTime = Math.max(nextLandTime, earliestLandTime);

					// Landing order: hack, weaken, grow, weaken
					const landings = [
						{ type: "hack", threads: plan.hackThreads, landTime: landTime },
						{ type: "weaken", threads: plan.hackWeakenThreads, landTime: landTime + gap },
						{ type: "grow", threads: plan.growThreads, landTime: landTime + 2 * gap },
						{ type: "weaken", threads: plan.growWeakenThreads, landTime: landTime + 3 * gap },
					];
					const operations = landings.map((landing) => ({
						type: landing.type,
						threads: landing.threads,
						delay: Math.max(0, Math.round(landing.landTime - now - timings[landing.type])),
					}));

					const assignments = allocate(pool, operations, ram);
					if (!assignments) break; // not enough free RAM for another full batch

					batchId++;
					if (!launchAll(ns, assignments, target, batchId)) {
						mode = "prep";
						ns.tprint("[batcher] exec failed mid-batch. Draining, then re-prepping.");
						break;
					}
					nextLandTime = landTime + SPACING;
					launched++;
				}
			}
		}

		if (Date.now() - lastLog > 10000) {
			lastLog = Date.now();
			ns.print(
				`[${mode}] ${target} security ${security.toFixed(2)}/${minSecurity.toFixed(2)} ` +
				`money ${(100 * money / maxMoney).toFixed(0)}% in-flight ${inFlight}` +
				(lastPlan
					? ` plan: hack ${lastPlan.hackThreads}, weaken ${lastPlan.hackWeakenThreads}, ` +
					`grow ${lastPlan.growThreads}, weaken ${lastPlan.growWeakenThreads}`
					: "") +
				(pendingTarget ? ` -> switching to ${pendingTarget}` : "")
			);
		}

		await ns.sleep(CONFIG.tickMs);
	}
}

function stripSlash(filename) {
	return filename.replace(/^\//, "");
}

function countInFlight(ns, servers, target) {
	let count = 0;
	for (const server of servers) {
		for (const process of ns.ps(server)) {
			const isWorker = WORKER_FILENAMES.includes(stripSlash(process.filename));
			if (isWorker && process.args[0] === target) count++;
		}
	}
	return count;
}

function makePlan(ns, target, timings, hackFraction, ram) {
	const weakenPerThread = ns.weakenAnalyze(1);
	const hackThreads = Math.max(1, Math.floor(hackFraction / timings.hackPerThread));
	const stolen = Math.min(0.9, hackThreads * timings.hackPerThread);
	const growThreads = Math.max(
		1,
		Math.ceil(ns.growthAnalyze(target, 1 / (1 - stolen)) * CONFIG.growSafety)
	);
	const hackWeakenThreads = Math.max(
		1,
		Math.ceil(ns.hackAnalyzeSecurity(hackThreads, target) / weakenPerThread)
	);
	const growWeakenThreads = Math.max(
		1,
		Math.ceil(ns.growthAnalyzeSecurity(growThreads, target) / weakenPerThread)
	);
	const ramCost =
		hackThreads * ram.hack +
		growThreads * ram.grow +
		(hackWeakenThreads + growWeakenThreads) * ram.weaken;

	return { hackThreads, growThreads, hackWeakenThreads, growWeakenThreads, ramCost };
}

// All-or-nothing placement of operations (threads may be split across servers).
// Only modifies RAM pool on success. Returns a list of assignments, or null if it doesn't fit.
function allocate(pool, operations, ram) {
	const remaining = pool.map((entry) => entry.freeRam);
	const assignments = [];

	for (const operation of operations) {
		let threadsLeft = operation.threads;
		for (let index = 0; index < pool.length && threadsLeft > 0; index++) {
			const fits = Math.floor(remaining[index] / ram[operation.type] + 1e-9);
			const placed = Math.min(threadsLeft, fits);
			if (placed > 0) {
				assignments.push({ host: pool[index].host, threads: placed, operation });
				remaining[index] -= placed * ram[operation.type];
				threadsLeft -= placed;
			}
		}
		if (threadsLeft > 0) return null;
	}

	for (let index = 0; index < pool.length; index++) {
		pool[index].freeRam = remaining[index];
	}
	return assignments;
}

function threadCapacity(pool, ramPerThread) {
	let capacity = 0;
	for (const entry of pool) {
		capacity += Math.floor(entry.freeRam / ramPerThread + 1e-9);
	}
	return capacity;
}

function launchAll(ns, assignments, target, batchId) {
	let allLaunched = true;
	for (const assignment of assignments) {
		const { host, threads, operation } = assignment;
		const pid = ns.exec(WORKERS[operation.type], host, threads, target, operation.delay, batchId);
		if (!pid) {
			allLaunched = false;
			ns.print(`[ERROR] exec failed: ${operation.type} x${threads} on ${host} (is ${WORKER_SCRIPTS[operation.type]} there?)`);
		}
	}
	return allLaunched;
}

// One prep wave: weaken to min security first; then grow (plus its weaken) up to max money.
function prepWave(ns, target, pool, ram, minSecurity, security, maxMoney, money) {
	const weakenPerThread = ns.weakenAnalyze(1);

	if (security > minSecurity + 0.01) {
		const threadsNeeded = Math.ceil((security - minSecurity) / weakenPerThread);
		const weakenThreads = Math.min(threadsNeeded, threadCapacity(pool, ram.weaken));
		if (weakenThreads > 0) {
			const assignments = allocate(
				pool,
				[{ type: "weaken", threads: weakenThreads, delay: 0 }],
				ram
			);
			if (assignments) return launchAll(ns, assignments, target, 0);
		}
	} else if (money < maxMoney * 0.999) {
		const weakenTime = ns.getWeakenTime(target);
		const growTime = ns.getGrowTime(target);

		let growThreads = Math.ceil(ns.growthAnalyze(target, maxMoney / Math.max(money, 1)));
		if (!isFinite(growThreads) || growThreads < 1) growThreads = 1e6;

		// Shrink the wave until it fits in free RAM
		while (growThreads >= 1) {
			const weakenThreads = Math.ceil(ns.growthAnalyzeSecurity(growThreads, target) / weakenPerThread) + 1;
			const operations = [
				{ type: "grow", threads: growThreads, delay: Math.max(0, Math.round(weakenTime - growTime - CONFIG.gapMs)) },
				{ type: "weaken", threads: weakenThreads, delay: 0 },
			];
			const assignments = allocate(pool, operations, ram);
			if (assignments) return launchAll(ns, assignments, target, 0);
			growThreads = Math.floor(growThreads * 0.8);
		}
	}
}