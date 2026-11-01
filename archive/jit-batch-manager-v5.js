/** @param {NS} ns **/
import { getAllServers } from "/utils/get-all-servers.js";
import { nukeAllServers } from "/utils/nuke-all.js";
import { buildRamPool, allocate, threadCapacity, freeRamTotal } from "/utils/ram-pool.js";
import { isHackable, estimateAtMinSecurity, scoreTarget } from "/utils/targets.js";

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
	retargetMs: 60000,     // how often the set of active targets is recalculated
	stickiness: 1.25,      // a target already active ranks as if its score were this much higher
	maxTargets: 25,        // upper bound on targets batched at once
	tickMs: 200,
	maxBatchesPerTick: 300, // per target
	horizonMs: 1000,       // don't queue batches landing further than this past the earliest possible slot
	logMs: 10000,
};

// Time between consecutive batches' hack landings, per target
const BATCH_SPACING_MS = CONFIG.gapMs * 4;

function stripSlash(filename) {
	return filename.replace(/^\//, "");
}
const WORKER_FILENAMES = Object.values(WORKER_SCRIPTS).map(stripSlash);

/**
 * Multi-target JIT batcher. Same batch and prep logic as jit-batch-manager-v4.js, but it runs
 * several targets at once out of one shared RAM pool:
 *   - Targets are ranked by utils/targets.js scoreTarget (money per ms of weaken time, estimated
 *     at MIN security) so prepped and unprepped servers are compared fairly.
 *   - Targets are activated in rank order until their estimated steady-state RAM
 *     (one batch's RAM x batches in flight) fills the network (the last one may only partly fit).
 *   - Every tick, active targets are served in rank order, so the best target always gets
 *     first claim on freed RAM and lower targets only use what is left over.
 *   - A target that drops out of the active set stops launching and is forgotten once its
 *     in-flight work has finished. Nothing is killed.
 */
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
	const states = new Map();  // target -> per-target state, for active and draining targets
	let activeTargets = [];    // in rank order
	let lastRetarget = 0;
	let lastLog = 0;
	let batchId = 0;

	while (true) {
		nukeAllServers(ns);
		// Darknet servers need sessions to exec on and can't be hacked normally; leave them out.
		const allServers = getAllServers(ns).filter((server) => !ns.dnet.isDarknetServer(server));

		// Copy fresh workers to every newly rooted server (and to everything on the first pass)
		for (const server of allServers) {
			if (server === "home" || syncedServers.has(server) || !ns.hasRootAccess(server)) continue;
			await ns.scp(Object.values(WORKER_SCRIPTS), server, "home");
			syncedServers.add(server);
		}

		const { ramPool, totalRam } = buildRamPool(ns, allServers, {
			homeReservedRam: CONFIG.homeReservedRam,
			minFreeRam: minScriptRam,
		});
		const inFlightByTarget = countInFlight(ns, allServers);

		if (activeTargets.length === 0 || Date.now() - lastRetarget > CONFIG.retargetMs) {
			lastRetarget = Date.now();
			const previous = activeTargets;
			activeTargets = chooseTargets(ns, allServers, scriptRam, totalRam, new Set(previous));
			const added = activeTargets.filter((target) => !previous.includes(target));
			const dropped = previous.filter((target) => !activeTargets.includes(target));
			if (added.length > 0 || dropped.length > 0) {
				ns.tprint(
					`[batcher] Targets: ${activeTargets.join(", ") || "none"}` +
					(added.length > 0 ? ` | added ${added.join(", ")}` : "") +
					(dropped.length > 0 ? ` | draining ${dropped.join(", ")}` : "")
				);
			}
			for (const target of activeTargets) {
				if (!states.has(target)) states.set(target, newTargetState());
			}
		}

		// Forget targets that are no longer active once their last workers finish
		for (const target of states.keys()) {
			if (!activeTargets.includes(target) && !inFlightByTarget.get(target)) states.delete(target);
		}

		for (const target of activeTargets) {
			const state = states.get(target);
			const inFlight = inFlightByTarget.get(target) || 0;
			batchId = stepTarget(ns, target, state, inFlight, ramPool, scriptRam, totalRam, minScriptRam, batchId);
		}

		if (Date.now() - lastLog > CONFIG.logMs) {
			lastLog = Date.now();
			logStatus(ns, states, activeTargets, inFlightByTarget, ramPool, totalRam);
		}

		await ns.sleep(CONFIG.tickMs);
	}
}

