// Design: docs/darknet.md
import { notify } from "/utils/notify.js";
import { loadConfig } from "/utils/config.js";
import { decideStorm } from "darknet/storm-rule.js";
import { candidatePasswords } from "darknet/hint-interpreter.js";
import {
	REPORT_PORT, CRAWLER_SCRIPT, PHISH_SCRIPT, STASIS_SCRIPT, MIGRATE_SCRIPT, MIGRATE, MIGRATE_TARGET_FILE,
	CRAWLER_FILES, PASSWORD_FILE, STASIS_TARGET_FILE, MAP_FILE, HOME_PASSWORD_FILE, MODEL_SUMMARY_FILE,
	STORM, STORM_TARGET_FILE,
} from "darknet/config.js";

const RESEED_INTERVAL = 10000; // ms between checks that the crawler is still alive on darkweb
const RETRY_WINDOW = 10 * 60 * 1000; // ms of crawler skips (timeouts, moved, offline) counted in the summary

// Runs on home. Seeds a crawler onto darkweb, then collects what every crawler reports: a map of the
// darknet, the passwords found, which server models stump the hint interpreter, and earnings. Exits
// immediately if DarkscapeNavigator.exe isn't owned yet, so it never sits idle burning RAM.
// Earning (phishing / RAM freeing / cache opening) and stasis-linking the highest-RAM servers are both on
// by default. Starting it restarts every known crawler, so new code spreads and the map refills.
//   --once         do one mapping pass and stop, with no earning (recon only)
//   --recon        keep running and mapping, but don't earn
//   --no-stasis    don't apply stasis links
//   --no-migrate   don't push servers to move when mapping stalls (see manageMigration)
// A STORM_SEED.exe found on an opened server is unleashed when the darknet has run dry (see manageStorm);
// darknet.storm.enabled: false in data/config.json turns that off (the status line still says what it would do).
/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	const flags = ns.flags([["once", false], ["recon", false], ["no-stasis", false], ["no-migrate", false]]);
	const earn = !flags.once && !flags.recon;
	const stasis = earn && !flags["no-stasis"];
	const migrate = earn && !flags["no-migrate"];

	if (!ns.fileExists("DarkscapeNavigator.exe", "home")) {
		// Not sticky: startup.js only starts this once the program is owned (darknet/ready.js), so this
		// shows only when run by hand. The terminal line says why it stopped.
		const msg = "DarkscapeNavigator.exe not found on home. Buy it, then run this again.";
		notify(ns, "[darknet]", msg, "warning");
		ns.tprint(`[darknet] ${msg}`);
		return;
	}

	// Crawlers report servers only when they start, so a restarted manager reloads the last map rather than
	// starting empty (which would show 0 servers and leave stasis with no targets).
	const map = loadJson(ns, MAP_FILE);
	const passwords = loadJson(ns, HOME_PASSWORD_FILE);
	// Phishing and cache money land in the "darknet" money source; we measure income from where it started.
	const earnings = { phish: 0, caches: 0, startMoney: darknetMoney(ns), startTime: Date.now(), retries: [] };
	earnings.storm = newStormState(map, passwords);
	const unsolved = {};
	const port = ns.getPortHandle(REPORT_PORT);
	if (!ns.fileExists(STASIS_TARGET_FILE, "home")) ns.write(STASIS_TARGET_FILE, "[]", "w");
	ns.write(MIGRATE_TARGET_FILE, "[]", "w"); // pushing restarts from "map not stalled yet" on every start
	ns.write(STORM_TARGET_FILE, "{}", "w"); // no standing storm order
	const stormEnabled = loadConfig(ns).darknet?.storm?.enabled !== false;

	restartCrawlers(ns, map, passwords);
	await seed(ns, passwords, earn, stasis, migrate);
	let lastReseed = Date.now();
	let lastTerminal = Date.now();
	let lastLog = 0;
	let alertedNote = null;
	let stasisTargets = null; // forces a first write, replacing any stale list from an earlier run

	while (true) {
		drain(ns, port, { map, passwords, earnings, unsolved });
		forgetVanished(ns, map, unsolved);
		writeOutputs(ns, { map, passwords, earnings, unsolved });
		if (stasis) stasisTargets = manageStasis(ns, { map, passwords, earnings }, stasisTargets);
		if (migrate) manageMigration(ns, { map, passwords, earnings }, Date.now());
		if (earn) manageStorm(ns, { map, passwords, earnings, unsolved }, Date.now(), stormEnabled);

		if (flags.once && port.empty()) break;
		if (!flags.once && Date.now() - lastReseed > RESEED_INTERVAL) {
			if (!runningOn(ns, CRAWLER_SCRIPT, "darkweb")) await seed(ns, passwords, earn, stasis, migrate);
			lastReseed = Date.now();
			// A failed stasis link is worth a terminal line right away, once per distinct note.
			const failed = /failed$/.test(earnings.stasisNote ?? "") && earnings.stasisNote !== alertedNote;
			if (failed) alertedNote = earnings.stasisNote;
			const due = summaryDue(Date.now(), { lastLog, lastTerminal }, loadConfig(ns).darknetLog, failed);
			if (due.log) lastLog = Date.now();
			if (due.terminal) lastTerminal = Date.now();
			// @ts-expect-error unsolved is extra on purpose
			if (due.log) printSummary(ns, { map, passwords, earnings, unsolved }, due.terminal);
		}
		await ns.sleep(1000);
	}

	// @ts-expect-error unsolved is extra on purpose
	printSummary(ns, { map, passwords, earnings, unsolved }, true);
	ns.tprint(`INFO darknet: recon pass done, ${Object.keys(map).length} servers mapped. See ${MAP_FILE}.`);
}

