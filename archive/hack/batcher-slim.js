import { scanAllServers, tryRoot, getTargetScores, mockTarget } from "lib-target.js";
import { shareRamToReserve, homeReserveGb } from "lib-share.js";

// --- CONFIGURATION ---
const CONFIG = {
    autoHackPercent: true, // true: pick the steal % that earns the most from the RAM you have; false: always use hackPercent
    hackPercent: 0.50,     // Auto mode: the most a batch may steal. Fixed mode: exactly what each batch steals
    spacer: 100,           // Milliseconds between the 4 landings of a batch
    maxTargets: 3,         // Most money targets at once. The next one is only added when the ones before have all the RAM they can use
    switchBonus: 1.25,     // A new target must score this much better than a current one to replace it (prepping costs time)
    growMargin: 1.05,      // Extra grow threads so money always refills fully
    xpFarm: true,          // Put RAM the money targets don't need into weaken jobs for hacking XP
    xpTarget: "joesguns",
    loopMs: 1000,          // How often new batches are scheduled (jobs are started on time in between)
    rerankMs: 60000,       // How often the target list is refreshed
    planMs: 10000,         // How often running targets are re-planned for the RAM that is free now
    startEarlyMs: 15,      // Jobs are started this much before they must be, to absorb timer lag (the worker waits off the rest)
    ramMargin: 0.95,       // Plan for this share of the RAM that looks free, so small changes elsewhere don't make jobs fail
    logMs: 10000,          // How often the status line is printed
};

