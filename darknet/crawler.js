// Design: docs/darknet.md
import { candidatePasswords, fitsDetails } from "darknet/hint-interpreter.js";
import { FACTORIOS_MODEL, DEEPGREEN_MODEL, OVERFLOW_MODEL, PACKET_SNIFFER_MODEL, solveDivisibility, solveMastermind, solveOverflow, solvePacketSniffer } from "darknet/feedback-solvers.js";
import { readLogs } from "darknet/heartbleed.js";
import { login } from "darknet/auth.js";
import {
	REPORT_PORT, CRAWLER_SCRIPT, PHISH_SCRIPT, STASIS_SCRIPT, MIGRATE_SCRIPT, MIGRATE, MIGRATE_TARGET_FILE,
	CRAWLER_FILES, PASSWORD_FILE, STASIS_TARGET_FILE, STORM_PROGRAM, STORM_TARGET_FILE,
} from "darknet/config.js";

const MAX_REUSED_PASSWORDS = 10; // other servers' passwords tried on a server whose hint gave nothing
const STORM_ORDER_MS = 2 * 60 * 1000; // a storm order older than this is stale (an old order must not fire a later seed)
const RESPREAD_INTERVAL = 60 * 1000; // ms between re-checks of our neighbours for new servers

// Runs on a darknet server the manager (or another crawler) authenticated and exec'd us onto.
// Reports every neighbour it sees to the manager, works out each one's password from its in-game hint,
// copies itself onto the ones it opens, and (when earning is on) phishes, frees blocked RAM and opens caches.
/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	const earn = ns.args[0] === 1;
	const stasis = ns.args[1] === 1;
	const migrate = ns.args[2] === 1;
	const self = ns.getHostname();
	const port = ns.getPortHandle(REPORT_PORT);

	const passwords = loadPasswords(ns);
	// opened: neighbours we hold a session on, whose blocked RAM we keep freeing. failed: neighbours whose
	// hint we couldn't solve, not retried until the next restart.
	const crawl = { self, port, earn, stasis, migrate, passwords, opened: [], failed: new Set(), pushed: new Map(), seedSeen: false, stormAt: 0 };
	report(ns, port, { kind: "server", host: self, details: safeDetails(ns, self), maxRam: ns.getServerMaxRam(self) });

	await spread(ns, crawl);

	if (earn) await earnOn(ns, crawl);
}

/**
 * Open every darknet neighbour we can and start a crawler on it. Runs at startup and again every minute
 * while earning, because the darknet keeps moving servers: new ones drift next to us, and a neighbour whose
 * crawler died (it went offline, or moved and came back) gets a fresh one.
 */
