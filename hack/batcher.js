// Design: docs/batcher.md
import { notify } from "/utils/notify.js";
/** @param {NS} ns **/
import { getAllServers } from "/utils/get-all-servers.js";
import { nukeAllServers } from "/utils/nuke-all.js";
import { buildRamPool, allocate, threadCapacity, freeRamTotal } from "/utils/ram-pool.js";
import { isHackable, hasFormulas, preppedServer } from "/utils/targets.js";
import { postIncomeRate } from "/utils/income.js";
import { bitnodeMults } from "/utils/bitnode-mults.js";

// Reads of these keys elsewhere in this file are written scriptRam["hack"], not scriptRam.hack: the static RAM
// check charges any .hack/.grow/.weaken property as the NS call of that name (see docs/NETSCRIPT.md).
const WORKER_SCRIPTS = {
	hack: "/hack/workers/hack.js",
	grow: "/hack/workers/grow.js",
	weaken: "/hack/workers/weaken.js",
};
// One-shot helper that measures targets with the 1GB analyze functions (only used without Formulas.exe)
const STATS_SCRIPT = "/hack/workers/target-stats.js";
const STATS_PORT = 27; // (26 is stock-trader.js summary)
// Free RAM the batcher still wants for its planned batches, so share/share-manager.js leaves it alone
const CLAIM_PORT = 31;

const CONFIG = {
	homeReservedRam: 64,   // RAM on home the batcher never uses (for startup.js, status and typed commands)...
	homeReservedShare: 0.25, // ...but at most this share of home, so a small home (fresh BitNode) still helps
	gapMs: 40,             // time between the four landings inside one batch (a target gets at most one
	                       // batch per 4 gaps, so this caps a target's income when RAM is plentiful)
	hackFraction: 0.10,    // fraction of max money stolen per batch for ranking; the real one is picked per
	                       // target (smaller if RAM is tiny, bigger if RAM is plentiful)
	maxHackFraction: 0.8,  // a top target may steal up to this much per batch when RAM is plentiful,
	                       // instead of handing the RAM to worse targets
	growSafety: 1.05,      // extra grow threads as a safety margin (estimated grow rate, no Formulas.exe)...
	growSafetyFormulas: 1.01, // ...and with Formulas.exe, where the grow threads are exact
	batchFromMoney: 0.5,   // start batching once at min security and this share of max money (not waiting for 100%):
	                       // batches earn straight away and each one grows a bit extra until money is back at max
	catchUpPerBatch: 1.25, // ...at most this money multiplier of extra growth per batch
	retargetMs: 60000,     // how often the set of active targets is recalculated
	stickiness: 1.25,      // a target already active ranks as if its score were this much higher
	maxTargets: 25,        // upper bound on targets batched at once
	tickMs: 200,
	maxBatchesPerTick: 300, // per target
	horizonMs: 1000,       // don't queue batches landing further than this past the earliest possible slot
	launchLeadMs: 300,     // workers are exec'd this long before they must start (covers tick jitter)
	psRefreshMs: 1000,     // how often every server's process list is re-read to count workers in flight
	ramBudget: 0.95,       // fraction of network RAM that targets' steady-state batching may commit
	maxBatchShare: 0.2,    // one batch may be at most this much of a target's RAM share (big batches
	                       // overlap unevenly, so later ops of a batch would often find no RAM)
	logMs: 10000,
	incomeWindowMs: 60000, // income is reported as an average over this long (it arrives in bursts)
	statsRefreshMs: 30000, // how often hack/workers/target-stats.js re-measures targets (without Formulas.exe)
	                       // and home's cores (always)
	statsRetryMs: 5000,    // ...and how soon to retry when it couldn't run
	// Game constants (not BitNode-scaled), used instead of hackAnalyzeSecurity/growthAnalyzeSecurity (1GB each)
	hackSecurityPerThread: 0.002,
	growSecurityPerThread: 0.004,
	defaultWeakenPerThread: 0.05, // until target-stats.js has measured the real value; scaled by ServerWeakenRate when the multipliers are known
	coreBonusPerCore: 1 / 16, // each home core past the first adds this to grow and weaken power on home
};

// hack/workers/hack.js keeps a running total of money hacked on this port
const INCOME_PORT = 22;

// Shortest time between consecutive batches' hack landings, per target (longer when RAM is short)
const BATCH_SPACING_MS = CONFIG.gapMs * 4;