/**
 * Stop every crawler and phishing worker we know of, so the fresh crawler seeded on darkweb respreads with the
 * current code and every server reports in again (crawlers only report at startup). Old workers would hold
 * the RAM a new, larger crawler needs; each crawler relaunches its worker sized to what's left. kill needs no
 * session or direct connection, so home can reach any darknet server by name.
 */
function restartCrawlers(ns, map, passwords) {
	const hosts = new Set([...Object.keys(map), ...Object.keys(passwords)]);
	for (const host of hosts) {
		if (host === "home") continue;
		try { killOn(ns, [CRAWLER_SCRIPT, PHISH_SCRIPT, MIGRATE_SCRIPT], host); } catch { /* server has moved or gone offline */ }
	}
}

// ps (0.2GB) + kill by pid (0.5GB) instead of scriptRunning and scriptKill (1GB each).
function runningOn(ns, script, host) {
	return ns.ps(host).some((proc) => proc.filename === script);
}

function killOn(ns, scripts, host) {
	for (const proc of ns.ps(host)) if (scripts.includes(proc.filename)) ns.kill(proc.pid);
}

/** Open darkweb (a direct neighbour of home) and launch a crawler on it. */
async function seed(ns, passwords, earn, stasis, migrate) {
	const details = ns.dnet.getServerDetails("darkweb");
	if (details.isOnline === false) return;

	let password = passwords["darkweb"];
	if (password === undefined) {
		for (const candidate of candidatePasswords(details).candidates) {
			if ((await ns.dnet.authenticate("darkweb", candidate)).success) { password = candidate; break; }
		}
	} else {
		await ns.dnet.authenticate("darkweb", password);
	}
	if (password === undefined) {
		notify(ns, "[darknet]", `couldn't open darkweb from its hint. Add its password to ${HOME_PASSWORD_FILE}, then re-run.`, "warning", true);
		return;
	}
	passwords["darkweb"] = password;

	ns.write(PASSWORD_FILE, JSON.stringify(passwords), "w");
	// Free darkweb's blocked RAM here, as crawlers do for the neighbours they open, so its worker has more.
	if (earn && ns.dnet.getBlockedRam("darkweb") > 0) await ns.dnet.memoryReallocation("darkweb");
	if (ns.scp(CRAWLER_FILES.concat(PASSWORD_FILE, STASIS_TARGET_FILE, MIGRATE_TARGET_FILE, STORM_TARGET_FILE), "darkweb", "home") &&
		!runningOn(ns, CRAWLER_SCRIPT, "darkweb")) {
		if (!ns.exec(CRAWLER_SCRIPT, "darkweb", 1, earn ? 1 : 0, stasis ? 1 : 0, migrate ? 1 : 0)) {
			const free = ns.getServerMaxRam("darkweb") - ns.getServerUsedRam("darkweb");
			ns.print(`WARN darknet: couldn't start the crawler on darkweb: it needs ` +
				`${ns.getScriptRam(CRAWLER_SCRIPT, "home")} GB, darkweb has ${free.toFixed(1)} GB free.`);
		}
	}
}