async function spread(ns, { self, port, earn, stasis, migrate, passwords, opened, failed }) {
	for (const neighbour of ns.dnet.probe()) {
		if (neighbour === "home" || failed.has(neighbour)) continue;
		const details = safeDetails(ns, neighbour);
		if (!details) continue;
		report(ns, port, { kind: "server", host: neighbour, details, maxRam: ns.getServerMaxRam(neighbour) });

		// scp and exec to a darknet server both need this PID to hold a session. If we already hold one, skip
		// the login; otherwise authenticate even with a known password (it may be stale after a mutation).
		// Only a 401 means a password is wrong. A timeout, a server that just moved away or went offline, or too
		// little charisma says nothing about the guess, so we skip the server this round and retry next re-check.
		const known = passwords[neighbour];
		let password = details.hasSession && known !== undefined ? known : undefined;
		if (password === undefined && known !== undefined) {
			const result = await login(ns, neighbour, known);
			if (result.verdict === "ok") password = known;
			else if (result.verdict === "later") { retryLater(ns, port, neighbour, result); continue; }
		}
		let attempts = [];
		if (password === undefined) {
			const cracked = await crack(ns, neighbour, details, passwords);
			if (cracked.later) { retryLater(ns, port, neighbour, cracked.later); continue; }
			({ password, attempts } = cracked);
		}
		if (password === undefined) {
			report(ns, port, {
				kind: "unsolved", host: neighbour, model: details.modelId,
				hint: details.passwordHint, data: details.data, attempts,
			});
			failed.add(neighbour);
			continue;
		}
		if (password !== known) {
			passwords[neighbour] = password;
			savePasswords(ns, passwords);
			report(ns, port, { kind: "password", host: neighbour, password });
		}
		if (!opened.includes(neighbour)) {
			opened.push(neighbour);
			// We hold a session and a direct connection, so start freeing the owner's blocked RAM here (the
			// server can't do it to itself); freeNeighbours keeps going from the earn loop.
			if (earn && ns.dnet.getBlockedRam(neighbour) > 0) await ns.dnet.memoryReallocation(neighbour);
		}

		// Copy fresh files every time, so a restarted crawler always runs the current code. preventDuplicates
		// makes exec a no-op when a crawler already runs there, so the crawler no longer needs its own 1 GB running-check.
		if (!ns.scp(CRAWLER_FILES.concat(PASSWORD_FILE, STASIS_TARGET_FILE, MIGRATE_TARGET_FILE, STORM_TARGET_FILE), neighbour, self)) continue;
		const launch = () => ns.exec(CRAWLER_SCRIPT, neighbour, { threads: 1, preventDuplicates: true },
			earn ? 1 : 0, stasis ? 1 : 0, migrate ? 1 : 0);
		if (launch()) continue;
		// exec also fails when the crawler doesn't fit. Then a phishing worker left from an earlier crawler is
		// holding the RAM; stop it (the new crawler restarts it) and try again.
		const free = ns.getServerMaxRam(neighbour) - ns.getServerUsedRam(neighbour);
		if (free < ns.getScriptRam(CRAWLER_SCRIPT, self)) {
			stopScript(ns, PHISH_SCRIPT, neighbour);
			launch();
		}
	}
}

/**
 * Tries each hint-derived candidate against the game until one authenticates. Returns { password, attempts },
 * password undefined if none worked; attempts records each try and the server's reply, for the report.
 * Returns { later: result } instead when the server answered something other than "wrong password" (see
 * auth.js), so a timeout or a server drifting away mid-crack doesn't get it marked unsolvable.
 */
async function crack(ns, host, details, passwords) {
	// The server's logs first: another login's success, passcodes a model leaks, passwords already known to be wrong,
	// and Mastermind replies that narrow DeepGreen. Costs one cheap call per neighbour.
	const logs = await readLogs(ns, host);
	const attempts = [];
	const tryFirst = [...logs.winners, ...logs.leaked].filter((candidate) => fitsDetails(candidate, details));
	for (const candidate of new Set(tryFirst)) {
		const result = await login(ns, host, candidate);
		if (result.verdict === "ok") return { password: candidate, attempts };
		if (result.verdict === "later") return { later: result };
		attempts.push({ password: candidate, code: result.code, message: result.message, data: result.data });
		logs.wrong.add(candidate);
	}
	if (details.modelId === OVERFLOW_MODEL) return await solveOverflow(ns, host, details);
	if (details.modelId === FACTORIOS_MODEL) return await solveDivisibility(ns, host, details);
	if (details.modelId === DEEPGREEN_MODEL) return await solveMastermind(ns, host, details, logs.observed, logs.clues);
	if (details.modelId === PACKET_SNIFFER_MODEL) return await solvePacketSniffer(ns, host, details);
	const { candidates } = candidatePasswords(details);
	// Last resort, after the hint's own candidates: passwords that opened other servers (people reuse them), capped.
	const found = [...new Set(Object.values(passwords))].filter((candidate) => fitsDetails(candidate, details) && !candidates.includes(candidate));
	for (const candidate of candidates.concat(found.slice(0, MAX_REUSED_PASSWORDS)).filter((candidate) => !logs.wrong.has(candidate))) {
		const result = await login(ns, host, candidate);
		if (result.verdict === "ok") return { password: candidate, attempts };
		if (result.verdict === "later") return { later: result };
		attempts.push({ password: candidate, code: result.code, message: result.message, data: result.data });
	}
	return { password: undefined, attempts };
}

