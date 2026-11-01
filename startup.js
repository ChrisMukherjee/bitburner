import { getAllServers } from "/utils/get-all-servers.js";
import { nukeAllServers } from "/utils/nuke-all.js";

// Every long-running script, in priority order: earlier entries get RAM first.
// A stage starts everything tagged with that stage or an earlier one.
//   restartOnNewArgs: if a copy with different args is running (anywhere), kill it first
//                     (otherwise two go bots would fight over the same board).
//   homeOnly:         reads or writes data files on its own server, so it must run on home.
//   skip:             (ns) => true leaves it out this time.
// Everything else may run on a rooted server when home is too small (see main below).
const SCRIPTS = [
	{ stage: "early", script: "singularity/upgrade-home-ram.js" },
	{ stage: "early", script: "singularity/buy-programs.js" },
	// study.js exits by itself past its target (75); skipping it here keeps its 6GB free for later entries.
	{ stage: "early", script: "singularity/study.js", skip: (ns) => ns.getHackingLevel() >= 75 },
	{ stage: "early", script: "batcher.js" },
	// Player work and invites from the start, so CyberSec/NiteSec/Tian Di Hui need nobody at the keyboard.
	{ stage: "early", script: "singularity/join-factions.js" },
	{ stage: "early", script: "singularity/auto-backdoor.js" },
	{ stage: "early", script: "singularity/faction-work.js" },
	{ stage: "early", script: "pserv-manager.js" },
	{ stage: "early", script: "singularity/get-tian-di-hui.js", skip: (ns) => ns.getPlayer().factions.includes("Tian Di Hui") },
	// After Tian Di Hui: flies to and joins the city factions whose augments are still wanted, one rival group per run.
	{ stage: "early", script: "singularity/city-factions.js" },
	{ stage: "early", script: "hacknet-manager.js" },
	// Destroys w0r1d_d43m0n once The Red Pill is installed and hacking/ports allow, then enters the next BitNode.
	{ stage: "early", script: "singularity/auto-destroy.js" },
	// tools/track-income.js left out (2.7GB): the batcher, darknet and stock logs already show income. Run it by hand.
	{ stage: "early", script: "go/ipvgo-bot.js", args: ["--opponent", "Netburners"], restartOnNewArgs: true, until: "mid" },
	{ stage: "mid", script: "go/ipvgo-bot.js", args: ["--opponent", "The Black Hand"], restartOnNewArgs: true, until: "late" },
	{ stage: "mid", script: "singularity/company-work.js" },
	{ stage: "mid", script: "solve-contracts.js", homeOnly: true },
	{ stage: "mid", script: "darknet/dnet-manager.js", homeOnly: true },
	{ stage: "mid", script: "singularity/upgrade-home-cores.js" },
	// Last in mid: it only runs during faction work and only on RAM the batcher leaves free.
	{ stage: "mid", script: "share-manager.js" },
	// Buys and installs augs by itself when the reset rule in buy-augs.js says so; startup.js comes
	// back afterwards. Add args: ["--dry"] to only log (restartOnNewArgs swaps a running copy).
	{ stage: "mid", script: "singularity/auto-reset.js", args: [], restartOnNewArgs: true, homeOnly: true },
	{ stage: "late", script: "go/ipvgo-bot.js", args: ["--opponent", "Daedalus"], restartOnNewArgs: true },
	{ stage: "late", script: "stock-trader.js", args: ["--buy-4s", "--promote", 32], homeOnly: true },
];
const STAGES = ["early", "mid", "late"];
// Printed at the end when startup.js is run by hand (see the end of main).
const STATUS_SCRIPT = "/tools/status.js";
// Home RAM at which "auto" picks each stage.
const STAGE_MIN_HOME_RAM = { early: 0, mid: 128, late: 256 };
// Scripts placed off home may use at most this share of the other rooted servers' RAM,
// so the batcher always keeps the rest for hack/grow/weaken threads.
const MAX_OFF_HOME_SHARE = 0.65;

/**
 * Starts the scripts for a stage, skipping ones already running anywhere, then exits
 * (so its own RAM is only used for a moment).
 *   run /startup.js          pick the stage from home RAM
 *   run /startup.js mid      start everything up to the mid stage
 *   alias startup='run /startup.js'   (absolute path, so it works from any directory)
 *
 * Home first. When home is too small (a fresh 8GB start), it roots every server it can and
 * runs the script on a rooted server instead, copying the script and its imports there.
 * The free servers alone (n00dles, foodnstuff, joesguns, ...) have about 100GB.
 *
 * You don't need to run it again by hand: upgrade-home-ram.js and buy-programs.js start it
 * after each home upgrade / port opener, so new stages and scripts that didn't fit get going.
 * It also runs after an augment install (auto-reset / install-augs) and, with
 * singularity/next-bitnode.js (run by auto-destroy.js), at the start of the next BitNode.
 */