/**
 * Decide which opened servers should hold stasis links: the highest-RAM ones, up to the global cap.
 * When that set changes, write it to the target file and push a fresh copy to every opened server, so each
 * crawler links or unlinks its own server to match. Returns the current target list.
 */
export function manageStasis(ns, { map, passwords, earnings }, previous) {
	const limit = ns.dnet.getStasisLinkLimit();
	const linked = ns.dnet.getStasisLinkedServers();
	// The crawler on a target hands its RAM to the one-shot, so a target needs room for whichever is bigger.
	// Rank by usable RAM (max minus what the owner still blocks, which can be most of a big server), and give
	// linked servers a 1.5x edge so a slightly bigger find doesn't trigger a 20s unlink/relink. Stationary
	// servers (darkweb) never move anyway, so a link there would waste the slot.
	const need = Math.max(ns.getScriptRam(CRAWLER_SCRIPT, "home"), ns.getScriptRam(STASIS_SCRIPT, "home"));
	const usable = (host) => (map[host].maxRam || 0) - ns.dnet.getBlockedRam(host);
	const score = (host) => usable(host) * (linked.includes(host) ? 1.5 : 1);
	const targets = Object.keys(map)
		.filter((host) => passwords[host] !== undefined && host !== "home" && !map[host].isStationary)
		// Mid-link the crawler has handed its RAM to stasis.js, so count that (and an existing link) as live too;
		// otherwise the target flips to another server for ~20s and the two links race for the one slot.
		.filter((host) => (runningOn(ns, CRAWLER_SCRIPT, host) || runningOn(ns, STASIS_SCRIPT, host) ||
			linked.includes(host)) && usable(host) >= need)
		.sort((a, b) => score(b) - score(a))
		.slice(0, limit);
	if (!targets.length && !linked.length) {
		const best = Math.max(0, ...Object.keys(map).filter((host) => passwords[host] !== undefined).map(usable));
		earnings.stasisNote = `no server has ${need.toFixed(1)} GB usable yet, best ${best.toFixed(1)} GB`;
	}

	if (previous && targets.join(",") === previous.join(",")) return targets;

	ns.write(STASIS_TARGET_FILE, JSON.stringify(targets), "w");
	pushToOpened(ns, STASIS_TARGET_FILE, map, passwords);
	return targets;
}

/** Copy a target file to every opened server, so each crawler reads the current list. */
function pushToOpened(ns, file, map, passwords) {
	for (const host of Object.keys(map)) {
		if (passwords[host] === undefined || host === "home") continue;
		try {
			ns.dnet.connectToSession(host, passwords[host]); // scp to a darknet server needs a session
			ns.scp(file, host, "home");
		} catch { /* went offline since we last checked */ }
	}
}

/**
 * Some parts of the darknet are cut off from the rest ("air gaps"); a server that moves carries its crawler across.
 * When no new server has been mapped for MIGRATE.stallMs, pick up to MIGRATE.maxTargets opened servers to push:
 * the ones we have a crawler on, not stasis-linked (those are pinned on purpose), not stationary, not pushed lately
 * and not given up on. The list goes to every opened server; the crawlers next to a target run the migrate worker
 * on it, and the pushes stack. Any new server clears the list and restarts the stall timer. A push that moved
 * its target resets that server's failure count; MIGRATE.giveUpAfter pushes in a row that moved nothing park it
 * until the map grows. State lives in earnings.migrate. Returns the current target list.
 */
export function manageMigration(ns, { map, passwords, earnings }, now) {
	const state = earnings.migrate ??= { size: Object.keys(map).length, lastGrowth: now, targets: [], tried: {}, moved: 0, empty: 0 };
	const size = Object.keys(map).length;
	if (size > state.size) {
		state.lastGrowth = now;
		state.tried = {};
	}
	state.size = size;

	let targets = [];
	if (now - state.lastGrowth >= MIGRATE.stallMs) {
		const linked = ns.dnet.getStasisLinkedServers();
		targets = Object.keys(map)
			.filter((host) => passwords[host] !== undefined && host !== "home" && !map[host].isStationary && !linked.includes(host))
			.filter((host) => runningOn(ns, CRAWLER_SCRIPT, host))
			.filter((host) => {
				const tried = state.tried[host];
				return !tried || (tried.fails < MIGRATE.giveUpAfter && now - tried.last >= MIGRATE.cooldownMs);
			})
			.sort((a, b) => (state.tried[a]?.last ?? 0) - (state.tried[b]?.last ?? 0))
			.slice(0, MIGRATE.maxTargets);
	}
	if (targets.join(",") !== state.targets.join(",")) {
		state.targets = targets;
		ns.write(MIGRATE_TARGET_FILE, JSON.stringify(targets), "w");
		pushToOpened(ns, MIGRATE_TARGET_FILE, map, passwords);
	}
	return targets;
}