// One tiny script per action (a script's RAM counts every ns function it mentions, so each is smaller than one script that does all three)
const WORKERS = { hack: "job-hack.js", grow: "job-grow.js", weaken: "job-weaken.js" };
const OLD_WORKER = "worker.js"; // only waited for at start: jobs of an older batcher must land before this one starts
const RAM = { hack: 0, grow: 0, weaken: 0, max: 0 }; // GB per thread of each worker, filled in every loop
const HACK_SEC = 0.002; // security added per hack thread
const GROW_SEC = 0.004; // security added per grow thread
const HOLD_PAD = 1.01;  // jobs are started this much earlier than their minimum-security duration, on top of the security allowance
const REFRESH_MS = 40;  // how often free RAM is re-read from the game while jobs are being started

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");
    ns.tprint("[Batcher] Starting. Waiting for any old worker jobs to finish first...");
    await waitForOldWorkers(ns);

    const states = new Map(); // target -> { mode, lastLanding, inFlight, running, pct, interval, peak, times }
    const queue = [];         // jobs waiting for their start time, soonest first
    const synced = new Set(); // hosts that got this run's copy of the worker
    let targets = [];
    let xpInFlight = []; // { threads, end } of XP jobs, so new targets can count that RAM as coming back
    let lastRank = -Infinity, lastPlan = -Infinity, lastLog = -Infinity, lastXp = -Infinity;

    while (true) {
        const now = Date.now();
        const loopStart = now;
        for (const k of Object.keys(WORKERS)) RAM[k] = ns.getScriptRam(WORKERS[k], "home");
        if (Object.values(WORKERS).some(f => ns.getScriptRam(f, "home") <= 0)) {
            ns.tprint(`[Batcher] ERROR: ${Object.values(WORKERS).join(", ")} must all be on home.`);
            return;
        }
        RAM.max = Math.max(RAM.hack, RAM.grow, RAM.weaken);
        const scriptRam = RAM.max; // for planning: every thread counted at the biggest worker
        const pool = buildPool(ns, scriptRam, synced);
        for (const st of states.values()) {
            st.inFlight = st.inFlight.filter(j => j.end > now);
            st.running = st.running.filter(j => j.end > now);
        }
        xpInFlight = xpInFlight.filter(j => j.end > now);
        const xpThreads = xpInFlight.reduce((sum, j) => sum + j.threads, 0);

        // Every minute: refresh the targets. Every 10 s (or when jobs lacked RAM): re-plan running ones for the RAM that is free now
        const rerank = now - lastRank >= CONFIG.rerankMs;
        if (rerank) { targets = chooseTargets(ns, targets, states); lastRank = now; }
        const stale = [...states.values()].some(st => st.replan);
        if (rerank || stale || now - lastPlan >= CONFIG.planMs) {
            targets.forEach((t, i) => {
                const st = states.get(t);
                if (!st) return;
                st.replan = false;
                if (st.mode === "batch") planTarget(ns, t, st, pool, scriptRam, states, targets.slice(0, i), xpThreads);
            });
            lastPlan = now;
        }

        // 1. Each target: prep it when idle and not ready, otherwise keep its batches rolling
        const summary = [];
        for (const target of targets) {
            if (!states.has(target)) states.set(target, { mode: "idle", lastLanding: 0, inFlight: [], running: [], failed: 0 });
            const st = states.get(target);
            const idle = st.inFlight.length === 0;

            if (st.mode !== "batch" || idle && !isPrepped(ns, target)) {
                if (!idle) { summary.push(`${target}: ${st.mode === "prep" ? "prepping" : "finishing"}`); continue; }
                if (isPrepped(ns, target)) {
                    st.mode = "batch";
                    st.lastLanding = 0;
                    st.times = null; // read fresh, the target was just prepped
                    planTarget(ns, target, st, pool, scriptRam, states, targets.filter(t => t !== target), xpThreads);
                } else {
                    st.mode = "prep";
                    // Prep may not use RAM the targets ranked above it are holding back
                    const budget = freeThreads(pool, scriptRam) - reservedThreads(states, targets.slice(0, targets.indexOf(target)));
                    const result = launchPrep(ns, target, pool, scriptRam, budget);
                    if (result.end > 0) st.inFlight.push({ threads: result.threads, end: result.end });
                    summary.push(`${target}: ${result.text}`);
                    continue;
                }
            }
            summary.push(`${target}: ${scheduleBatches(ns, target, st, queue)}`);
        }
        queue.sort((a, b) => a.start - b.start);

        // 2. RAM no money target is holding back goes to XP
        if (CONFIG.xpFarm && now - lastXp >= CONFIG.logMs) {
            const spare = freeThreads(pool, scriptRam) - reservedThreads(states, targets);
            const xp = launchXpFarm(ns, pool, scriptRam, spare);
            if (xp > 0) xpInFlight.push({ threads: xp, end: Date.now() + ns.getWeakenTime(CONFIG.xpTarget) + 100 });
            if (xpThreads + xp > 0) summary.push(`XP on ${CONFIG.xpTarget}: ${xpThreads + xp} threads`);
            lastXp = now;
        }

        if (now - lastLog >= CONFIG.logMs) {
            // Port 24 = measured income, in the format the repo's utils/income.js reads (used by buy-augs.js for the reset advice)
            ns.clearPort(24);
            ns.writePort(24, { perSecond: [...states.values()].reduce((sum, t) => sum + (t.mode === "batch" ? (t.perSec || 0) : 0), 0), windowMs: CONFIG.logMs, time: Date.now() });
            ns.print(`[Status] ${summary.join(" | ") || "nothing to do"}`);
            for (const st of states.values()) st.failed = 0;
            lastLog = now;
        }
        // Start queued jobs at their start times until the next loop is due
        await dispatch(ns, { pool, scriptRam, queue, lastRefresh: Date.now() }, loopStart + CONFIG.loopMs);
    }
}

/**
 * Picks the money targets. RAM goes to the best one first: another target is only added once the
 * ones before it are batching at full size, because a target that's short of RAM earns about the same
 * per GB as a second one would, and a second one costs a prep. Current targets keep their place
 * unless another scores switchBonus times better, so small level-ups don't cause a re-prep.
 */
