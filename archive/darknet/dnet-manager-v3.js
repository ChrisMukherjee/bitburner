// Design: docs/darknet.md
import { notify } from "/utils/notify.js";
import { candidatePasswords } from "darknet/hint-interpreter.js";
import {
	REPORT_PORT, CRAWLER_SCRIPT, PHISH_SCRIPT, STASIS_SCRIPT, CRAWLER_FILES, PASSWORD_FILE,
	STASIS_TARGET_FILE, MAP_FILE, HOME_PASSWORD_FILE, MODEL_SUMMARY_FILE,
} from "darknet/config.js";

const RESEED_INTERVAL = 10000; // ms between checks that the crawler is still alive on darkweb
const TERMINAL_INTERVAL = 5 * 60 * 1000; // ms between summaries in the terminal; the script log gets one every check
const RETRY_WINDOW = 10 * 60 * 1000; // ms of crawler skips (timeouts, moved, offline) counted in the summary

// Runs on home. Seeds a crawler onto darkweb, then collects what every crawler reports: a map of the
// darknet, the passwords found, which server models stump the hint interpreter, and earnings. Exits
// immediately if DarkscapeNavigator.exe isn't owned yet, so it never sits idle burning RAM.
// Earning (phishing / RAM freeing / cache opening) and stasis-linking the highest-RAM servers are both on
// by default. Starting it restarts every known crawler, so new code spreads and the map refills.
//   --once         do one mapping pass and stop, with no earning (recon only)
//   --recon        keep running and mapping, but don't earn
//   --no-stasis    don't apply stasis links
/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	const flags = ns.flags([["once", false], ["recon", false], ["no-stasis", false]]);
	const earn = !flags.once && !flags.recon;
	const stasis = earn && !flags["no-stasis"];

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
	const unsolved = {};
	const port = ns.getPortHandle(REPORT_PORT);
	if (!ns.fileExists(STASIS_TARGET_FILE, "home")) ns.write(STASIS_TARGET_FILE, "[]", "w");

	restartCrawlers(ns, map, passwords);
	await seed(ns, passwords, earn, stasis);
	let lastReseed = Date.now();
	let lastTerminal = Date.now();
	let stasisTargets = null; // forces a first write, replacing any stale list from an earlier run

	while (true) {
		drain(ns, port, { map, passwords, earnings, unsolved });
		forgetVanished(ns, map, unsolved);
		writeOutputs(ns, { map, passwords, earnings, unsolved });
		if (stasis) stasisTargets = manageStasis(ns, { map, passwords, earnings }, stasisTargets);

		if (flags.once && port.empty()) break;
		if (!flags.once && Date.now() - lastReseed > RESEED_INTERVAL) {
			if (!runningOn(ns, CRAWLER_SCRIPT, "darkweb")) await seed(ns, passwords, earn, stasis);
			lastReseed = Date.now();
			const toTerminal = Date.now() - lastTerminal > TERMINAL_INTERVAL;
			if (toTerminal) lastTerminal = Date.now();
			printSummary(ns, { map, passwords, earnings, unsolved }, toTerminal);
		}
		await ns.sleep(1000);
	}

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
		try { killOn(ns, [CRAWLER_SCRIPT, PHISH_SCRIPT], host); } catch { /* server has moved or gone offline */ }
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
async function seed(ns, passwords, earn, stasis) {
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
	if (ns.scp(CRAWLER_FILES.concat(PASSWORD_FILE, STASIS_TARGET_FILE), "darkweb", "home") &&
		!runningOn(ns, CRAWLER_SCRIPT, "darkweb")) {
		if (!ns.exec(CRAWLER_SCRIPT, "darkweb", 1, earn ? 1 : 0, stasis ? 1 : 0)) {
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
function manageStasis(ns, { map, passwords, earnings }, previous) {
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
	for (const host of Object.keys(map)) {
		if (passwords[host] === undefined || host === "home") continue;
		try {
			ns.dnet.connectToSession(host, passwords[host]); // scp to a darknet server needs a session
			ns.scp(STASIS_TARGET_FILE, host, "home");
		} catch { /* went offline since we last checked */ }
	}
	return targets;
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

/** Always to the script log; to the terminal too when toTerminal is set. */
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
		(earnings.stasisNote ? ` (last: ${earnings.stasisNote})` : "") + retrySummary(earnings) + ".";
	ns.print(line);
	if (toTerminal) ns.tprint(line);
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