/**
 * Watch for STORM_SEED.exe and decide when to unleash it (storm-rule.js has the rule). Keeps an income history
 * (a sample every STORM.sampleMs) and a log of discoveries (a new server or password) in earnings.storm. When the
 * rule says yes, the order {host, at} goes to every opened server and the crawler on the seed's host runs it.
 * With `enabled` false the rule is still evaluated, so the status line shows what it would do. Returns the decision.
 */
export function manageStorm(ns, { map, passwords, earnings, unsolved }, now, enabled = true) {
	const state = earnings.storm ??= newStormState(map, passwords);
	state.enabled = enabled;
	const servers = Object.keys(map).length, known = Object.keys(passwords).length;
	for (let i = state.servers; i < servers; i++) state.discoveries.push(now);
	for (let i = state.known; i < known; i++) state.discoveries.push(now);
	state.servers = servers;
	state.known = known;
	if (state.discoveries.length > 200) state.discoveries.splice(0, state.discoveries.length - 200);
	if (state.seedHost && !map[state.seedHost]) state.seedHost = null; // that server is gone, and the file with it

	// Live RAM picture of the opened servers: what is still blocked, what is usable, and what a storm could delete
	// (servers that are neither stasis-linked nor stationary).
	const opened = Object.keys(map).filter((host) => passwords[host] !== undefined && host !== "home");
	const linked = ns.dnet.getStasisLinkedServers();
	let ram = 0, blocked = 0, atRiskRam = 0;
	for (const host of opened) {
		const max = map[host].maxRam || 0;
		ram += max;
		if (!linked.includes(host) && !map[host].isStationary) atRiskRam += max;
		try { blocked += Math.min(max, ns.dnet.getBlockedRam(host)); } catch { /* went offline */ }
	}

	if (now - state.lastSample >= STORM.sampleMs) {
		state.lastSample = now;
		state.samples.push({ t: now, money: darknetMoney(ns), blocked, usable: ram - blocked });
		const oldest = now - STORM.historyMs - STORM.rateWindowMs;
		while (state.samples.length > 2 && state.samples[0].t < oldest) state.samples.shift();
	}

	state.decision = decideStorm({
		now, startedAt: earnings.startTime, lastStorm: state.lastStorm, seedHost: state.seedHost,
		samples: state.samples, discoveries: state.discoveries,
		pending: Object.keys(map).filter((host) => passwords[host] === undefined && !unsolved[host]).length,
		blockedGb: blocked, atRiskShare: ram ? atRiskRam / ram : 1,
	});
	if (!state.decision.fire || !enabled) return state.decision;

	state.lastStorm = now;
	state.fired++;
	ns.write(STORM_TARGET_FILE, JSON.stringify({ host: state.seedHost, at: now }), "w");
	pushToOpened(ns, STORM_TARGET_FILE, map, passwords);
	notify(ns, "[darknet]", `unleashing STORM_SEED.exe on ${state.seedHost}: ${state.decision.reason}`, "info");
	state.seedHost = null;
	return state.decision;
}

/** ", storm seed on host (waiting: reason)" while a seed is known, ", N storms" after any; empty before both. */
function stormSummary(earnings) {
	const state = earnings.storm;
	if (!state) return "";
	const parts = [];
	if (state.seedHost) parts.push(`storm seed on ${state.seedHost} (${state.decision?.fire ? (state.enabled ? "firing" : "off: would fire") : `waiting: ${state.decision?.reason}`})`);
	if (state.fired) parts.push(`${state.fired} storm${state.fired > 1 ? "s" : ""} fired`);
	return parts.length ? `, ${parts.join(", ")}` : "";
}

/** Fold a worker's report into the push history. A moved server is credited; one that did not move counts a fail. */
export function noteMigration(earnings, message) {
	const state = earnings.migrate;
	if (!state) return;
	const tried = state.tried[message.host] ??= { fails: 0, last: 0 };
	tried.last = message.at;
	if (message.moved) { tried.fails = 0; state.moved++; } else { tried.fails++; state.empty++; }
}