function chooseTargets(ns, current, states) {
    const order = getTargetScores(ns)
        .map(c => ({ host: c.host, score: c.score * (current.includes(c.host) ? CONFIG.switchBonus : 1) }))
        .sort((a, b) => b.score - a.score)
        .map(c => c.host);
    const chosen = [];
    for (const host of order) {
        if (chosen.length >= CONFIG.maxTargets) break;
        chosen.push(host);
        const st = states.get(host);
        if (!st || st.mode !== "batch" || !st.interval || st.interval > 4 * CONFIG.spacer * 1.001) break;
    }
    return chosen;
}

/** Every rooted server big enough for a worker, with its free RAM and the reserve kept back; home last so its cores and spare RAM stay available for other scripts. */
function buildPool(ns, scriptRam, synced) {
    const pool = [];
    // ram-hold.txt (written by the orchestrator) = GB it is holding free for a waiting higher-priority daemon
    // While sharing is on, also leave room for the share worker to grow (see lib-share.js)
    const homeReserve = Math.max(homeReserveGb(ns), Number(ns.read("ram-hold.txt")) || 0) + shareRamToReserve(ns);
    // Port 40 (written by the orchestrator) = {host: GB} to keep free on other servers for daemons it is placing there
    let remoteReserve = {};
    try { const raw = ns.peek(40); if (raw !== "NULL PORT DATA") remoteReserve = JSON.parse(raw); } catch { remoteReserve = {}; }
    for (const host of scanAllServers(ns)) {
        if (!tryRoot(ns, host)) continue;
        // Once per run the workers are copied over whatever is there (it may be an older version); later only if one is missing
        if (host !== "home" && (!synced.has(host) || !Object.values(WORKERS).every(f => ns.fileExists(f, host)))) {
            if (ns.scp(Object.values(WORKERS), host, "home")) synced.add(host);
        }
        if (ns.getServerMaxRam(host) < RAM.hack) continue;
        pool.push({ host, free: 0, reserve: host === "home" ? homeReserve : (remoteReserve[host] || 0) });
    }
    refreshFree(ns, pool);
    return pool;
}

/** Re-reads every pool server's free RAM from the game and puts the pool back in placement order. */
function refreshFree(ns, pool) {
    for (const p of pool) p.free = Math.max(0, ns.getServerMaxRam(p.host) - ns.getServerUsedRam(p.host) - p.reserve);
    pool.sort((a, b) => (a.host === "home") - (b.host === "home") || b.free - a.free);
}

/** True when the target is at minimum security and full money. Security must be exact: even +0.05 makes
 *  every job take ~1-2% longer than planned, which is enough to land them out of order. */
function isPrepped(ns, target) {
    return atMinSecurity(ns, target)
        && ns.getServerMoneyAvailable(target) >= ns.getServerMaxMoney(target) * 0.995;
}

/**
 * Hack/grow/weaken times and steal per hack thread, as they are at minimum security.
 * With Formulas.exe they are always exact; without it they are read while the target is at
 * minimum security (e.g. right after prep) and reused while batches are landing.
 */
function targetTimes(ns, target, st) {
    if (ns.fileExists("Formulas.exe", "home")) {
        const server = mockTarget(ns, target, 1);
        const player = ns.getPlayer();
        const f = ns.formulas.hacking;
        return { weaken: f.weakenTime(server, player), grow: f.growTime(server, player), hack: f.hackTime(server, player), perThread: f.hackPercent(server, player) };
    }
    if (!st.times || atMinSecurity(ns, target)) {
        st.times = { weaken: ns.getWeakenTime(target), grow: ns.getGrowTime(target), hack: ns.getHackTime(target), perThread: ns.hackAnalyze(target) };
    }
    return st.times;
}

/** Security is exactly at its minimum, so hack/grow/weaken times read now are the ones batches were planned with. */
function atMinSecurity(ns, target) {
    return ns.getServerSecurityLevel(target) <= ns.getServerMinSecurityLevel(target) + 0.001;
}