function newTargetState() {
	return {
		mode: "prep",           // "prep" or "batch"
		timings: null,          // times and hack fraction measured while target is at min security
		nextLandTime: 0,        // absolute ms: earliest hack landing for the next batch
		lastPlan: null,
		minMoneyPercent: 100,   // worst money seen since the last log line
		maxSecurityAboveMin: 0, // worst security above min seen since the last log line
	};
}

// One pass over every server's processes; returns target -> number of worker processes aimed at it.
function countInFlight(ns, allServers) {
	const counts = new Map();
	for (const server of allServers) {
		for (const process of ns.ps(server)) {
			if (!WORKER_FILENAMES.includes(stripSlash(process.filename))) continue;
			const target = process.args[0];
			counts.set(target, (counts.get(target) || 0) + 1);
		}
	}
	return counts;
}

/**
 * Ranks every hackable server and activates them in order until their steady-state RAM fills the network.
 * Steady state = one batch's RAM x (weaken time / batch spacing) batches in flight.
 */
function chooseTargets(ns, allServers, scriptRam, totalRam, currentlyActive) {
	const hackingLevel = ns.getHackingLevel();
	const candidates = [];

	for (const target of allServers) {
		if (!isHackable(ns.getServer(target), hackingLevel)) continue;

		const estimate = estimateAtMinSecurity(ns, target);
		if (!(estimate.hackPerThread > 0) || !(estimate.chance > 0)) continue;

		const fraction = Math.min(CONFIG.hackFraction, 0.9);
		const plan = makePlan(ns, target, estimate.hackPerThread, fraction, scriptRam);
		const batchesInFlight = Math.ceil(estimate.weaken / BATCH_SPACING_MS);
		let score = scoreTarget(ns, target, estimate);
		if (currentlyActive.has(target)) score *= CONFIG.stickiness;

		candidates.push({ target, score, steadyRam: plan.ramCost * batchesInFlight });
	}
	candidates.sort((a, b) => b.score - a.score);

	const chosen = [];
	let committedRam = 0;
	for (const candidate of candidates) {
		// Keep adding targets until the network is fully committed. The last one may only partly fit;
		// it is served last, so it just soaks up whatever RAM the better targets leave free.
		if (chosen.length >= CONFIG.maxTargets || committedRam >= totalRam) break;
		chosen.push(candidate.target);
		committedRam += candidate.steadyRam;
	}
	ns.print(
		`[batcher] ${chosen.length} of ${candidates.length} hackable targets chosen, ` +
		`steady-state RAM ${ns.format.ram(committedRam)} / ${ns.format.ram(totalRam)}`
	);
	return chosen;
}