/** The manager's storm bookkeeping. The servers and passwords already known at the start are not discoveries. */
export function newStormState(map, passwords) {
	return {
		samples: [], discoveries: [], seedHost: null, lastStorm: 0, lastSample: 0, fired: 0, enabled: true,
		servers: Object.keys(map).length, known: Object.keys(passwords).length, decision: null,
	};
}

/** A crawler found STORM_SEED.exe on its server, or saw it leave. */
export function noteSeed(earnings, message) {
	const state = earnings.storm;
	if (!state) return;
	if (message.present) state.seedHost = message.host;
	else if (state.seedHost === message.host) state.seedHost = null;
}

/** Darknet servers can vanish; drop any that no longer exist so counts and stasis targets stay real. */
function forgetVanished(ns, map, unsolved) {
	for (const host of Object.keys(map)) {
		if (ns.serverExists(host)) continue;
		delete map[host];
		delete unsolved[host];
	}
}

/** Read every pending crawler report and fold it into our running state. */
function drain(ns, port, state) {
	while (!port.empty()) {
		let message;
		try { message = JSON.parse(port.read()); } catch { continue; }
		if (message.kind === "server") state.map[message.host] = { ...message.details, maxRam: message.maxRam };
		else if (message.kind === "password") {
			state.passwords[message.host] = message.password;
			delete state.unsolved[message.host]; // another crawler may have solved it after one gave up
		}
		else if (message.kind === "unsolved") state.unsolved[message.host] = message;
		else if (message.kind === "retry") state.earnings.retries.push({ at: message.at, code: message.code, host: message.host });
		else if (message.kind === "phish" && message.success) state.earnings.phish++;
		else if (message.kind === "cache" && message.success) state.earnings.caches++;
		else if (message.kind === "stasis" || message.kind === "unlink") {
			state.earnings.stasisNote = `${message.kind} ${message.host} ${message.success ? "ok" : "failed"}`;
		}
		else if (message.kind === "migrate") noteMigration(state.earnings, message);
		else if (message.kind === "storm-seed") noteSeed(state.earnings, message);
		else if (message.kind === "stasis-start") state.earnings.stasisNote = `${message.mode}ing ${message.host} (~20s)`;
		else if (message.kind === "stasis-skip") {
			state.earnings.stasisNote = `${message.host} too small to ${message.mode} (${message.free.toFixed(1)}/${message.need.toFixed(1)} GB free)`;
		}
	}
}

function writeOutputs(ns, { map, passwords, earnings, unsolved }) {
	ns.write(MAP_FILE, JSON.stringify(map, null, 2), "w");
	ns.write(HOME_PASSWORD_FILE, JSON.stringify(passwords, null, 2), "w");
	ns.write(PASSWORD_FILE, JSON.stringify(passwords), "w");

	// One line per server model, with a sample hint, so we can add a solver for any model that stumps us.
	const models = {};
	for (const [host, details] of Object.entries(map)) {
		const key = details.modelId || "unknown";
		if (!models[key]) models[key] = { count: 0, format: details.passwordFormat, sampleHint: details.passwordHint, opened: 0 };
		models[key].count++;
		if (passwords[host] !== undefined) models[key].opened++;
	}
	const lines = Object.entries(models).map(([model, info]) =>
		`${model}: ${info.opened}/${info.count} opened, format ${info.format}, e.g. "${info.sampleHint}"`);
	// Only servers still without a password. One crawler can report a host unsolved after another has
	// opened it (each carries its own copy of the password file), so passwords is the source of truth.
	// Every mapped server without a password counts, so the list survives a manager restart; attempts are only
	// known for ones a crawler reported this run.
	const stillUnsolved = Object.keys(map).filter((host) => passwords[host] === undefined);
	if (stillUnsolved.length) {
		lines.push("", `Unsolved (${stillUnsolved.length}):`);
		for (const host of stillUnsolved) {
			const info = unsolved[host] ?? { model: map[host].modelId, hint: map[host].passwordHint, data: map[host].data };
			lines.push(`  ${host} (${info.model}): "${info.hint}"` + (info.data ? `, data "${info.data}"` : ""));
			if (!info.attempts?.length) lines.push("    nothing tried (no candidates fit the length/format)");
			// "tried", not "attempt": the RAM check would charge that name as codingcontract.attempt (10GB).
			for (const tried of info.attempts ?? []) {
				const extra = tried.data === undefined ? "" : `, data ${JSON.stringify(tried.data)}`;
				lines.push(`    tried "${tried.password}": ${tried.code} ${tried.message}${extra}`);
			}
		}
	}
	ns.write(MODEL_SUMMARY_FILE, lines.join("\n"), "w");
}