/** @param {NS} ns */
export async function main(ns) {
	const requested = String(ns.args[0] ?? "auto");
	const homeRam = ns.getServerMaxRam("home");
	const stage = requested === "auto"
		? STAGES.filter((name) => homeRam >= STAGE_MIN_HOME_RAM[name]).pop()
		: requested;
	if (!STAGES.includes(stage)) {
		ns.tprint(`ERROR startup: unknown stage "${requested}". Use auto, ${STAGES.join(", ")}.`);
		return;
	}
	const level = STAGES.indexOf(stage);
	const wanted = SCRIPTS.filter((entry) =>
		STAGES.indexOf(entry.stage) <= level &&
		(!entry.until || STAGES.indexOf(entry.until) > level)
	);

	nukeAllServers(ns);
	// Servers we can run scripts on other than home. Darknet servers need sessions, so not those.
	const hosts = getAllServers(ns).filter((host) =>
		host !== "home" && host !== "darkweb" && ns.hasRootAccess(host) && ns.getServerMaxRam(host) > 0 && !ns.dnet.isDarknetServer(host)
	);
	const running = ["home", ...hosts].flatMap((host) => ns.ps(host).map((proc) => ({ ...proc, host })));
	const ourScripts = new Set(SCRIPTS.map((entry) => entry.script));
	const offHomeTotal = hosts.reduce((sum, host) => sum + ns.getServerMaxRam(host), 0);
	let offHomeUsed = running
		.filter((proc) => proc.host !== "home" && ourScripts.has(proc.filename))
		.reduce((sum, proc) => sum + ns.getScriptRam(proc.filename, proc.host) * proc.threads, 0);

	const started = [], alreadyRunning = [], noRoom = [], missing = [];
	for (const entry of wanted) {
		if (entry.skip && entry.skip(ns)) continue;
		const args = entry.args ?? [];
		const label = [entry.script, ...args].join(" ");
		if (!ns.fileExists(entry.script, "home")) {
			missing.push(entry.script);
			continue;
		}
		const copies = running.filter((proc) => proc.filename === entry.script);
		if (copies.some((proc) => sameArgs(proc.args, args))) {
			alreadyRunning.push(entry.script);
			continue;
		}
		if (entry.restartOnNewArgs) {
			for (const proc of copies) {
				ns.kill(proc.pid);
				if (proc.host !== "home") offHomeUsed -= ns.getScriptRam(proc.filename, proc.host) * proc.threads;
			}
		}

		const ram = ns.getScriptRam(entry.script, "home");
		let host = null;
		if (ram <= freeRam(ns, "home") && ns.exec(entry.script, "home", 1, ...args) !== 0) {
			host = "home";
		} else if (!entry.homeOnly && offHomeUsed + ram <= offHomeTotal * MAX_OFF_HOME_SHARE) {
			host = placeOffHome(ns, entry.script, args, ram, hosts);
			if (host) offHomeUsed += ram;
		}
		if (!host) {
			noRoom.push(`${entry.script} (${ns.format.ram(ram)})`);
			continue;
		}
		started.push(host === "home" ? label : `${label} [on ${host}]`);
	}

	ns.tprint(`startup: stage "${stage}" on ${ns.format.ram(homeRam)} home`);
	if (started.length) ns.tprint(`  started: ${started.join(", ")}`);
	if (alreadyRunning.length) ns.tprint(`  already running: ${alreadyRunning.join(", ")}`);
	if (noRoom.length) ns.tprint(`  no room yet (starts after the next home upgrade): ${noRoom.join(", ")}`);
	if (missing.length) ns.tprint(`  WARNING missing files: ${missing.join(", ")}`);

	// Typed by hand (no parent script): finish with the one-screen status. The automatic relaunches
	// from upgrade-home-ram.js and buy-programs.js skip it, so the terminal isn't flooded.
	if (ns.getRunningScript().parent === 0 && ns.fileExists(STATUS_SCRIPT, "home") &&
		ns.exec(STATUS_SCRIPT, "home") === 0) {
		ns.tprint(`  (no room on home for ${STATUS_SCRIPT} yet; type \`status\` once things settle)`);
	}
}

function freeRam(ns, host) {
	return ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
}

/** Runs the script on the rooted server with the least free RAM that still fits it. Returns the host or null. */
function placeOffHome(ns, script, args, ram, hosts) {
	const fitting = hosts
		.filter((host) => freeRam(ns, host) >= ram)
		.sort((first, second) => freeRam(ns, first) - freeRam(ns, second));
	const files = withImports(ns, script);
	for (const host of fitting) {
		if (!ns.scp(files, host, "home")) continue;
		if (ns.exec(script, host, 1, ...args) !== 0) return host;
	}
	return null;
}

/** The script plus every file it imports, followed recursively (read from home). */
function withImports(ns, script) {
	const found = new Set();
	const queue = [script];
	while (queue.length > 0) {
		const file = queue.pop().replace(/^\//, "");
		if (found.has(file)) continue;
		found.add(file);
		for (const match of ns.read(file).matchAll(/from\s+["']([^"']+)["']/g)) queue.push(match[1]);
	}
	return [...found];
}

function sameArgs(first, second) {
	return first.length === second.length && first.every((value, index) => String(value) === String(second[index]));
}