/**
 * Picks a batching target's steal % and how often it can start a batch, for the RAM it can have:
 * what's free, what it already uses, and what's about to come back from XP jobs, minus what `others` still hold back.
 */
function planTarget(ns, target, st, pool, scriptRam, states, others, xpThreads) {
    const times = targetTimes(ns, target, st);
    if (times.perThread <= 0) { st.pct = 0; return; }
    const own = st.running.reduce((sum, j) => sum + j.threads, 0);
    const budget = Math.floor((freeThreads(pool, scriptRam) + own + xpThreads - reservedThreads(states, others)) * CONFIG.ramMargin);
    st.pct = CONFIG.autoHackPercent ? pickBestPercent(ns, target, times, budget) : CONFIG.hackPercent;
    // The shortest gap between batches that the RAM allows (null = not even one batch fits)
    const plan = planBatch(ns, target, times, st.pct);
    st.interval = planInterval(plan, budget);
    st.peak = st.interval ? peakThreads(plan, st.interval) : 0;
}

/**
 * Most threads that run at once when a batch is started every `interval` ms. A batch's jobs hold their RAM over
 * different stretches of time, so this counts exactly how many copies of each overlap at the moments jobs start.
 */
function peakThreads(plan, interval) {
    let peak = 0;
    for (const a of plan.timeline) {
        let sum = 0;
        for (const j of plan.timeline) sum += j.threads * (Math.floor((a.from - j.from) / interval) - Math.floor((a.from - j.to) / interval));
        peak = Math.max(peak, sum);
    }
    return peak;
}

/** Shortest time between batches (at least one batch every 4 spacers) whose threads fit in `budget`, or null if one batch alone doesn't. */
function planInterval(plan, budget) {
    const gap = 4 * CONFIG.spacer;
    if (peakThreads(plan, gap) <= budget) return gap;
    const span = Math.max(...plan.timeline.map(j => j.to)) - Math.min(...plan.timeline.map(j => j.from));
    let hi = span + gap; // one batch at a time
    if (peakThreads(plan, hi) > budget) return null;
    // Not strictly smoother than a staircase, so look for the first gap that fits instead of bisecting
    const step = Math.max(10, Math.ceil(span / 2000));
    for (let t = gap; t < hi; t += step) {
        if (peakThreads(plan, t) <= budget) return Math.ceil(t);
    }
    return Math.ceil(hi);
}

/**
 * Queues batches whose landings follow on from the last one, as far ahead as the next two loops will start them.
 * Nothing is launched here: every job is started later, just before it is due (see dispatch), and the worker
 * lands it at an exact time whatever the security level is when it starts.
 */
function scheduleBatches(ns, target, st, queue) {
    const times = targetTimes(ns, target, st);
    if (!st.pct || times.perThread <= 0) return "can't be hacked";
    if (!st.interval) return "waiting for RAM";
    const plan = planBatch(ns, target, times, st.pct);
    const s = CONFIG.spacer;

    // Something went wrong (e.g. lots of failed hacks or a level jump): stop adding, it re-preps once empty
    const maxMoney = ns.getServerMaxMoney(target);
    const extraSec = ns.getServerSecurityLevel(target) - ns.getServerMinSecurityLevel(target);
    if (extraSec > 2 * plan.secPerBatch + 1 || ns.getServerMoneyAvailable(target) < maxMoney * (1 - plan.stolen) * 0.5) {
        st.mode = "drift";
        return `drifted, re-prepping after ${st.inFlight.length} batches land`;
    }

    const now = Date.now();
    const horizon = now + 2 * CONFIG.loopMs;
    while (true) {
        // Landing time of this batch's first weaken (the first job to start); hack lands one spacer before it
        const land = Math.max(now + plan.lead.weaken + 100, st.lastLanding + st.interval);
        if (land - plan.lead.weaken > horizon) break;
        const jobs = [
            { action: "hack", threads: plan.hackThreads, land: land - s, lead: plan.lead.hack },
            { action: "weaken", threads: plan.weaken1, land, lead: plan.lead.weaken },
            { action: "grow", threads: plan.growThreads, land: land + s, lead: plan.lead.grow },
            { action: "weaken", threads: plan.weaken2, land: land + 2 * s, lead: plan.lead.weaken },
        ];
        for (const j of jobs) {
            if (j.threads > 0) queue.push({ target, st, action: j.action, threads: j.threads, land: j.land, start: j.land - j.lead });
        }
        st.inFlight.push({ threads: plan.total, end: land + 2 * s + 100 });
        st.lastLanding = land;
    }

    const perSec = plan.stolen * maxMoney * hackChance(ns, target) / (st.interval / 1000);
    st.perSec = perSec;   // read by the status block, which posts the total on port 24 for buy-augs.js
    const note = st.interval > 4 * s * 1.001 ? `, RAM-limited (1 per ${st.interval} ms)` : "";
    const lack = st.failed > 0 ? `, ${st.failed} jobs lacked RAM` : "";
    return `${st.inFlight.length} batches at ${(plan.stolen * 100).toFixed(1)}%, ~$${ns.format.number(perSec)}/s${note}${lack}`;
}