/**
 * Note why a neighbour was skipped this round (the next re-check tries it again): in this crawler's log, and to
 * the manager, which counts skips by code in its summary line.
 */
function retryLater(ns, port, host, result) {
	ns.print(`${host}: ${result.code} ${result.message}, retrying on the next re-check`);
	report(ns, port, { kind: "retry", host, code: result.code, message: result.message });
}

/**
 * Earn on this server: phish with as many threads as its free RAM allows (phishing income scales with
 * threads), open any .cache files phishing drops, and, when stasis is on, keep this server's link state in
 * step with the manager's target list. Our parent already freed this server's blocked RAM before starting us.
 */
async function earnOn(ns, crawl) {
	const { self, port, stasis, migrate } = crawl;
	const { opened } = crawl;
	launchPhish(ns, self);
	let lastSpread = Date.now();
	while (true) {
		if (Date.now() - lastSpread > RESPREAD_INTERVAL) {
			await spread(ns, crawl);
			lastSpread = Date.now();
		}
		await freeNeighbours(ns, opened);
		launchPhish(ns, self); // our own RAM may have been freed by our parent
		if (stasis) await syncStasis(ns, self, port);
		if (migrate) syncMigrate(ns, crawl);
		syncStorm(ns, crawl);
		for (const file of ns.ls(self, ".cache")) {
			const cache = ns.dnet.openCache(file, true);
			report(ns, port, { kind: "cache", host: self, file, success: cache.success });
		}
		await ns.sleep(5000);
	}
}

/** Start the phishing worker here with every spare thread, if it isn't already running. */
function launchPhish(ns, self) {
	const free = ns.getServerMaxRam(self) - ns.getServerUsedRam(self);
	const threads = Math.floor(free / ns.getScriptRam(PHISH_SCRIPT, self));
	// A unique arg lets a second worker use RAM freed after the first started.
	if (threads > 0) ns.exec(PHISH_SCRIPT, self, threads, Date.now());
}

/**
 * Each memoryReallocation frees only a fraction of a GB, while big servers start with most of their RAM
 * blocked. So keep chipping away at every neighbour we opened, one call each per pass, until it's all free.
 * Clearing a server fully also drops a cache there.
 */
async function freeNeighbours(ns, opened) {
	for (const host of opened) {
		try {
			if (ns.dnet.getBlockedRam(host) > 0) await ns.dnet.memoryReallocation(host);
		} catch { /* moved out of reach or went offline */ }
	}
}

/**
 * Link or unlink this server to match the manager's target list. The one-shot needs ~13.7 GB, more than most
 * servers have spare beside us, so we stop the phishing worker and hand our own RAM over with spawn: this
 * crawler ends and stasis.js starts in its place. When it finishes, our parent's next neighbour re-check (or
 * the manager, on darkweb) starts a fresh crawler here, which relaunches phishing.
 */
export async function syncStasis(ns, self, port) {
	const targets = readTargets(ns);
	const linked = ns.dnet.getStasisLinkedServers().includes(self);
	const wanted = targets.includes(self);
	let mode;
	if (wanted && !linked && ns.dnet.getStasisLinkedServers().length < ns.dnet.getStasisLinkLimit()) mode = "link";
	else if (linked && !wanted) mode = "unlink";
	else return;

	stopScript(ns, PHISH_SCRIPT, self);
	const free = ns.getServerMaxRam(self) - ns.getServerUsedRam(self) + ns.getScriptRam(CRAWLER_SCRIPT, self);
	const need = ns.getScriptRam(STASIS_SCRIPT, self);
	if (free >= need) {
		report(ns, port, { kind: "stasis-start", host: self, mode });
		ns.spawn(STASIS_SCRIPT, { threads: 1, spawnDelay: 100 }, mode);
		return; // not reached: spawn ends this script
	}
	report(ns, port, { kind: "stasis-skip", host: self, mode, free, need });
	launchPhish(ns, self);
}

