/** @param {NS} ns **/
import { getAllServers } from "/utils/get-all-servers.js";
import { nukeAllServers } from "/utils/nuke-all.js";
import { buildRamPool, allocate, threadCapacity, freeRamTotal } from "/utils/ram-pool.js";
import { isHackable, estimateAtMinSecurity, scoreTarget, hasFormulas, preppedServer } from "/utils/targets.js";
import { postIncomeRate } from "/utils/income.js";

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
	launchLeadMs: 500,     // workers are exec'd this long before they must start (covers tick jitter)
	ramBudget: 0.95,       // fraction of network RAM that targets' steady-state batching may commit
	maxBatchShare: 0.2,    // one batch may be at most this much of a target's RAM share (big batches
	                       // overlap unevenly, so later ops of a batch would often find no RAM)
	logMs: 10000,
	incomeWindowMs: 60000, // income is reported as an average over this long (it arrives in bursts)
};

// workers/hack.js keeps a running total of money hacked on this port
const INCOME_PORT = 22;

// Shortest time between consecutive batches' hack landings, per target (longer when RAM is short)
const BATCH_SPACING_MS = CONFIG.gapMs * 4;

function stripSlash(filename) {
	return filename.replace(/^\//, "");
}
const WORKER_FILENAMES = Object.values(WORKER_SCRIPTS).map(stripSlash);

/**
 * Multi-target JIT batcher. Same batch and prep logic as archive/jit-batch-manager-v6.js, except that each
 * worker is exec'd just before it has to start instead of all four at once. Hack and grow used to sit
 * asleep holding their RAM for most of a weaken time; now a batch only holds RAM while each op runs,
 * so about 2.4x as many batches fit in the same RAM:
 *   - A new batch's four ops go on a per-target launch queue. Every tick, queued ops that are due
 *     (start time minus launchLeadMs) are exec'd, earliest start first, before any new batch is queued.
 *     Weakens are due at once; grow and hack come due later.
 *   - If an op can't get RAM, or its tick ran too late for it to land on time, the rest of its batch is
 *     dropped. Ops launch in start order (weaken, weaken, grow, hack), so a dropped batch never leaves a
 *     hack without its weaken or grow.
 *   - Since RAM is no longer claimed up front, batches are rate-limited instead: each target gets a
 *     share of ramBudget x network RAM in rank order, and its batch spacing stretches until one batch's
 *     RAM-time per spacing fits that share. Prep waves are capped at what's left of the budget too.
 *
 * As before, it runs several targets at once out of one shared RAM pool:
 *   - Targets are ranked by utils/targets.js scoreTarget (money per ms of weaken time, estimated
 *     at MIN security) so prepped and unprepped servers are compared fairly.
 *   - Targets are activated in rank order until their estimated steady-state RAM
 *     (one batch's RAM x batches in flight) fills the network (the last one may only partly fit).
 *   - Every tick, active targets are served in rank order, so the best target always gets
 *     first claim on freed RAM and lower targets only use what is left over.
 *   - A target that drops out of the active set stops launching and is forgotten once its
 *     in-flight work has finished. Nothing is killed.
 *
 * With Formulas.exe on home (checked every tick, so buying it mid-run just switches over):
 *   - Batch sizes, hack percent and timings come from ns.formulas at min security, so they are
 *     exact even for a target that isn't prepped yet.
 *   - Targets are ranked by money per GB of RAM per second (their real batch RAM, not a proxy).
 *   - Prep is one combined weaken + grow + weaken wave instead of a weaken wave then a grow wave.
 * Without it, everything works as before.
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
	let formulasWasOn = null; // null so the first tick always reports the mode
	const incomeSamples = [{ time: Date.now(), total: hackedTotal(ns) }]; // for the income average

	while (true) {
		// fx is null without Formulas.exe; every function that takes it falls back to the old logic.
		const fx = hasFormulas(ns) ? { player: ns.getPlayer() } : null;
		if (!!fx !== formulasWasOn) {
			formulasWasOn = !!fx;
			ns.tprint(`[batcher] Formulas.exe ${fx ? "found: exact planning on" : "not found: estimating"}.`);
			lastRetarget = 0; // re-rank with the new scoring
		}

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
			activeTargets = chooseTargets(ns, allServers, scriptRam, totalRam, new Set(previous), fx);
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
		for (const [target, state] of states) {
			if (!activeTargets.includes(target) && !inFlightByTarget.get(target) && state.pending.length === 0) {
				states.delete(target);
			}
		}

		// Batches already under way get first claim on free RAM
		launchDueOps(ns, states, ramPool, scriptRam);

		let budgetLeft = totalRam * CONFIG.ramBudget;
		for (const target of activeTargets) {
			const state = states.get(target);
			const inFlight = inFlightByTarget.get(target) || 0;
			const step = stepTarget(ns, target, state, inFlight, ramPool, scriptRam, totalRam, budgetLeft, batchId, fx);
			batchId = step.batchId;
			budgetLeft = Math.max(0, budgetLeft - step.ramUsed);
		}

		// New batches' weakens are due straight away
		launchDueOps(ns, states, ramPool, scriptRam);

		if (Date.now() - lastLog > CONFIG.logMs) {
			lastLog = Date.now();
			incomeSamples.push({ time: Date.now(), total: hackedTotal(ns) });
			logStatus(ns, states, activeTargets, inFlightByTarget, ramPool, totalRam, incomeSamples);
		}

		await ns.sleep(CONFIG.tickMs);
	}
}

function newTargetState() {
	return {
		mode: "prep",           // "prep" or "batch"
		timings: null,          // times and hack fraction measured while target is at min security
		lastLandTime: 0,        // absolute ms: hack landing of the last queued batch (next is spacing later)
		lastPlan: null,
		pending: [],            // queued ops of started batches: { type, threads, landTime, durationSafety, batch }
		spacing: BATCH_SPACING_MS, // current time between batches (stretched to fit this target's RAM share)
		prepRam: 0,             // RAM held by the current prep wave
		droppedBatches: 0,      // batches dropped part-way since the last log line
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
 * Steady state = one batch's RAM-time (each op's RAM x how long it runs) / batch spacing.
 * With Formulas.exe the score is money per batch / (batch RAM x weaken time), i.e. $ per GB-ms,
 * which accounts for how many grow threads each target needs. Without it, utils/targets.js scoreTarget.
 */
function chooseTargets(ns, allServers, scriptRam, totalRam, currentlyActive, fx) {
	const hackingLevel = ns.getHackingLevel();
	const candidates = [];

	for (const target of allServers) {
		if (!isHackable(ns, target, hackingLevel)) continue;

		const estimate = estimateAtMinSecurity(ns, target, fx?.player);
		if (!(estimate.hackPerThread > 0) || !(estimate.chance > 0)) continue;

		const fraction = Math.min(CONFIG.hackFraction, 0.9);
		const plan = makePlan(ns, target, estimate.hackPerThread, fraction, scriptRam, fx);
		// Game ratios: hack time = weaken / 4, grow time = weaken x 0.8
		const timings = { hack: estimate.weaken / 4, grow: estimate.weaken * 0.8, weaken: estimate.weaken };
		let score = fx
			? (plan.stolen * ns.getServerMaxMoney(target) * estimate.chance) / (plan.ramCost * estimate.weaken)
			: scoreTarget(ns, target, estimate);
		if (currentlyActive.has(target)) score *= CONFIG.stickiness;

		candidates.push({ target, score, steadyRam: batchRamMs(plan, timings, scriptRam) / BATCH_SPACING_MS });
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

/**
 * One tick of work for one target: prep it, or queue new batches at its spacing.
 * budgetLeft is the steady-state RAM still uncommitted after higher-ranked targets.
 * Returns { batchId, ramUsed } where ramUsed is the RAM this target commits out of budgetLeft.
 */
function stepTarget(ns, target, state, inFlight, ramPool, scriptRam, totalRam, budgetLeft, batchId, fx) {
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

	// Timings are only trustworthy at min security, which is when ops will actually start.
	// Formulas can compute them at min security from any state.
	if (fx) {
		const prepped = preppedServer(ns, target);
		state.timings = {
			hack: ns.formulas.hacking.hackTime(prepped, fx.player),
			grow: ns.formulas.hacking.growTime(prepped, fx.player),
			weaken: ns.formulas.hacking.weakenTime(prepped, fx.player),
			hackPerThread: ns.formulas.hacking.hackPercent(prepped, fx.player),
		};
	} else if (atMinSecurity) {
		state.timings = {
			hack: ns.getHackTime(target),
			grow: ns.getGrowTime(target),
			weaken: ns.getWeakenTime(target),
			hackPerThread: ns.hackAnalyze(target),
		};
	}

	// Mode latch: enter batch only when fully prepped and idle; leave only if badly desynced
	if (state.mode === "prep" && inFlight === 0 && state.pending.length === 0 && atMinSecurity && atMaxMoney
		&& state.timings && state.timings.hackPerThread > 0) {
		state.mode = "batch";
		state.lastLandTime = 0;
		ns.print(`[batcher] ${target} prepped. Batching.`);
	}
	if (state.mode === "batch" && (security > minSecurity + 3 || money < maxMoney * 0.3)) {
		state.mode = "prep";
		state.pending = []; // don't start any more of the queued ops
		ns.tprint(
			`[batcher] ${target} desynced (security ${security.toFixed(1)}, ` +
			`money ${(100 * money / maxMoney).toFixed(0)}%). Draining, then re-prepping.`
		);
	}

	if (state.mode === "prep") {
		if (inFlight === 0 && state.pending.length === 0) {
			// Each wave only gets what higher-ranked targets haven't committed, so it can't starve their batches
			state.prepRam = withRamCap(ramPool, budgetLeft, (cappedPool) => {
				if (fx) prepWaveFormulas(ns, target, cappedPool, scriptRam, minSecurity, security, maxMoney, money, fx);
				else prepWave(ns, target, cappedPool, scriptRam, minSecurity, security, maxMoney, money);
			});
		}
		return { batchId, ramUsed: state.prepRam };
	}
	state.prepRam = 0;
	if (!state.timings) return { batchId, ramUsed: 0 };

	// Pick the largest hack fraction whose batch is a small enough slice of this target's RAM share
	let plan = null;
	for (let fraction = CONFIG.hackFraction; fraction >= 0.0005; fraction /= 2) {
		const candidatePlan = makePlan(ns, target, state.timings.hackPerThread, fraction, scriptRam, fx);
		if (candidatePlan.ramCost <= budgetLeft * CONFIG.maxBatchShare) {
			plan = candidatePlan;
			break;
		}
	}
	if (!plan) return { batchId, ramUsed: 0 };
	state.lastPlan = plan;

	// Space batches so that this target's steady-state RAM (RAM-time per batch / spacing) fits its share
	const ramMs = batchRamMs(plan, state.timings, scriptRam);
	const ramUsed = Math.min(ramMs / BATCH_SPACING_MS, budgetLeft);
	if (ramUsed <= 0) return { batchId, ramUsed: 0 };
	state.spacing = Math.max(BATCH_SPACING_MS, ramMs / ramUsed);

	const gap = CONFIG.gapMs;
	// Workers receive an absolute landing time and measure the op duration themselves at the
	// instant they start (duration depends on security at that moment). These live times are only
	// used here to find the earliest landing every op can still hit if launched now; the safety
	// factor covers security being a bit higher by the time a worker starts.
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
		// Spacing is recomputed every tick, so a target whose RAM share grows speeds up straight away
		const nextLandTime = state.lastLandTime + state.spacing;
		// Launch horizon: don't queue batches that land far in the future
		if (nextLandTime > earliestLandTime + CONFIG.horizonMs) break;
		const landTime = Math.max(nextLandTime, earliestLandTime);

		// Landing order: hack, weaken, grow, weaken
		const operations = [
			{ type: "hack", threads: plan.hackThreads, landTime: Math.round(landTime) },
			{ type: "weaken", threads: plan.hackWeakenThreads, landTime: Math.round(landTime + gap) },
			{ type: "grow", threads: plan.growThreads, landTime: Math.round(landTime + 2 * gap) },
			{ type: "weaken", threads: plan.growWeakenThreads, landTime: Math.round(landTime + 3 * gap) },
		];

		// Queue the batch; launchDueOps execs each op when it comes due
		batchId++;
		const batch = { id: batchId };
		for (const operation of operations) {
			state.pending.push({ ...operation, durationSafety: plan.durationSafety, batch });
		}
		state.lastLandTime = landTime;
	}
	return { batchId, ramUsed };
}

// RAM x ms one batch ties up: each op holds its RAM from launch (launchLeadMs early) until it lands.
function batchRamMs(plan, timings, scriptRam) {
	const held = (duration) => duration * plan.durationSafety + CONFIG.launchLeadMs;
	return plan.hackThreads * scriptRam.hack * held(timings.hack) +
		plan.growThreads * scriptRam.grow * held(timings.grow) +
		(plan.hackWeakenThreads + plan.growWeakenThreads) * scriptRam.weaken * held(timings.weaken);
}

/**
 * Execs every queued op (across all targets) whose start time is within launchLeadMs, earliest start
 * first. An op that can't get RAM, or can no longer land on time, drops the rest of its batch. Ops start
 * in the order weaken, weaken, grow, hack, so what's already running is always safe to land without it.
 */
function launchDueOps(ns, states, ramPool, scriptRam) {
	const now = Date.now();
	const due = [];
	for (const [target, state] of states) {
		if (state.pending.length === 0) continue;
		const liveTimes = { hack: ns.getHackTime(target), grow: ns.getGrowTime(target), weaken: ns.getWeakenTime(target) };
		for (const operation of state.pending) {
			const start = operation.landTime - liveTimes[operation.type] * operation.durationSafety;
			if (start - CONFIG.launchLeadMs <= now) {
				due.push({ target, state, operation, start, liveTime: liveTimes[operation.type] });
			}
		}
	}
	due.sort((a, b) => a.start - b.start);

	for (const { target, state, operation, liveTime } of due) {
		if (!state.pending.includes(operation)) continue; // its batch was dropped earlier in this pass
		state.pending.splice(state.pending.indexOf(operation), 1);
		let launched = false;
		if (Date.now() + liveTime <= operation.landTime) {
			const assignments = allocate(ramPool, [operation], scriptRam);
			launched = !!assignments && launchAll(ns, assignments, target, operation.batch.id);
		}
		if (!launched) {
			state.pending = state.pending.filter((other) => other.batch !== operation.batch);
			state.droppedBatches++;
		}
	}
}

/**
 * Runs fn on a copy of the pool that holds at most cap GB of free RAM, then charges what fn
 * allocated back to the real pool. Returns the RAM used.
 */
function withRamCap(ramPool, cap, fn) {
	const cappedPool = [];
	let left = cap;
	for (const entry of ramPool) {
		if (left <= 0) break;
		const freeRam = Math.min(entry.freeRam, left);
		cappedPool.push({ host: entry.host, freeRam, entry, startRam: freeRam });
		left -= freeRam;
	}
	fn(cappedPool);
	let used = 0;
	for (const capped of cappedPool) {
		const spent = capped.startRam - capped.freeRam;
		capped.entry.freeRam -= spent;
		used += spent;
	}
	return used;
}

function makePlan(ns, target, hackPerThread, hackFraction, scriptRam, fx) {
	const weakenPerThread = ns.weakenAnalyze(1);
	const hackThreads = Math.max(1, Math.floor(hackFraction / hackPerThread));
	const stolen = Math.min(0.9, hackThreads * hackPerThread);
	// Formulas: exact threads to regrow from (1 - stolen) of max money at min security.
	// Without it, growthAnalyze uses current security, so it overestimates on an unprepped target.
	let growThreadsExact;
	if (fx) {
		const afterHack = preppedServer(ns, target, ns.getServerMaxMoney(target) * (1 - stolen));
		growThreadsExact = ns.formulas.hacking.growThreads(afterHack, fx.player, afterHack.moneyMax);
	} else {
		growThreadsExact = ns.growthAnalyze(target, 1 / (1 - stolen));
	}
	const growThreads = Math.max(1, Math.ceil(growThreadsExact * CONFIG.growSafety));
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

	return { hackThreads, growThreads, hackWeakenThreads, growWeakenThreads, ramCost, durationSafety, stolen };
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

/**
 * Formulas prep: one wave that lands weaken (to min security), then grow (to max money, sized
 * exactly for min security, which is what it will see when it lands), then a weaken for the
 * grow's security. If it doesn't all fit, the weaken goes first and grow shrinks to fit.
 */
function prepWaveFormulas(ns, target, ramPool, scriptRam, minSecurity, security, maxMoney, money, fx) {
	const weakenPerThread = ns.weakenAnalyze(1);
	const gap = CONFIG.gapMs;
	const weakenThreads = Math.ceil(Math.max(0, security - minSecurity) / weakenPerThread);
	const weakenCapacity = threadCapacity(ramPool, scriptRam.weaken);
	// Ops start now at current security, so use the current (longer) times to find the landing
	const landTime = Date.now() + 50 + Math.max(
		ns.getWeakenTime(target),
		ns.getGrowTime(target) - gap,
		ns.getWeakenTime(target) - 2 * gap
	);

	// Not even the security weaken fits: send what fits and finish next wave
	if (weakenThreads > weakenCapacity) {
		if (weakenCapacity <= 0) return false;
		const assignments = allocate(ramPool, [{ type: "weaken", threads: weakenCapacity, landTime: 0 }], scriptRam);
		return assignments ? launchAll(ns, assignments, target, 0) : false;
	}

	let growThreads = 0;
	if (money < maxMoney * 0.999) {
		const prepped = preppedServer(ns, target, money);
		growThreads = Math.ceil(ns.formulas.hacking.growThreads(prepped, fx.player, maxMoney) * CONFIG.growSafety);
	}

	// Shrink the grow part until the wave fits in free RAM
	while (true) {
		const operations = [];
		if (weakenThreads > 0) operations.push({ type: "weaken", threads: weakenThreads, landTime: Math.round(landTime) });
		if (growThreads > 0) {
			const growWeakenThreads = Math.ceil(ns.growthAnalyzeSecurity(growThreads) / weakenPerThread) + 1;
			operations.push(
				{ type: "grow", threads: growThreads, landTime: Math.round(landTime + gap) },
				{ type: "weaken", threads: growWeakenThreads, landTime: Math.round(landTime + 2 * gap) }
			);
		}
		if (operations.length === 0) return false;
		const assignments = allocate(ramPool, operations, scriptRam);
		if (assignments) return launchAll(ns, assignments, target, 0);
		if (growThreads <= 0) return false;
		growThreads = Math.floor(growThreads * 0.8);
	}
}

// Money hacked so far by workers/hack.js (all runs; only differences between samples matter)
function hackedTotal(ns) {
	return Number(ns.peek(INCOME_PORT)) || 0;
}

/**
 * Income per second from the running total on INCOME_PORT: over the last incomeWindowMs and since
 * the batcher started. getTotalScriptIncome can't be used: it only counts scripts still running,
 * and hack workers exit the moment they pay out, so it always read ~0.
 */
function incomeRates(samples) {
	const first = samples[0];
	const last = samples[samples.length - 1];
	// Keep the first sample (start of run), then drop old ones while the next still covers the window
	while (samples.length > 3 && last.time - samples[2].time >= CONFIG.incomeWindowMs) samples.splice(1, 1);
	const windowStart = last.time - samples[1].time >= CONFIG.incomeWindowMs ? samples[1] : first;
	const rate = (from) => (last.time > from.time ? (1000 * (last.total - from.total)) / (last.time - from.time) : 0);
	return { recent: rate(windowStart), sinceStart: rate(first) };
}

function logStatus(ns, states, activeTargets, inFlightByTarget, ramPool, totalRam, incomeSamples) {
	const freeRam = freeRamTotal(ramPool);
	const income = incomeRates(incomeSamples);
	postIncomeRate(ns, income.recent, CONFIG.incomeWindowMs); // for buy-augs, hacknet/pserv stages (utils/income.js)
	ns.print(
		`[batcher] ${activeTargets.length} active, ${states.size - activeTargets.length} draining, ` +
		`RAM ${ns.format.ram(totalRam - freeRam)} / ${ns.format.ram(totalRam)} in use, ` +
		`income $${ns.format.number(income.recent)}/s last ${CONFIG.incomeWindowMs / 1000}s, ` +
		`$${ns.format.number(income.sinceStart)}/s since start`
	);
	for (const [target, state] of states) {
		const minSecurity = ns.getServerMinSecurityLevel(target);
		const security = ns.getServerSecurityLevel(target);
		const moneyPercent = 100 * ns.getServerMoneyAvailable(target) / ns.getServerMaxMoney(target);
		const role = activeTargets.includes(target) ? state.mode : "drain";
		const plan = state.lastPlan;
		ns.print(
			`  [${role}] ${target} sec +${(security - minSecurity).toFixed(2)} money ${moneyPercent.toFixed(0)}% ` +
			`in-flight ${inFlightByTarget.get(target) || 0} (+${state.pending.length} queued)` +
			(role === "batch"
				? ` every ${Math.round(state.spacing)}ms, ${state.droppedBatches} dropped` +
					` (worst: money ${state.minMoneyPercent.toFixed(0)}%, sec +${state.maxSecurityAboveMin.toFixed(2)})`
				: "") +
			(plan ? ` plan H${plan.hackThreads} W${plan.hackWeakenThreads} G${plan.growThreads} W${plan.growWeakenThreads}` : "")
		);
		state.minMoneyPercent = 100;
		state.maxSecurityAboveMin = 0;
		state.droppedBatches = 0;
	}
}