/**
 * Starts the queued jobs at their start times until `until`. A job is started a few ms early and its worker waits
 * off the rest, so timer lag doesn't matter. Free RAM is re-read from the game now and then, because jobs that
 * finished a moment ago have given theirs back.
 */
async function dispatch(ns, ctx, until) {
    const early = CONFIG.startEarlyMs;
    while (true) {
        const now = Date.now();
        const next = ctx.queue[0];
        if (next && next.start - early <= now) {
            ctx.queue.shift();
            startJob(ns, ctx, next, now);
            continue;
        }
        if (now >= until) return;
        const wakeAt = next ? Math.min(next.start - early, until) : until;
        await ns.sleep(Math.max(1, wakeAt - now));
    }
}

/** Places one queued job. A missed hack is just lost money; anything else that can't be placed is counted and the target is re-planned. */
function startJob(ns, ctx, job, now) {
    if (now - ctx.lastRefresh >= REFRESH_MS) { refreshFree(ns, ctx.pool); ctx.lastRefresh = now; }
    const tol = Math.floor(CONFIG.spacer / 2);
    const placed = place(ns, ctx.pool, ctx.scriptRam, job.threads, job.action, job.target, 0, false, Math.floor(job.land), tol);
    if (placed === job.threads) {
        job.st.running.push({ threads: job.threads, end: job.land + 20 });
    } else {
        job.st.failed++;
        job.st.replan = true;
    }
}

/** Hack success chance at minimum security (1 without Formulas.exe, to keep this script's RAM down). */
function hackChance(ns, target) {
    if (!ns.fileExists("Formulas.exe", "home")) return 1;
    return ns.formulas.hacking.hackChance(mockTarget(ns, target, 1), ns.getPlayer());
}

