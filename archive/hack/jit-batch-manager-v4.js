/** @param {NS} ns **/
import { getAllServers } from "/utils/get-all-servers.js";
import { pickTarget, scoreTarget } from "/utils/get-best-target.js";
import { nukeAllServers } from "/utils/nuke-all.js";

const WORKER_SCRIPTS = {
	hack: "/workers/hack.js",
	grow: "/workers/grow.js",
	weaken: "/workers/weaken.js",
};

const CONFIG = {
	homeReservedRam: 64,
	gapMs: 100,            // time between the four landings inside one batch
	hackFraction: 0.10,    // fraction of max money stolen per batch (shrinks automatically if RAM is tiny)
	growSafety: 1.05,      // extra grow threads as a safety margin
	retargetMs: 60000,
	tickMs: 200,
	maxBatchesPerTick: 300,
	horizonMs: 1000,       // don't queue batches landing further than this past the earliest possible slot
};

// Time between consecutive batches' hack landings
const BATCH_SPACING_MS = CONFIG.gapMs * 4;

function stripSlash(filename) {
	return filename.replace(/^\//, "");
}
const WORKER_FILENAMES = Object.values(WORKER_SCRIPTS).map(stripSlash);

export async function main(ns) {
	ns.disableLog("ALL");

	const scriptRam = {};
	for (const scriptType in WORKER_SCRIPTS) {
		scriptRam[scriptType] = ns.getScriptRam(WORKER_SCRIPTS[scriptType], "home");
		if (scriptRam[scriptType] <= 0) {
			ns.tprint(`[batcher] Missing worker script ${WORKER_SCRIPTS[scriptType]} on home. Aborting.`);
			return;
		}
	}
	const minScriptRam = Math.min(...Object.values(scriptRam));

	const syncedServers = new Set();
	let target = null;
	let pendingTarget = null;  // better target waiting for the current one to drain
	let mode = "prep";         // "prep" or "batch"
	let timings = null;        // times and hack fraction measured while target is at min security
	let nextLandTime = 0;      // absolute ms: earliest hack landing for the next batch
	let lastRetarget = 0;
	let lastLog = 0;
	let lastPlan = null;
	let batchId = 0;
	let minMoneyPercent = 100;       // worst target money seen since the last log line
	let maxSecurityAboveMin = 0;     // worst target security above min seen since the last log line

	while (true) {
		nukeAllServers(ns);
		const allServers = getAllServers(ns);

		// Copy fresh workers to every newly rooted server (and to everything on the first pass)
		for (const server of allServers) {
			if (server === "home" || syncedServers.has(server) || !ns.hasRootAccess(server)) continue;
			await ns.scp(Object.values(WORKER_SCRIPTS), server, "home");
			syncedServers.add(server);
		}

		// Build the pool of servers with free RAM
		const ramPool = [];
		let totalRam = 0;
		for (const server of allServers) {
			if (!ns.hasRootAccess(server)) continue;
			const maxRam = ns.getServerMaxRam(server);
			if (maxRam <= 0) continue;
			const reservedRam = server === "home" ? CONFIG.homeReservedRam : 0;
			totalRam += Math.max(0, maxRam - reservedRam);
			const freeRam = maxRam - ns.getServerUsedRam(server) - reservedRam;
			if (freeRam >= minScriptRam) ramPool.push({ host: server, freeRam });
		}
		// Keep home last so it is only used when everything else is full
		ramPool.sort((a, b) => (a.host === "home") - (b.host === "home") || b.freeRam - a.freeRam);

		// Target selection (with hysteresis; only switch after the old target drains)
		if (!target) {
			target = pickTarget(ns, allServers);
			lastRetarget = Date.now();
			ns.tprint(`[batcher] Target: ${target}`);
		} else if (Date.now() - lastRetarget > CONFIG.retargetMs) {
			lastRetarget = Date.now();
			const candidate = pickTarget(ns, allServers);
			const isClearlyBetter = scoreTarget(ns, candidate) > 1.25 * scoreTarget(ns, target);
			const previousPending = pendingTarget;
			pendingTarget = (candidate !== target && isClearlyBetter) ? candidate : null;
			if (pendingTarget !== previousPending) {
				ns.tprint(
					pendingTarget
						? `[batcher] Better target ${pendingTarget} found. Pausing new batches on ${target} to drain.`
						: `[batcher] Switch to ${previousPending} cancelled. Resuming batches on ${target}.`
				);
			}
		}

		const inFlight = countInFlight(ns, allServers, target);
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

		if (mode === "batch") {
			minMoneyPercent = Math.min(minMoneyPercent, 100 * money / maxMoney);
			maxSecurityAboveMin = Math.max(maxSecurityAboveMin, security - minSecurity);
		}

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
				const didLaunch = prepWave(ns, target, ramPool, scriptRam, minSecurity, security, maxMoney, money);
				if (!didLaunch && Date.now() - lastLog > 10000) {
					const freeTotal = ramPool.reduce((sum, entry) => sum + entry.freeRam, 0);
					ns.print(
						`[prep] nothing launched: ${ramPool.length} servers with free RAM, ` +
						`${freeTotal.toFixed(1)} GB free (min worker size ${minScriptRam} GB)`
					);
				}
			}
		} else if (mode === "batch" && !pendingTarget && timings) {
			// Pick the largest hack fraction whose batch fits in the whole network
			let plan = null;
			for (let fraction = CONFIG.hackFraction; fraction >= 0.0005; fraction /= 2) {
				const candidatePlan = makePlan(ns, target, timings, fraction, scriptRam);
				if (candidatePlan.ramCost <= totalRam) {
					plan = candidatePlan;
					break;
				}
			}

			if (!plan) {
				if (Date.now() - lastLog > 10000) {
					const sample = makePlan(ns, target, timings, CONFIG.hackFraction, scriptRam);
					ns.print(
						`[WARN] No batch plan fits. totalRam ${totalRam}, sample plan ${JSON.stringify(sample)}, ` +
						`hackPerThread ${timings.hackPerThread}`
					);
				}
			} else {
				lastPlan = plan;
				const gap = CONFIG.gapMs;
				let launched = 0;

				// Workers receive an absolute landing time and measure the op duration themselves at the
				// instant they start (duration depends on security at that moment). These live times are only
				// used here to find the earliest landing every op can still hit; the safety factor covers
				// security being a bit higher by the time a worker starts.
				const liveTimes = {
					hack: ns.getHackTime(target) * plan.durationSafety,
					grow: ns.getGrowTime(target) * plan.durationSafety,
					weaken: ns.getWeakenTime(target) * plan.durationSafety,
				};

				while (launched < CONFIG.maxBatchesPerTick) {
					const now = Date.now();
					// Every op must be able to start now or later (delay >= 0)
					const earliestLandTime = now + 50 + Math.max(
						liveTimes.hack,
						liveTimes.weaken - gap,
						liveTimes.grow - 2 * gap,
						liveTimes.weaken - 3 * gap
					);
					// Launch horizon: don't hoard RAM on batches that land far in the future
					if (nextLandTime > earliestLandTime + CONFIG.horizonMs) break;
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
						landTime: Math.round(landing.landTime),
					}));

					const assignments = allocate(ramPool, operations, scriptRam);
					if (!assignments) break; // not enough free RAM for another full batch

					batchId++;
					if (!launchAll(ns, assignments, target, batchId)) {
						mode = "prep";
						ns.tprint("[batcher] exec failed mid-batch. Draining, then re-prepping.");
						break;
					}
					nextLandTime = landTime + BATCH_SPACING_MS;
					launched++;
				}
			}
		}

		if (Date.now() - lastLog > 10000) {
			lastLog = Date.now();
			const windowMinMoney = minMoneyPercent;
			const windowMaxSecurity = maxSecurityAboveMin;
			minMoneyPercent = 100;
			maxSecurityAboveMin = 0;
			ns.print(
				`[${mode}] ${target} security ${security.toFixed(2)}/${minSecurity.toFixed(2)} ` +
				`money ${(100 * money / maxMoney).toFixed(0)}% in-flight ${inFlight} ` +
				`(worst since last line: money ${windowMinMoney.toFixed(0)}%, security +${windowMaxSecurity.toFixed(2)})` +
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

function countInFlight(ns, allServers, target) {
	let count = 0;
	for (const server of allServers) {
		for (const process of ns.ps(server)) {
			const isWorker = WORKER_FILENAMES.includes(stripSlash(process.filename));
			if (isWorker && process.args[0] === target) count++;
		}
	}
	return count;
}

function makePlan(ns, target, timings, hackFraction, scriptRam) {
	const weakenPerThread = ns.weakenAnalyze(1);
	const hackThreads = Math.max(1, Math.floor(hackFraction / timings.hackPerThread));
	const stolen = Math.min(0.9, hackThreads * timings.hackPerThread);
	const growThreads = Math.max(
		1,
		Math.ceil(ns.growthAnalyze(target, 1 / (1 - stolen)) * CONFIG.growSafety)
	);
	// Don't pass the target to the security functions: with a target they cap the thread count at what the
	// server's *current* money needs, which is ~0 for grow when the target is already at max money.
	const hackSecurityAdded = ns.hackAnalyzeSecurity(hackThreads);
	const growSecurityAdded = ns.growthAnalyzeSecurity(growThreads);
	const hackWeakenThreads = Math.max(1, Math.ceil(hackSecurityAdded / weakenPerThread));
	const growWeakenThreads = Math.max(1, Math.ceil(growSecurityAdded / weakenPerThread));
	// One batch's worth of extra security, relative to min, is how much longer an op can run if it starts mid-batch
	const securityAdded = hackSecurityAdded + growSecurityAdded;
	const durationSafety = 1 + securityAdded / ns.getServerMinSecurityLevel(target);
	const ramCost =
		hackThreads * scriptRam.hack +
		growThreads * scriptRam.grow +
		(hackWeakenThreads + growWeakenThreads) * scriptRam.weaken;

	return { hackThreads, growThreads, hackWeakenThreads, growWeakenThreads, ramCost, durationSafety };
}

// All-or-nothing placement of operations (threads may be split across servers).
// Only modifies ramPool on success. Returns a list of assignments, or null if it doesn't fit.
function allocate(ramPool, operations, scriptRam) {
	const remaining = ramPool.map((entry) => entry.freeRam);
	const assignments = [];

	for (const operation of operations) {
		let threadsLeft = operation.threads;
		for (let index = 0; index < ramPool.length && threadsLeft > 0; index++) {
			const fits = Math.floor(remaining[index] / scriptRam[operation.type] + 1e-9);
			const placed = Math.min(threadsLeft, fits);
			if (placed > 0) {
				assignments.push({ host: ramPool[index].host, threads: placed, operation });
				remaining[index] -= placed * scriptRam[operation.type];
				threadsLeft -= placed;
			}
		}
		if (threadsLeft > 0) return null;
	}

	for (let index = 0; index < ramPool.length; index++) {
		ramPool[index].freeRam = remaining[index];
	}
	return assignments;
}

function threadCapacity(ramPool, ramPerThread) {
	let capacity = 0;
	for (const entry of ramPool) {
		capacity += Math.floor(entry.freeRam / ramPerThread + 1e-9);
	}
	return capacity;
}

function launchAll(ns, assignments, target, batchId) {
	let allLaunched = true;
	for (const assignment of assignments) {
		const { host, threads, operation } = assignment;
		const pid = ns.exec(WORKER_SCRIPTS[operation.type], host, threads, target, operation.landTime, batchId);
		if (!pid) {
			allLaunched = false;
			ns.print(`[ERROR] exec failed: ${operation.type} x${threads} on ${host} (is ${WORKER_SCRIPTS[operation.type]} there?)`);
		}
	}
	return allLaunched;
}

// One prep wave: weaken to min security first; then grow (plus its weaken) up to max money.
function prepWave(ns, target, ramPool, scriptRam, minSecurity, security, maxMoney, money) {
	const weakenPerThread = ns.weakenAnalyze(1);

	if (security > minSecurity + 0.01) {
		const threadsNeeded = Math.ceil((security - minSecurity) / weakenPerThread);
		const weakenThreads = Math.min(threadsNeeded, threadCapacity(ramPool, scriptRam.weaken));
		if (weakenThreads > 0) {
			const assignments = allocate(
				ramPool,
				[{ type: "weaken", threads: weakenThreads, landTime: 0 }],
				scriptRam
			);
			if (assignments) return launchAll(ns, assignments, target, 0);
		}
	} else if (money < maxMoney * 0.999) {
		const weakenTime = ns.getWeakenTime(target);
		let growThreads = Math.ceil(ns.growthAnalyze(target, maxMoney / Math.max(money, 1)));
		if (!isFinite(growThreads) || growThreads < 1) growThreads = 1e6;

		// Shrink the wave until it fits in free RAM
		while (growThreads >= 1) {
			const weakenThreads = Math.ceil(ns.growthAnalyzeSecurity(growThreads) / weakenPerThread) + 1;
			const operations = [
				{ type: "grow", threads: growThreads, landTime: Math.round(Date.now() + weakenTime - CONFIG.gapMs) },
				{ type: "weaken", threads: weakenThreads, landTime: 0 },
			];
			const assignments = allocate(ramPool, operations, scriptRam);
			if (assignments) return launchAll(ns, assignments, target, 0);
			growThreads = Math.floor(growThreads * 0.8);
		}
	}
	return false;
}