// One tick of work for one target: prep it, or keep its batch pipeline full. Returns the new batchId.
function stepTarget(ns, target, state, inFlight, ramPool, scriptRam, totalRam, minScriptRam, batchId) {
	const minSecurity = ns.getServerMinSecurityLevel(target);
	const security = ns.getServerSecurityLevel(target);
	const maxMoney = ns.getServerMaxMoney(target);
	const money = ns.getServerMoneyAvailable(target);
	const atMinSecurity = security <= minSecurity + 0.01;
	const atMaxMoney = money >= maxMoney * 0.999;

	if (state.mode === "batch") {
		state.minMoneyPercent = Math.min(state.minMoneyPercent, 100 * money / maxMoney);
		state.maxSecurityAboveMin = Math.max(state.maxSecurityAboveMin, security - minSecurity);
	}

	// Timings are only trustworthy at min security, which is when ops will actually start
	if (atMinSecurity) {
		state.timings = {
			hack: ns.getHackTime(target),
			grow: ns.getGrowTime(target),
			weaken: ns.getWeakenTime(target),
			hackPerThread: ns.hackAnalyze(target),
		};
	}

	// Mode latch: enter batch only when fully prepped and idle; leave only if badly desynced
	if (state.mode === "prep" && inFlight === 0 && atMinSecurity && atMaxMoney
		&& state.timings && state.timings.hackPerThread > 0) {
		state.mode = "batch";
		state.nextLandTime = 0;
		ns.print(`[batcher] ${target} prepped. Batching.`);
	}
	if (state.mode === "batch" && (security > minSecurity + 3 || money < maxMoney * 0.3)) {
		state.mode = "prep";
		ns.tprint(
			`[batcher] ${target} desynced (security ${security.toFixed(1)}, ` +
			`money ${(100 * money / maxMoney).toFixed(0)}%). Draining, then re-prepping.`
		);
	}

	if (state.mode === "prep") {
		if (inFlight === 0) prepWave(ns, target, ramPool, scriptRam, minSecurity, security, maxMoney, money);
		return batchId;
	}
	if (!state.timings) return batchId;

	// Pick the largest hack fraction whose batch fits in the whole network
	let plan = null;
	for (let fraction = CONFIG.hackFraction; fraction >= 0.0005; fraction /= 2) {
		const candidatePlan = makePlan(ns, target, state.timings.hackPerThread, fraction, scriptRam);
		if (candidatePlan.ramCost <= totalRam) {
			plan = candidatePlan;
			break;
		}
	}
	if (!plan) return batchId;
	state.lastPlan = plan;

	const gap = CONFIG.gapMs;
	// Workers receive an absolute landing time and measure the op duration themselves at the
	// instant they start (duration depends on security at that moment). These live times are only
	// used here to find the earliest landing every op can still hit; the safety factor covers
	// security being a bit higher by the time a worker starts.
	const liveTimes = {
		hack: ns.getHackTime(target) * plan.durationSafety,
		grow: ns.getGrowTime(target) * plan.durationSafety,
		weaken: ns.getWeakenTime(target) * plan.durationSafety,
	};

	for (let launched = 0; launched < CONFIG.maxBatchesPerTick; launched++) {
		const now = Date.now();
		// Every op must be able to start now or later (delay >= 0)
		const earliestLandTime = now + 50 + Math.max(
			liveTimes.hack,
			liveTimes.weaken - gap,
			liveTimes.grow - 2 * gap,
			liveTimes.weaken - 3 * gap
		);
		// Launch horizon: don't hoard RAM on batches that land far in the future
		if (state.nextLandTime > earliestLandTime + CONFIG.horizonMs) break;
		const landTime = Math.max(state.nextLandTime, earliestLandTime);

		// Landing order: hack, weaken, grow, weaken
		const operations = [
			{ type: "hack", threads: plan.hackThreads, landTime: Math.round(landTime) },
			{ type: "weaken", threads: plan.hackWeakenThreads, landTime: Math.round(landTime + gap) },
			{ type: "grow", threads: plan.growThreads, landTime: Math.round(landTime + 2 * gap) },
			{ type: "weaken", threads: plan.growWeakenThreads, landTime: Math.round(landTime + 3 * gap) },
		];

		const assignments = allocate(ramPool, operations, scriptRam);
		if (!assignments) break; // not enough free RAM for another full batch

		batchId++;
		if (!launchAll(ns, assignments, target, batchId)) {
			state.mode = "prep";
			ns.tprint(`[batcher] exec failed mid-batch on ${target}. Draining, then re-prepping.`);
			break;
		}
		state.nextLandTime = landTime + BATCH_SPACING_MS;
	}
	return batchId;
}

function makePlan(ns, target, hackPerThread, hackFraction, scriptRam) {
	const weakenPerThread = ns.weakenAnalyze(1);
	const hackThreads = Math.max(1, Math.floor(hackFraction / hackPerThread));
	const stolen = Math.min(0.9, hackThreads * hackPerThread);
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

function logStatus(ns, states, activeTargets, inFlightByTarget, ramPool, totalRam) {
	const freeRam = freeRamTotal(ramPool);
	ns.print(
		`[batcher] ${activeTargets.length} active, ${states.size - activeTargets.length} draining, ` +
		`RAM ${ns.format.ram(totalRam - freeRam)} / ${ns.format.ram(totalRam)} in use, ` +
		`income ${ns.format.number(ns.getTotalScriptIncome()[0])}/s`
	);
	for (const [target, state] of states) {
		const minSecurity = ns.getServerMinSecurityLevel(target);
		const security = ns.getServerSecurityLevel(target);
		const moneyPercent = 100 * ns.getServerMoneyAvailable(target) / ns.getServerMaxMoney(target);
		const role = activeTargets.includes(target) ? state.mode : "drain";
		const plan = state.lastPlan;
		ns.print(
			`  [${role}] ${target} sec +${(security - minSecurity).toFixed(2)} money ${moneyPercent.toFixed(0)}% ` +
			`in-flight ${inFlightByTarget.get(target) || 0}` +
			(role === "batch"
				? ` (worst: money ${state.minMoneyPercent.toFixed(0)}%, sec +${state.maxSecurityAboveMin.toFixed(2)})`
				: "") +
			(plan ? ` plan H${plan.hackThreads} W${plan.hackWeakenThreads} G${plan.growThreads} W${plan.growWeakenThreads}` : "")
		);
		state.minMoneyPercent = 100;
		state.maxSecurityAboveMin = 0;
	}
}
