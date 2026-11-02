// Design: docs/startup.md
import { loadConfig, USER_CONFIG_FILE } from "/utils/config.js";
import { getAllServers } from "/utils/get-all-servers.js";
import { nukeAllServers } from "/utils/nuke-all.js";
import { singularityInfo } from "/utils/singularity.js";

// Every long-running script, in priority order: earlier entries get RAM first.
// A stage starts everything tagged with that stage or an earlier one.
//   restartOnNewArgs: if a copy with different args is running (anywhere), kill it first
//                     (otherwise two go bots would fight over the same board).
//   homeOnly:         reads or writes data files on its own server, so it must run on home.
//   skip:             (ns, config) => true leaves it out this time.
//   needsSF4:         needs the Singularity API (BitNode 4 or Source-File 4). Every script in
//                     singularity/ counts as this too; without the API they are all left out.
// Scripts listed in `startupSkip` in the config (config.js, data/config.json) are never started.
// Everything else may run on a rooted server when home is too small (see main below).
const SCRIPTS = [
	// "start": a fresh BitNode or a small home. Only what earns money or levels, so the batcher gets
	// most of the free servers' RAM; everything else waits for the early stage (more home RAM).
	{ stage: "start", script: "singularity/upgrade-home-ram.js" },
	{ stage: "start", script: "singularity/buy-programs.js" },
	{ stage: "start", script: "batcher.js" },
	// Player work and invites from the start, so CyberSec/NiteSec/Tian Di Hui need nobody at the keyboard.
	{ stage: "start", script: "singularity/join-factions.js" },
	{ stage: "start", script: "singularity/auto-backdoor.js" },
	// The one script that moves the player: study to studying.hackLevel, faction work to the real rep
	// goals, megacorp jobs in the gaps, Tian Di Hui and the wanted city group. Exits when all is done.
	{ stage: "start", script: "singularity/player-work.js" },
	// BitNode 2's money and augments. Only once a gang exists or a gang faction is joined (player-work.js
	// gets the invite in BitNode 2), so its ~33GB isn't held while waiting. See gangReady below.
	{ stage: "start", script: "gang/gang-manager.js", skip: (ns, config) => !gangReady(ns, config) },
	// Both keep $1m back for TOR and the port openers, so they buy nothing in the first minutes anyway.
	{ stage: "early", script: "pserv-manager.js" },
	{ stage: "early", script: "hacknet-manager.js" },
	// Destroys w0r1d_d43m0n once The Red Pill is installed and hacking/ports allow, then enters the next BitNode.
	{ stage: "early", script: "singularity/auto-destroy.js" },
	// tools/track-income.js left out (2.7GB): the batcher, darknet and stock logs already show income. Run it by hand.
	{ stage: "early", script: "go/ipvgo-bot.js", args: ["--opponent", "Netburners"], restartOnNewArgs: true, until: "mid" },
	{ stage: "mid", script: "go/ipvgo-bot.js", args: ["--opponent", "The Black Hand"], restartOnNewArgs: true, until: "late" },
	{ stage: "mid", script: "solve-contracts.js", homeOnly: true },
	{ stage: "mid", script: "darknet/dnet-manager.js", homeOnly: true },
	{ stage: "mid", script: "singularity/upgrade-home-cores.js" },
	// Last in mid: it only runs during faction work and only on RAM the batcher leaves free.
	{ stage: "mid", script: "share-manager.js", needsSF4: true },
	// Buys and installs augs by itself when the reset rule in buy-augs.js says so; startup.js comes
	// back afterwards. Add args: ["--dry"] to only log (restartOnNewArgs swaps a running copy).
	{ stage: "mid", script: "singularity/auto-reset.js", args: [], restartOnNewArgs: true, homeOnly: true },
	{ stage: "late", script: "go/ipvgo-bot.js", args: ["--opponent", "Daedalus"], restartOnNewArgs: true },
	{ stage: "late", script: "stock-trader.js", args: ["--buy-4s", "--promote", 32], homeOnly: true },
];
const STAGES = ["start", "early", "mid", "late"];
// Printed at the end when startup.js is run by hand (see the end of main).
const STATUS_SCRIPT = "/tools/status.js";
// Home RAM at which "auto" picks each stage: `startupStages` in the config.
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
 * At the "start" stage (home below startupStages.early, e.g. a fresh BitNode) only the scripts that
 * earn or level run, so the batcher has RAM to hack with; the rest follow after a home upgrade.
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
	const config = loadConfig(ns);
	const stageMinHomeRam = config.startupStages;
	const homeRam = ns.getServerMaxRam("home");
	const stage = requested === "auto"
		? STAGES.filter((name) => homeRam >= (stageMinHomeRam[name] ?? Infinity)).pop()
		: requested;
	if (!STAGES.includes(stage)) {
		ns.tprint(`ERROR startup: unknown stage "${requested}". Use auto, ${STAGES.join(", ")}.`);
		return;
	}
	const level = STAGES.indexOf(stage);
	// Costs 1GB (getResetInfo). With BN4/SF4 for sure, set sf4 to { available: true, level: 3, ramMultiplier: 1 }
	// and drop the import to save it.
	const sf4 = singularityInfo(ns);
	const needsSingularity = (entry) => entry.needsSF4 || entry.script.startsWith("singularity/");
	const inStage = SCRIPTS.filter((entry) =>
		STAGES.indexOf(entry.stage) <= level &&
		(!entry.until || STAGES.indexOf(entry.until) > level) &&
		!config.startupSkip.includes(entry.script)
	);
	const wanted = inStage.filter((entry) => sf4.available || !needsSingularity(entry));
	const noSingularity = inStage.length - wanted.length;

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
		if (entry.skip && entry.skip(ns, config)) continue;
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
	if (noSingularity > 0) {
		ns.tprint(`  skipped ${noSingularity} Singularity scripts (need BitNode 4 or Source-File 4). ` +
			"Buy home RAM and programs yourself, then run startup.js again for the next stage.");
	} else if (sf4.ramMultiplier > 1 && noRoom.length) {
		ns.tprint(`  note: Singularity calls cost ${sf4.ramMultiplier}x RAM at SF4.${sf4.level}, ` +
			"so some of these may wait for more home RAM.");
	}
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

/**
 * True when gang/gang-manager.js has something to do: a gang exists, or a faction from gang.factions
 * is joined and a gang can be created (BitNode 2, or Source-File 2 with karma -54,000).
 */
function gangReady(ns, config) {
	if (ns.gang.inGang()) return true; // 0GB, works without the Gang API
	if (!config.gang.factions.some((faction) => ns.getPlayer().factions.includes(faction))) return false;
	const info = ns.getResetInfo();
	return info.currentNode === 2 || (info.ownedSF.has(2) && ns.heart.break() <= -54_000);
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
	// The player's own settings, so loadConfig sees them there too.
	if (ns.fileExists(USER_CONFIG_FILE, "home")) files.push(USER_CONFIG_FILE);
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