function stripSlash(filename) {
	return filename.replace(/^\//, "");
}
// worker filename (no leading slash) -> op type
const WORKER_TYPES = new Map(Object.entries(WORKER_SCRIPTS).map(([type, file]) => [stripSlash(file), type]));

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
 *   - Batch sizes, hack percent, weaken per thread and timings come from ns.formulas at min security,
 *     so they are exact even for a target that isn't prepped yet.
 *   - Targets are ranked by money per GB of RAM per second (their real batch RAM, not a proxy).
 *   - Prep is one combined weaken + grow + weaken wave instead of a weaken wave then a grow wave.
 * Without it, hack/workers/target-stats.js measures hack percent, chance and grow rate every 30s and the
 * batcher rescales them to min security (grow too, so prep and batches are sized for min security).
 * Either way:
 *   - Hack fraction is sized per target: when its RAM share is bigger than 10% batches at full speed
 *     can use, it steals more per batch (up to maxHackFraction); when RAM is short, less.
 *   - Grow and weaken ops go on home first when they fit there whole, with fewer threads for home's
 *     cores (target-stats.js reports the core count).
 *   - The free RAM the planned batches still need is posted on CLAIM_PORT, so share-manager.js
 *     doesn't fill it between launches.
 *
 * RAM: no analyze functions in this file (they are 1GB each). Hack/grow security use the game's
 * constants, weaken per thread comes from formulas or target-stats.js.
 */
export async function main(ns) {
	ns.disableLog("ALL");

	const scriptRam = {};
	for (const scriptType in WORKER_SCRIPTS) {
		scriptRam[scriptType] = ns.getScriptRam(WORKER_SCRIPTS[scriptType], "home");
		if (scriptRam[scriptType] <= 0) {
			notify(ns, "[batcher]", `missing worker script ${WORKER_SCRIPTS[scriptType]} on home. Aborting.`, "error", true);
			return;
		}
	}
	const minScriptRam = Math.min(...Object.values(scriptRam));
	const statsRam = ns.getScriptRam(STATS_SCRIPT, "home");
	if (statsRam <= 0) notify(ns, "[batcher]", `missing ${STATS_SCRIPT} on home: only works with Formulas.exe.`, "warning", true);
	let stats = null;         // last target-stats.js result (no Formulas.exe only)
	let lastStatsAttempt = 0;

	const syncedServers = new Set();
	const states = new Map();  // target -> per-target state, for active and draining targets
	let activeTargets = [];    // in rank order
	let lastRetarget = 0;
	let lastLog = 0;
	let batchId = 0;
	let formulasWasOn = null; // null so the first tick always reports the mode
	let committedRam = 0;     // steady-state RAM the active targets' batches need (from chooseTargets)
	// Worker processes per target, from a full ps pass every psRefreshMs plus what was launched since
	const flight = { time: 0, counts: new Map(), workerRam: 0, launchedSince: new Map() };
	const incomeSamples = [{ time: Date.now(), total: hackedTotal(ns) }]; // for the income average

	while (true) {
		// fx is null without Formulas.exe; every function that takes it falls back to target-stats.js numbers.
		const fx = hasFormulas(ns) ? { player: ns.getPlayer() } : null;
		if (!!fx !== formulasWasOn) {
			const mode = `Formulas.exe ${fx ? "found: exact planning on" : "not found: estimating"}.`;
			if (formulasWasOn === null) ns.print(`[batcher] ${mode}`); // first pass: routine
			else notify(ns, "[batcher]", mode, "info"); // the mode changed mid-run: toast only
			formulasWasOn = !!fx;
			lastRetarget = 0; // re-rank with the new scoring
		}

		nukeAllServers(ns);
		// Darknet servers need sessions to exec on and can't be hacked normally; leave them out.
		const allServers = getAllServers(ns).filter((server) => !ns.dnet.isDarknetServer(server));

		// Copy fresh workers to every newly rooted server (and to everything on the first pass)
		for (const server of allServers) {
			if (server === "home" || syncedServers.has(server) || !ns.hasRootAccess(server)) continue;
			await ns.scp([...Object.values(WORKER_SCRIPTS), STATS_SCRIPT], server, "home");
			syncedServers.add(server);
		}

		const { ramPool, totalRam } = buildRamPool(ns, allServers, {
			homeReservedRam: Math.min(CONFIG.homeReservedRam, ns.getServerMaxRam("home") * CONFIG.homeReservedShare),
			minFreeRam: minScriptRam,
		});
		if (Date.now() - flight.time > CONFIG.psRefreshMs) refreshInFlight(ns, allServers, flight, scriptRam);
		const inFlightByTarget = inFlightCounts(flight);

		// target-stats.js also reports home's cores, so it runs with Formulas.exe too (with no targets)
		if (statsRam > 0 && Date.now() - lastStatsAttempt > CONFIG.statsRetryMs &&
			(!stats || Date.now() - stats.time > CONFIG.statsRefreshMs)) {
			lastStatsAttempt = Date.now();
			const hackable = fx ? [] : allServers.filter((server) => isHackable(ns, server, ns.getHackingLevel()));
			const fresh = await measureTargets(ns, hackable, ramPool, statsRam);
			if (fresh) {
				stats = fresh;
				if (!activeTargets.length) lastRetarget = 0;
			}
		}
		// Everything below gets the numbers it needs through ctx
		const ctx = {
			fx,
			stats: fx ? null : stats,
			weakenPerThread: fx ? ns.formulas.hacking.weakenEffect(1) : stats?.weakenPerThread ?? CONFIG.defaultWeakenPerThread * bitnodeMults(ns).get("ServerWeakenRate"),
			// Grow and weaken run on home are this much stronger per thread (1 + 1/16 per extra core)
			homeBonus: 1 + Math.max(0, (stats?.homeCores ?? 1) - 1) * CONFIG.coreBonusPerCore,
			flight,
			scriptRam,
		};

		if (activeTargets.length === 0 || Date.now() - lastRetarget > CONFIG.retargetMs) {
			lastRetarget = Date.now();
			const previous = activeTargets;
			({ chosen: activeTargets, committedRam } = chooseTargets(ns, allServers, scriptRam, totalRam, new Set(previous), ctx));
			const added = activeTargets.filter((target) => !previous.includes(target));
			const dropped = previous.filter((target) => !activeTargets.includes(target));
			if (added.length > 0 || dropped.length > 0) {
				ns.print(
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
		launchDueOps(ns, states, ramPool, scriptRam, ctx);

		let budgetLeft = totalRam * CONFIG.ramBudget;
		for (const target of activeTargets) {
			const state = states.get(target);
			const inFlight = inFlightByTarget.get(target) || 0;
			const step = stepTarget(ns, target, state, inFlight, ramPool, scriptRam, budgetLeft, batchId, ctx);
			batchId = step.batchId;
			budgetLeft = Math.max(0, budgetLeft - step.ramUsed);
		}

		// New batches' weakens are due straight away
		launchDueOps(ns, states, ramPool, scriptRam, ctx);

		// Tell share-manager.js how much free RAM the planned batches still need (JIT ops claim RAM late)
		ns.clearPort(CLAIM_PORT);
		ns.writePort(CLAIM_PORT, { time: Date.now(), wantFree: Math.max(0, committedRam - flight.workerRam) });

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
		moneySeen: [],          // { time, money } over the last couple of batch spacings (see stepTarget)
		maxSecurityAboveMin: 0, // worst security above min seen since the last log line
	};
}

/**
 * One pass over every server's processes: target -> number of worker processes aimed at it, and the
 * RAM all workers hold. Only run every psRefreshMs (it gets slow with thousands of workers);
 * launches in between are added by noteLaunch, so a fresh prep wave is never missed.
 */
function refreshInFlight(ns, allServers, flight, scriptRam) {
	const counts = new Map();
	let workerRam = 0;
	for (const server of allServers) {
		for (const process of ns.ps(server)) {
			const type = WORKER_TYPES.get(stripSlash(process.filename));
			if (!type) continue;
			const target = process.args[0];
			counts.set(target, (counts.get(target) || 0) + 1);
			workerRam += process.threads * scriptRam[type];
		}
	}
	flight.time = Date.now();
	flight.counts = counts;
	flight.workerRam = workerRam;
	flight.launchedSince = new Map();
}

// Workers in flight per target: last ps pass plus launches since (finished ones count until the next pass)
function inFlightCounts(flight) {
	const counts = new Map(flight.counts);
	for (const [target, launched] of flight.launchedSince) counts.set(target, (counts.get(target) || 0) + launched);
	return counts;
}

function noteLaunch(flight, target, ram) {
	flight.launchedSince.set(target, (flight.launchedSince.get(target) || 0) + 1);
	flight.workerRam += ram;
}

/**
 * Ranks every hackable server and activates them in order until their steady-state RAM fills the budget.
 * Returns { chosen (targets in rank order), committedRam (their steady-state RAM) }.
 * Steady state = one batch's RAM-time (each op's RAM x how long it runs) / batch spacing, using the plan
 * stepTarget would pick with the budget still left (so with Formulas.exe a top target that steals more
 * per batch leaves fewer targets needed).
 * Ranking: money per batch / (batch RAM x weaken time), i.e. $ per GB-ms at a 10% hack, which accounts
 * for how many grow threads each target needs. With Formulas.exe the game computes the threads; without
 * it, they come from target-stats.js's measured grow rate.
 */
function chooseTargets(ns, allServers, scriptRam, totalRam, currentlyActive, ctx) {
	const hackingLevel = ns.getHackingLevel();
	const candidates = [];

	for (const target of allServers) {
		if (!isHackable(ns, target, hackingLevel)) continue;

		const estimate = estimateAtMinSecurity(ns, target, ctx);
		if (!estimate || !(estimate.hackPerThread > 0) || !(estimate.chance > 0)) continue;

		const maxMoney = ns.getServerMaxMoney(target);
		// Money per GB-ms at a 10% hack, so a target that needs many grow threads per dollar (foodnstuff:
		// growth 5) ranks below one that regrows cheaply. Without Formulas the grow threads come from
		// target-stats.js's measured grow rate; ranking by money alone picked foodnstuff on a fresh BitNode.
		const plan = makePlan(ns, target, estimate.hackPerThread, CONFIG.hackFraction, scriptRam, ctx);
		if (!Number.isFinite(plan.ramCost)) continue;
		let score = (plan.stolen * maxMoney * estimate.chance) / (plan.ramCost * estimate["weaken"]);
		// A target that is nearly prepped earns sooner (matters after a restart or on a fresh BitNode)
		score *= 0.5 + 0.5 * Math.min(1, ns.getServerMoneyAvailable(target) / maxMoney);
		if (currentlyActive.has(target)) score *= CONFIG.stickiness;
		// Game ratios: hack time = weaken / 4, grow time = weaken x 0.8
		const timings = { hack: estimate["weaken"] / 4, grow: estimate["weaken"] * 0.8, weaken: estimate["weaken"] };
		candidates.push({ target, score, estimate, timings });
	}
	candidates.sort((a, b) => b.score - a.score);

	const chosen = [];
	const budget = totalRam * CONFIG.ramBudget;
	let committedRam = 0;
	for (const candidate of candidates) {
		// Keep adding targets until the budget is fully committed. The last one may only partly fit;
		// it is served last, so it just soaks up whatever RAM the better targets leave free.
		const budgetLeft = budget - committedRam;
		if (chosen.length >= CONFIG.maxTargets || budgetLeft <= 0) break;
		const picked = pickPlan(ns, candidate.target, candidate.estimate.hackPerThread, candidate.timings,
			budgetLeft, scriptRam, ctx);
		if (!picked) continue;
		chosen.push(candidate.target);
		committedRam += Math.min(picked.ramMs / BATCH_SPACING_MS, budgetLeft);
	}
	const reason = !ctx.fx && !ctx.stats ? " (waiting for target-stats.js: no free RAM to run it?)" : "";
	ns.print(
		`[batcher] ${chosen.length} of ${candidates.length} hackable targets chosen, ` +
		`steady-state RAM ${ns.format.ram(committedRam)} / ${ns.format.ram(totalRam)}${reason}`
	);
	return { chosen, committedRam };
}

/**
 * Picks the batch for a target given the steady-state RAM it may commit (budget): the hack fraction
 * (from maxHackFraction down to tiny) that earns the most per second
 * within that budget. A batch can't be more than maxBatchShare of the budget, and batches can't come
 * faster than one per BATCH_SPACING_MS, so with lots of RAM bigger batches win; with little RAM, smaller
 * ones win (fewer grow threads per dollar), until the 1-thread minimums on each op make them wasteful.
 * Returns { plan, ramMs } or null if nothing fits.
 */
function pickPlan(ns, target, hackPerThread, timings, budget, scriptRam, ctx, catchUp = 1) {
	// Without Formulas.exe big fractions are safe too: the grow rate from target-stats.js is rescaled
	// exactly to min security, and growSafety plus the catch-up grow cover the rest.
	const fractions = [0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.15];
	for (let fraction = CONFIG.hackFraction; fraction >= 0.0005; fraction /= 2) fractions.push(fraction);
	const maxFraction = CONFIG.maxHackFraction;

	let best = null;
	let lastHackThreads = 0;
	for (const fraction of fractions) {
		if (fraction > maxFraction) continue;
		const plan = makePlan(ns, target, hackPerThread, fraction, scriptRam, ctx, catchUp);
		if (plan.hackThreads === lastHackThreads) continue; // already down to the same batch
		lastHackThreads = plan.hackThreads;
		if (plan.ramCost > budget * CONFIG.maxBatchShare) continue; // too big a slice: try smaller
		const ramMs = batchRamMs(plan, timings, scriptRam);
		const moneyRate = plan.stolen / Math.max(BATCH_SPACING_MS, ramMs / budget);
		// Smaller only if clearly better: near-ties go to the bigger batch (fewer processes to exec)
		if (!best || moneyRate > best.moneyRate * 1.02) best = { plan, ramMs, moneyRate, fraction };
	}
	return best;
}

/**
 * What a target looks like once prepped (min security): { weaken (ms), hackPerThread, chance, growPerLn }
 * (growPerLn only without Formulas). With Formulas.exe the game computes it. Without it, the
 * target-stats.js numbers (measured at the security the target had then) are rescaled:
 *   - hack, grow and weaken times all scale with (2.5 x requiredLevel x security + 500)
 *   - hack chance and hack percent scale with (100 - security)
 *   - grow threads per ln(multiplier) scale with 1 / ln(min(1.0035, 1 + 0.03 / security))
 * Returns null without Formulas.exe until target-stats.js has measured the target.
 */
function estimateAtMinSecurity(ns, target, ctx) {
	if (ctx.fx) {
		const prepped = preppedServer(ns, target);
		return {
			weaken: ns.formulas.hacking.weakenTime(prepped, ctx.fx.player),
			hackPerThread: ns.formulas.hacking.hackPercent(prepped, ctx.fx.player),
			chance: ns.formulas.hacking.hackChance(prepped, ctx.fx.player),
		};
	}
	const measured = ctx.stats?.targets[target];
	if (!measured) return null;
	const security = ns.getServerSecurityLevel(target);
	const minSecurity = ns.getServerMinSecurityLevel(target);
	const requiredLevel = ns.getServerRequiredHackingLevel(target);
	const timeScale = (2.5 * requiredLevel * minSecurity + 500) / (2.5 * requiredLevel * security + 500);
	const hackScale = (100 - minSecurity) / Math.max(1e-9, 100 - measured.security);
	const growRate = (sec) => Math.log(Math.min(1.0035, 1 + 0.03 / sec));
	return {
		weaken: ns.getWeakenTime(target) * timeScale,
		hackPerThread: measured.hackPerThread * hackScale,
		chance: Math.min(1, measured.chance * hackScale),
		growPerLn: measured.growPerLn * growRate(measured.security) / growRate(minSecurity),
	};
}

/**
 * Runs hack/workers/target-stats.js (one thread, a few GB, finishes at once) on free RAM and waits for its
 * result on STATS_PORT. With no targets it only reports weaken per thread and home's cores. Returns the result, or null if it couldn't run or didn't answer in time.
 */
async function measureTargets(ns, targets, ramPool, statsRam) {
	const assignments = allocate(ramPool, [{ type: "stats", threads: 1 }], { stats: statsRam });
	if (!assignments) return null;
	const requested = Date.now();
	if (!ns.exec(STATS_SCRIPT, assignments[0].host, 1, ...targets)) return null;
	for (let waited = 0; waited < 3000; waited += 50) {
		await ns.sleep(50);
		const posted = ns.peek(STATS_PORT);
		if (posted && typeof posted === "object" && posted.time >= requested) return posted;
	}
	return null;
}

/**
 * One tick of work for one target: prep it, or queue new batches at its spacing.
 * budgetLeft is the steady-state RAM still uncommitted after higher-ranked targets.
 * Returns { batchId, ramUsed } where ramUsed is the RAM this target commits out of budgetLeft.
 */
function stepTarget(ns, target, state, inFlight, ramPool, scriptRam, budgetLeft, batchId, ctx) {
	const fx = ctx.fx;
	const minSecurity = ns.getServerMinSecurityLevel(target);
	const security = ns.getServerSecurityLevel(target);
	const maxMoney = ns.getServerMaxMoney(target);
	const money = ns.getServerMoneyAvailable(target);
	const atMinSecurity = security <= minSecurity + 0.01;
	// Between a hack landing and its grow, money is below max for a moment. Sampled then, it looked like
	// the target needed catch-up growth, which flipped the plan to huge batches with long gaps (bursty
	// income, idle RAM). So "at max" uses the highest money seen over the last couple of batches.
	const now = Date.now();
	state.moneySeen = state.moneySeen.filter((sample) => sample.time > now - Math.max(1000, 2 * state.spacing));
	state.moneySeen.push({ time: now, money });
	const recentMoney = Math.max(...state.moneySeen.map((sample) => sample.money));
	const atMaxMoney = recentMoney >= maxMoney * 0.999;
	const batchable = money >= maxMoney * CONFIG.batchFromMoney;

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
		const estimate = estimateAtMinSecurity(ns, target, ctx);
		state.timings = {
			hack: ns.getHackTime(target),
			grow: ns.getGrowTime(target),
			weaken: ns.getWeakenTime(target),
			hackPerThread: estimate ? estimate.hackPerThread : 0,
		};
	}

	// Mode latch: enter batch only when fully prepped and idle; leave only if badly desynced
	if (state.mode === "prep" && inFlight === 0 && state.pending.length === 0 && atMinSecurity && batchable
		&& state.timings && state.timings.hackPerThread > 0) {
		state.mode = "batch";
		state.lastLandTime = 0;
		ns.print(`[batcher] ${target} prepped. Batching.`);
	}
	// Mid-batch, money dips by the planned steal and security rises by one batch's worth, so the limits
	// scale with the plan (a fixed 30% money floor would trip on every batch that steals 70% or more)
	const lastPlan = state.lastPlan;
	const securityLimit = lastPlan ? 2 * lastPlan.securityAdded + 1 : 3;
	const moneyFloor = lastPlan ? 0.5 * (1 - lastPlan.stolen) : 0.3;
	if (state.mode === "batch" && (security > minSecurity + securityLimit || money < maxMoney * moneyFloor)) {
		state.mode = "prep";
		state.pending = []; // don't start any more of the queued ops
		ns.print(
			`[batcher] ${target} desynced (security ${security.toFixed(1)}, ` +
			`money ${(100 * money / maxMoney).toFixed(0)}%). Draining, then re-prepping.`
		);
	}

	if (state.mode === "prep") {
		if (inFlight === 0 && state.pending.length === 0) {
			// Each wave only gets what higher-ranked targets haven't committed, so it can't starve their batches
			state.prepRam = withRamCap(ramPool, budgetLeft, (cappedPool) => {
				if (fx) prepWaveFormulas(ns, target, cappedPool, scriptRam, minSecurity, security, maxMoney, money, ctx);
				else prepWave(ns, target, cappedPool, scriptRam, minSecurity, security, maxMoney, money, ctx);
			});
		}
		return { batchId, ramUsed: state.prepRam };
	}
	state.prepRam = 0;
	if (!state.timings) return { batchId, ramUsed: 0 };

	// Hack fraction sized to this target's RAM share (see pickPlan), chosen without catch-up: the extra
	// grow is the same per batch whatever its size, so counting it would always favour the biggest batch.
	// Below max money each batch then grows a bit extra (catch-up), so money climbs back while it earns.
	const picked = pickPlan(ns, target, state.timings.hackPerThread, state.timings, budgetLeft, scriptRam, ctx);
	if (!picked) return { batchId, ramUsed: 0 };
	let { plan, ramMs } = picked;
	// The batch with catch-up must still fit pickPlan's per-batch limit (maxBatchShare of the share), or it
	// can never get its RAM: on a slow-growing target with little RAM, a full 1.25x catch-up needed ~2TB of
	// grow threads on a 124GB network, so the spacing stretched to 35 minutes and nothing was ever hacked.
	// Halve the extra growth until it fits; with none left, batches just regrow what they steal.
	let catchUp = atMaxMoney ? 1 : Math.min(CONFIG.catchUpPerBatch, maxMoney / Math.max(1, recentMoney));
	while (catchUp > 1.001) {
		const withCatchUp = makePlan(ns, target, state.timings.hackPerThread, picked.fraction, scriptRam, ctx, catchUp);
		if (withCatchUp.ramCost <= budgetLeft * CONFIG.maxBatchShare) {
			plan = withCatchUp;
			ramMs = batchRamMs(plan, state.timings, scriptRam);
			break;
		}
		catchUp = 1 + (catchUp - 1) / 2;
	}
	state.lastPlan = plan;

	// Space batches so that this target's steady-state RAM (RAM-time per batch / spacing) fits its share
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
			liveTimes["hack"],
			liveTimes["weaken"] - gap,
			liveTimes["grow"] - 2 * gap,
			liveTimes["weaken"] - 3 * gap
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
	return plan.hackThreads * scriptRam["hack"] * held(timings["hack"]) +
		plan.growThreads * scriptRam["grow"] * held(timings["grow"]) +
		(plan.hackWeakenThreads + plan.growWeakenThreads) * scriptRam["weaken"] * held(timings["weaken"]);
}

/**
 * Execs every queued op (across all targets) whose start time is within launchLeadMs, earliest start
 * first. An op that can't get RAM, or can no longer land on time, drops the rest of its batch. Ops start
 * in the order weaken, weaken, grow, hack, so what's already running is always safe to land without it.
 * Linear in the queue length (batches are marked dropped and queues rebuilt once at the end), since
 * short batch spacing makes queues long.
 */
function launchDueOps(ns, states, ramPool, scriptRam, ctx) {
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
	if (due.length === 0) return;
	due.sort((a, b) => a.start - b.start);

	const touched = new Set();
	for (const { target, state, operation, liveTime } of due) {
		touched.add(state);
		operation.done = true;
		if (operation.batch.dropped) continue; // an earlier op of its batch failed in this pass
		let launched = false;
		if (Date.now() + liveTime <= operation.landTime) {
			const assignments = placeOp(ramPool, operation, scriptRam, ctx.homeBonus);
			launched = !!assignments && launchAll(ns, assignments, target, operation.batch.id, ctx);
		}
		if (!launched) {
			operation.batch.dropped = true;
			state.droppedBatches++;
		}
	}
	for (const state of touched) {
		state.pending = state.pending.filter((operation) => !operation.done && !operation.batch.dropped);
	}
}

/**
 * Places one batch op. Grow and weaken go on home first when the whole op fits there: home's cores make
 * each thread stronger, so it needs threads / homeBonus. Otherwise (and for hack, which cores don't
 * help) the op is spread over the pool as usual.
 */
function placeOp(ramPool, operation, scriptRam, homeBonus) {
	if (homeBonus > 1 && (operation.type === "grow" || operation.type === "weaken")) {
		const home = ramPool.find((entry) => entry.host === "home");
		const threads = Math.max(1, Math.ceil(operation.threads / homeBonus));
		const ram = threads * scriptRam[operation.type];
		if (home && home.freeRam + 1e-9 >= ram) {
			home.freeRam -= ram;
			return [{ host: "home", threads, operation }];
		}
	}
	return allocate(ramPool, [operation], scriptRam);
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

/** catchUp: extra money multiplier the grow should add on top of regrowing what the hack took (1 = none). */
function makePlan(ns, target, hackPerThread, hackFraction, scriptRam, ctx, catchUp = 1) {
	const fx = ctx.fx;
	const weakenPerThread = ctx.weakenPerThread;
	const hackThreads = Math.max(1, Math.floor(hackFraction / hackPerThread));
	const stolen = Math.min(0.9, hackThreads * hackPerThread);
	// Formulas: exact threads to regrow from (1 - stolen) of max money at min security.
	// Without it, target-stats.js grow rate rescaled to min security (ignores grow's small +1$ per thread).
	let growThreadsExact;
	if (fx) {
		const afterHack = preppedServer(ns, target, ns.getServerMaxMoney(target) * (1 - stolen) / catchUp);
		growThreadsExact = ns.formulas.hacking.growThreads(afterHack, fx.player, afterHack.moneyMax);
	} else {
		const estimate = estimateAtMinSecurity(ns, target, ctx);
		growThreadsExact = estimate ? estimate.growPerLn * Math.log(catchUp / (1 - stolen)) : Infinity;
	}
	const growThreads = Math.max(1, Math.ceil(growThreadsExact * (fx ? CONFIG.growSafetyFormulas : CONFIG.growSafety)));
	const hackSecurityAdded = hackThreads * CONFIG.hackSecurityPerThread;
	const growSecurityAdded = growThreads * CONFIG.growSecurityPerThread;
	const hackWeakenThreads = Math.max(1, Math.ceil(hackSecurityAdded / weakenPerThread));
	// The second weaken also covers the hack's security: if the hack lands after the first weaken (game
	// lag), its security would otherwise stay raised and slow every later op
	const growWeakenThreads = Math.max(1, Math.ceil((growSecurityAdded + hackSecurityAdded) / weakenPerThread));
	// One batch's worth of extra security, relative to min, is how much longer an op can run if it starts mid-batch
	const securityAdded = hackSecurityAdded + growSecurityAdded;
	const durationSafety = 1 + securityAdded / ns.getServerMinSecurityLevel(target);
	const ramCost =
		hackThreads * scriptRam["hack"] +
		growThreads * scriptRam["grow"] +
		(hackWeakenThreads + growWeakenThreads) * scriptRam["weaken"];

	return { hackThreads, growThreads, hackWeakenThreads, growWeakenThreads, ramCost, durationSafety, stolen, securityAdded };
}

function launchAll(ns, assignments, target, batchId, ctx) {
	let allLaunched = true;
	for (const assignment of assignments) {
		const { host, threads, operation } = assignment;
		// temporary: not written to the save file (thousands of short workers made saves big and slow)
		const pid = ns.exec(WORKER_SCRIPTS[operation.type], host, { threads, temporary: true },
			target, operation.landTime, batchId);
		if (pid) {
			noteLaunch(ctx.flight, target, threads * ctx.scriptRam[operation.type]);
		} else {
			allLaunched = false;
			ns.print(`[ERROR] exec failed: ${operation.type} x${threads} on ${host} (is ${WORKER_SCRIPTS[operation.type]} there?)`);
		}
	}
	return allLaunched;
}

// One prep wave: weaken to min security first; then grow (plus its weaken) up to max money.
function prepWave(ns, target, ramPool, scriptRam, minSecurity, security, maxMoney, money, ctx) {
	const weakenPerThread = ctx.weakenPerThread;

	if (security > minSecurity + 0.01) {
		const threadsNeeded = Math.ceil((security - minSecurity) / weakenPerThread);
		const weakenThreads = Math.min(threadsNeeded, threadCapacity(ramPool, scriptRam["weaken"]));
		if (weakenThreads > 0) {
			const assignments = allocate(
				ramPool,
				[{ type: "weaken", threads: weakenThreads, landTime: 0 }],
				scriptRam
			);
			if (assignments) return launchAll(ns, assignments, target, 0, ctx);
		}
	} else if (money < maxMoney * 0.999) {
		const weakenTime = ns.getWeakenTime(target);
		// Security is at min here, so the min-security grow rate is the one it will see
		const estimate = estimateAtMinSecurity(ns, target, ctx);
		if (!estimate) return false;
		let growThreads = Math.ceil(estimate.growPerLn * Math.log(maxMoney / Math.max(money, 1)) * CONFIG.growSafety);
		if (!isFinite(growThreads) || growThreads < 1) growThreads = 1e6;

		// Shrink the wave until it fits in free RAM
		while (growThreads >= 1) {
			const weakenThreads = Math.ceil(growThreads * CONFIG.growSecurityPerThread / weakenPerThread) + 1;
			const operations = [
				{ type: "grow", threads: growThreads, landTime: Math.round(Date.now() + weakenTime - CONFIG.gapMs) },
				{ type: "weaken", threads: weakenThreads, landTime: 0 },
			];
			const assignments = allocate(ramPool, operations, scriptRam);
			if (assignments) return launchAll(ns, assignments, target, 0, ctx);
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
function prepWaveFormulas(ns, target, ramPool, scriptRam, minSecurity, security, maxMoney, money, ctx) {
	const fx = ctx.fx;
	const weakenPerThread = ctx.weakenPerThread;
	const gap = CONFIG.gapMs;
	const weakenThreads = Math.ceil(Math.max(0, security - minSecurity) / weakenPerThread);
	const weakenCapacity = threadCapacity(ramPool, scriptRam["weaken"]);
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
		return assignments ? launchAll(ns, assignments, target, 0, ctx) : false;
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
			const growWeakenThreads = Math.ceil(growThreads * CONFIG.growSecurityPerThread / weakenPerThread) + 1;
			operations.push(
				{ type: "grow", threads: growThreads, landTime: Math.round(landTime + gap) },
				{ type: "weaken", threads: growWeakenThreads, landTime: Math.round(landTime + 2 * gap) }
			);
		}
		if (operations.length === 0) return false;
		const assignments = allocate(ramPool, operations, scriptRam);
		if (assignments) return launchAll(ns, assignments, target, 0, ctx);
		if (growThreads <= 0) return false;
		growThreads = Math.floor(growThreads * 0.8);
	}
}

// Money hacked so far by hack/workers/hack.js (all runs; only differences between samples matter)
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