/**
 * Which summary outputs are due. The script log gets the full line every `logMinutes`, the terminal a short one
 * every `terminalMinutes` (0 turns the periodic line off); `urgent` (e.g. a failed stasis link) forces both now.
 * @param {number} now
 * @param {{ lastLog: number, lastTerminal: number }} last  ms timestamps of the previous outputs
 * @param {{ logMinutes?: number, terminalMinutes?: number }} [settings]
 * @param {boolean} [urgent]
 */
export function summaryDue(now, last, settings = {}, urgent = false) {
	const logMs = (settings.logMinutes ?? 5) * 60000;
	const terminalMs = (settings.terminalMinutes ?? 30) * 60000;
	const terminal = urgent || (terminalMs > 0 && now - last.lastTerminal >= terminalMs);
	const log = terminal || now - last.lastLog >= logMs;
	return { log, terminal };
}

/** Full line to the script log; a short one (no retry/migration detail) to the terminal when toTerminal is set. */
function printSummary(ns, { map, passwords, earnings }, toTerminal = false) {
	// Unsolved is every mapped server without a password. Phishing money isn't script income, so income comes
	// from the darknet money source: earned since this manager started, and that averaged per second.
	// Stasis shows linked / global cap.
	const total = Object.keys(map).length;
	const stillUnsolved = Object.keys(map).filter((host) => passwords[host] === undefined).length;
	const linked = ns.dnet.getStasisLinkedServers().length;
	const earned = darknetMoney(ns) - earnings.startMoney;
	const perSecond = earned / Math.max(1, (Date.now() - earnings.startTime) / 1000);
	const line = `INFO darknet: ${total} servers, ${stillUnsolved} unsolved, ` +
		`${earnings.phish} phishes, ${earnings.caches} caches, ` +
		`$${ns.format.number(earned)} earned ($${ns.format.number(perSecond)}/s), ` +
		`${linked}/${ns.dnet.getStasisLinkLimit()} stasis-linked` +
		(earnings.stasisNote ? ` (last: ${earnings.stasisNote})` : "") + migrateSummary(earnings) + stormSummary(earnings) + retrySummary(earnings) + ".";
	ns.print(line);
	if (toTerminal) {
		ns.tprint(`INFO darknet: ${total} servers, ${stillUnsolved} unsolved, $${ns.format.number(earned)} earned ` +
			`($${ns.format.number(perSecond)}/s), ${linked}/${ns.dnet.getStasisLinkLimit()} stasis-linked` +
			(earnings.stasisNote?.endsWith("failed") ? ` (last: ${earnings.stasisNote})` : "") + ".");
	}
}

/** ", pushing 2 servers (3 moved, 1 stayed)" while migrations are being induced, ", 3 moved" after; empty before any. */
function migrateSummary(earnings) {
	const state = earnings.migrate;
	if (!state || (!state.targets.length && !state.moved && !state.empty)) return "";
	const pushing = state.targets.length ? `pushing ${state.targets.length} (${state.targets.join(", ")}), ` : "";
	return `, migrations: ${pushing}${state.moved} moved, ${state.empty} stayed`;
}

/**
 * Logins the crawlers skipped in the last 10 minutes because the server didn't answer "wrong password"
 * (408 timeout, 351 moved away, 503 offline, 451 charisma), grouped by code, e.g. ", retrying (10m): 3 (408 x2, 351 x1)".
 * Each one is retried on that crawler's next re-check. Empty when there were none.
 */
function retrySummary(earnings) {
	const cutoff = Date.now() - RETRY_WINDOW;
	earnings.retries = earnings.retries.filter((skip) => skip.at >= cutoff);
	if (!earnings.retries.length) return "";
	const byCode = {};
	for (const skip of earnings.retries) byCode[skip.code] = (byCode[skip.code] ?? 0) + 1;
	const parts = Object.entries(byCode).sort((a, b) => b[1] - a[1]).map(([code, count]) => `${code} x${count}`);
	return `, retrying (10m): ${earnings.retries.length} (${parts.join(", ")})`;
}

/** Money from phishing and caches since the last augmentation install. */
function darknetMoney(ns) {
	return ns.getMoneySources().sinceInstall.darknet ?? 0;
}

function loadJson(ns, file) {
	const text = ns.read(file);
	return text.length > 1 ? JSON.parse(text) : {};
}