/** Thread counts for one HWGW batch that steals about `pct` of max money. */
function planBatch(ns, target, times, pct) {
    const weakenPer = ns.weakenAnalyze(1);
    const hackThreads = Math.max(1, Math.floor(pct / times.perThread));
    const stolen = Math.min(0.99, hackThreads * times.perThread);
    const growThreads = Math.ceil(growThreadsFor(ns, target, stolen) * CONFIG.growMargin);
    // Fixed game constants (security added per thread), instead of hackAnalyzeSecurity/growthAnalyzeSecurity: saves 2 GB of RAM
    const hackSec = HACK_SEC * hackThreads;
    const growSec = GROW_SEC * growThreads;
    const weaken1 = Math.ceil(hackSec / weakenPer);
    // Weaken 2 also covers the hack's security, so a hack that lands a little late can't leave security raised for good
    const weaken2 = Math.ceil((growSec + hackSec) / weakenPer);
    // A job's duration is set by security when it starts, and security is raised for part of every batch.
    // Start each job early enough for the worst case (the highest security a batch itself causes); the worker waits off any surplus.
    const scale = securityTimeScale(ns, target, Math.max(hackSec, growSec) + 0.1);
    const lead = {};
    const hold = {};
    for (const k of ["hack", "grow", "weaken"]) {
        lead[k] = times[k] * scale * HOLD_PAD;      // the job is due to start this long before it lands
        hold[k] = lead[k] + CONFIG.startEarlyMs + 20; // its RAM is held from a little before that until just after it lands
    }
    // The four jobs relative to the first weaken's landing time (0): when each holds its RAM
    const s = CONFIG.spacer;
    const timeline = [
        { threads: hackThreads, from: -s - hold.hack, to: -s + 20 },
        { threads: weaken1, from: -hold.weaken, to: 20 },
        { threads: growThreads, from: s - hold.grow, to: s + 20 },
        { threads: weaken2, from: 2 * s - hold.weaken, to: 2 * s + 20 },
    ];
    return { hackThreads, stolen, growThreads, weaken1, weaken2, lead, hold, timeline, secPerBatch: hackSec + growSec, total: hackThreads + growThreads + weaken1 + weaken2 };
}

/** How much longer hack, grow and weaken take when security is `extra` above its minimum (all three scale the same way). */
function securityTimeScale(ns, target, extra) {
    const required = ns.getServerRequiredHackingLevel(target);
    const min = ns.getServerMinSecurityLevel(target);
    return (2.5 * required * (min + extra) + 500) / (2.5 * required * min + 500);
}

/** Grow threads that refill the target after `stolen` was taken, worked out at minimum security. */
function growThreadsFor(ns, target, stolen) {
    if (ns.fileExists("Formulas.exe", "home")) {
        const server = mockTarget(ns, target, 1 - stolen);
        return ns.formulas.hacking.growThreads(server, ns.getPlayer(), server.moneyMax);
    }
    return ns.growthAnalyze(target, 1 / (1 - stolen));
}

/**
 * Tries steal sizes from 1% up to hackPercent and keeps the one that makes the most money
 * with the RAM budget when the target is fully running: small batches waste less RAM,
 * big ones matter when RAM is plentiful but the number of batches in flight is capped.
 */
function pickBestPercent(ns, target, times, threadsBudget) {
    let best = null;
    let lastHack = 0;
    for (let pct = 0.01; pct <= CONFIG.hackPercent + 1e-9; pct += 0.01) {
        const hackThreads = Math.max(1, Math.floor(pct / times.perThread));
        if (hackThreads === lastHack) continue;
        lastHack = hackThreads;

        const plan = planBatch(ns, target, times, pct);
        const interval = planInterval(plan, threadsBudget);
        if (interval === null) break; // bigger batches won't fit either
        const income = plan.stolen / interval;
        // Prefer more money; on a tie prefer the cheaper (smaller) batch
        if (!best || income > best.income * 1.001) best = { pct, income };
    }
    return best ? best.pct : 0.01;
}

/** Threads the batching targets may still need at their busiest, beyond what their jobs hold now. */
function reservedThreads(states, targets) {
    let total = 0;
    for (const t of targets) {
        const st = states.get(t);
        if (!st || st.mode !== "batch" || !st.peak) continue;
        const have = st.running.reduce((sum, j) => sum + j.threads, 0);
        total += Math.max(0, st.peak - have);
    }
    return total;
}

/** Weakens the XP target with up to `threads` spare threads. Returns how many were launched. */
function launchXpFarm(ns, pool, scriptRam, threads) {
    const target = CONFIG.xpTarget;
    if (threads <= 0) return 0;
    if (!ns.serverExists(target) || !tryRoot(ns, target)) return 0;
    if (ns.getServerRequiredHackingLevel(target) > ns.getHackingLevel()) return 0;
    return place(ns, pool, scriptRam, threads, "weaken", target, 0, true);
}