/**
 * Push a neighbour the manager wants moved. Every crawler next to the target does this, and the pushes stack. The
 * worker takes all the free RAM (phishing is stopped for the push and comes back when it ends), one target at a
 * time. A target is not pushed again for a while, so a worker that gave up isn't restarted before the manager has
 * heard from it.
 * @param {NS} ns
 */
export function syncMigrate(ns, { self, pushed }) {
	const targets = readList(ns, MIGRATE_TARGET_FILE);
	if (!targets.length || ns.ps(self).some((proc) => proc.filename === MIGRATE_SCRIPT)) return;
	const neighbours = ns.dnet.probe();
	const now = Date.now();
	const target = targets.find((host) => neighbours.includes(host) && now - (pushed.get(host) ?? 0) > MIGRATE.retryMs);
	if (target === undefined) return;
	pushed.set(target, now);
	stopScript(ns, PHISH_SCRIPT, self);
	const threads = Math.floor((ns.getServerMaxRam(self) - ns.getServerUsedRam(self)) / ns.getScriptRam(MIGRATE_SCRIPT, self));
	if (threads > 0) ns.exec(MIGRATE_SCRIPT, self, threads, target);
	else launchPhish(ns, self); // too little room for a push: keep phishing
}

/**
 * STORM_SEED.exe sits on one darknet server at a time (the game drops it when a server's blocked RAM is freed).
 * Report it to the manager when it appears here or goes, and unleash it when the manager's order names this server
 * (the order carries a timestamp, so each order is acted on once). The manager decides when; see storm-rule.js.
 * @param {NS} ns
 */
export function syncStorm(ns, crawl) {
	const present = ns.fileExists(STORM_PROGRAM);
	if (present !== crawl.seedSeen) {
		crawl.seedSeen = present;
		report(ns, crawl.port, { kind: "storm-seed", host: crawl.self, present });
	}
	if (!present) return;
	const order = readList(ns, STORM_TARGET_FILE);
	if (order.host !== crawl.self || !order.at || order.at <= crawl.stormAt || Date.now() - order.at > STORM_ORDER_MS) return;
	crawl.stormAt = order.at;
	report(ns, crawl.port, { kind: "storm", host: crawl.self });
	ns.dnet.unleashStormSeed();
}

function readList(ns, file) {
	const text = ns.read(file);
	try { return text.length > 1 ? JSON.parse(text) : []; } catch { return []; }
}

function readTargets(ns) {
	const text = ns.read(STASIS_TARGET_FILE);
	try { return text.length > 1 ? JSON.parse(text) : []; } catch { return []; }
}

/** getServerDetails but tolerant of a server that just went offline; flattens to the fields we report. */
function safeDetails(ns, host) {
	try {
		const details = ns.dnet.getServerDetails(host);
		if (details.isOnline === false) return null;
		return details;
	} catch {
		return null;
	}
}

function report(ns, port, message) {
	port.tryWrite(JSON.stringify({ ...message, at: Date.now() }));
}

function loadPasswords(ns) {
	const text = ns.read(PASSWORD_FILE);
	return text.length > 1 ? JSON.parse(text) : {};
}

function savePasswords(ns, passwords) {
	ns.write(PASSWORD_FILE, JSON.stringify(passwords), "w");
}

/** Stops every copy of a script on a server. ps + kill by pid cost 0.7GB together; scriptKill alone costs 1GB. */
function stopScript(ns, script, host) {
	for (const proc of ns.ps(host)) if (proc.filename === script) ns.kill(proc.pid);
}