/** Weaken to minimum security and grow to max money: weaken, grow, weaken landing in that order. */
function launchPrep(ns, target, pool, scriptRam, budget) {
    const weakenPer = ns.weakenAnalyze(1);
    const sec = ns.getServerSecurityLevel(target);
    const minSec = ns.getServerMinSecurityLevel(target);
    const money = Math.max(1, ns.getServerMoneyAvailable(target));
    const maxMoney = ns.getServerMaxMoney(target);

    const weakenTime = ns.getWeakenTime(target);
    const growTime = ns.getGrowTime(target);
    const s = CONFIG.spacer;

    let launched = 0;
    const w1 = Math.min(budget, Math.ceil((sec - minSec) / weakenPer));
    launched += place(ns, pool, scriptRam, w1, "weaken", target, 0, true);

    let g = 0;
    if (money < maxMoney) {
        // Leave room for the weaken that follows the grow
        const weakenPerGrow = GROW_SEC / weakenPer;
        const room = Math.floor(Math.min(freeThreads(pool, scriptRam), budget - launched) / (1 + weakenPerGrow)) - 1;
        const wanted = Math.min(room, Math.ceil(ns.growthAnalyze(target, maxMoney / money) * CONFIG.growMargin));
        g = place(ns, pool, scriptRam, wanted, "grow", target, weakenTime + s - growTime, true);
        launched += g;
    }
    if (g > 0) {
        const w2 = Math.ceil(GROW_SEC * g / weakenPer);
        launched += place(ns, pool, scriptRam, w2, "weaken", target, 2 * s, true);
    }

    if (launched === 0) return { end: 0, threads: 0, text: "prep needs RAM" };
    return { end: Date.now() + weakenTime + 2 * s + 100, threads: launched, text: `prepping (${launched} threads)` };
}

/**
 * Places `threads` worker threads on the pool, preferring one server that fits them all,
 * otherwise splitting across servers. With action null it only reserves RAM (dry run).
 * Returns how many threads were placed; partial placement only when allowPartial is true.
 * `delay` = old-style extra wait; `land` = exact time the job must finish (ms since epoch, 0 = not used), `tol` = how late a hack/grow may be.
 */
function place(ns, pool, scriptRam, threads, action, target, delay = 0, allowPartial = false, land = 0, tol = 0) {
    if (threads <= 0) return 0;
    const ram = action ? RAM[action] : scriptRam; // RAM of the worker for this action (dry runs count the biggest)
    const total = freeThreads(pool, ram);
    if (total < threads && !allowPartial) return 0;

    let left = Math.min(threads, total);
    const whole = pool.find(p => Math.floor(p.free / ram) >= left);
    const order = whole ? [whole] : pool;
    let placed = 0;

    for (const p of order) {
        if (left === 0) break;
        const n = Math.min(left, Math.floor(p.free / ram));
        if (n <= 0) continue;
        if (action !== null) {
            const pid = ns.exec(WORKERS[action], p.host, { threads: n, temporary: true }, target, Math.max(0, Math.floor(delay)), land, tol);
            if (pid === 0) continue;
        }
        p.free -= n * ram;
        left -= n;
        placed += n;
    }
    return placed;
}

function freeThreads(pool, scriptRam) {
    return pool.reduce((sum, p) => sum + Math.floor(p.free / scriptRam), 0);
}

/** Old jobs from a previous batcher would land in the middle of new batches, so let them finish. */
async function waitForOldWorkers(ns) {
    while (true) {
        let running = 0;
        for (const host of scanAllServers(ns)) {
            running += ns.ps(host).filter(p => p.filename === OLD_WORKER || Object.values(WORKERS).includes(p.filename)).length;
        }
        if (running === 0) return;
        ns.print(`[Batcher] ${running} old worker jobs still running, checking again in 5s`);
        await ns.sleep(5000);
    }
}
