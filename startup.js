// Design: docs/startup.md
import { loadConfig, USER_CONFIG_FILE, BITNODE_FILE } from "/utils/config.js";
import { getAllServers } from "/utils/get-all-servers.js";
import { nukeAllServers } from "/utils/nuke-all.js";
import { notify } from "/utils/notify.js";
import { reserveRoom, releaseRoom } from "/utils/ram-reserve.js";
import { singularityInfo } from "/utils/singularity.js";
// Mechanic folders: each one's "is there work for its manager?" check (see AGENTS.md).
import { gangReady } from "/gang/ready.js";
import { dnetReady } from "/darknet/ready.js";
import { bladeburnerReady, bladeburnerRunning } from "/bladeburner/ready.js";
import { pservReady } from "/pserv/ready.js";
import { clearGates, homeRamReady, homeCoresReady, programsReady, backdoorReady, playerWorkReady, donateReady } from "/singularity/ready.js";

// Every script startup.js runs, in priority order: earlier entries get RAM first.
// A stage starts everything tagged with that stage or an earlier one.
//   oneShot:          runs one short pass (--once) and exits, so its RAM is only used for a moment.
//                     Started again when `ready` says so (e.g. the next purchase is affordable), at
//                     most every `every` ms, and only one one-shot at a time. Never "restarted".
//   restartOnNewArgs: if a copy with different args is running (anywhere), kill it first
//                     (otherwise two go bots would fight over the same board). One-shots do this too.
//   homeOnly:         reads or writes data files on its own server, so it must run on home.
//   ready:            (ns, config) => false leaves it out this time. For a mechanic's manager,
//                     imported from its folder, so startup.js knows nothing about the mechanic.
//   needsSF4:         needs the Singularity API (BitNode 4 or Source-File 4). Every script in
//                     singularity/ counts as this too; without the API they are all left out.
// Scripts listed in `startupSkip` in the config (config.js, data/config.json) are never started.
// Everything else may run on a rooted server when home is too small (see main below).
const SCRIPTS = [
	// "start": a fresh BitNode or a small home. Only what earns money or levels, so the batcher gets
	// most of the free servers' RAM; everything else waits for the early stage (more home RAM).
	{ stage: "start", script: "singularity/upgrade-home-ram.js", args: ["--once"], oneShot: true, every: 10_000, ready: homeRamReady },
	{ stage: "start", script: "singularity/buy-programs.js", args: ["--once"], oneShot: true, every: 10_000, ready: programsReady },
	{ stage: "start", script: "hack/batcher.js" },
	// Invites and backdoors from the start, so CyberSec/NiteSec/Tian Di Hui need nobody at the keyboard.
	{ stage: "start", script: "singularity/join-factions.js", args: ["--once"], oneShot: true, every: 60_000 },
	{ stage: "start", script: "singularity/auto-backdoor.js", args: ["--once"], oneShot: true, every: 120_000, ready: backdoorReady },
	// player-work.js (32.5GB) fits nowhere below a 64GB home, so until then this 7.35GB pass (workers up to 12.1GB) moves the
	// player instead: the free course to studying.hackLevel, then the best-paying crime for cash.
	{ stage: "start", until: "early", script: "singularity/player-work-start.js", oneShot: true, every: 60_000 },
	// The one script that moves the player: study to studying.hackLevel, faction work to the real rep
	// goals, megacorp jobs in the gaps, Tian Di Hui and the wanted city group. A short pass every
	// minute (the game keeps the work going), until it posts that everything is done.
	{ stage: "early", script: "singularity/player-work.js", args: ["--once"], oneShot: true, every: 60_000, ready: playerWorkReady },
	// Without the Singularity API nothing backdoors or buys programs by itself: this tells you when to, once each.
	{ stage: "start", script: "tools/reminders.js", oneShot: true, every: 60_000, homeOnly: true, ready: (ns) => !singularityInfo(ns).available },
	// Mechanics, one folder each. Started only once their ready check says there is work.
	{ stage: "start", script: "gang/gang-manager.js", ready: gangReady },
	// Bladeburner (BitNode 6/7 or Source-File 6/7): the manager decides the state every 3 minutes, the pass plays
	// every 30 s while the state is "run"; player-work.js does the gym. One-shots, so their RAM is only held for a moment.
	{ stage: "early", script: "bladeburner/bb-manage.js", oneShot: true, every: 180_000, ready: bladeburnerReady },
	{ stage: "early", script: "bladeburner/bb-pass.js", oneShot: true, every: 30_000, ready: bladeburnerRunning },
	// The route estimate (hacking or Bladeburner, hold or run) every 5 minutes; needs the Singularity API for the augmentation data.
	{ stage: "early", script: "bladeburner/node-eta.js", oneShot: true, every: 300_000, needsSF4: true, ready: bladeburnerReady },
	// Both keep $1m back for TOR and the port openers, so they buy nothing in the first minutes anyway.
	// Exits once every server is maxed; not started again until the next run (startup clears port 33).
	{ stage: "early", script: "pserv/pserv-manager.js", ready: pservReady },
	{ stage: "early", script: "hacknet/hacknet-manager.js" },
	// Destroys w0r1d_d43m0n once The Red Pill is installed and hacking/ports allow, then enters the next BitNode.
	{ stage: "early", script: "singularity/auto-destroy.js" },
	// Buys The Red Pill's rep with money once Daedalus has the favor for donations (otherwise it is ground by work).
	{ stage: "early", script: "singularity/donate-rep.js", oneShot: true, every: 120_000, homeOnly: true, ready: donateReady },
	// tools/track-income.js left out (2.7GB): the batcher, darknet and stock logs already show income. Run it by hand.
	{ stage: "early", script: "go/ipvgo-bot.js", args: ["--opponent", "Netburners"], restartOnNewArgs: true, until: "mid" },
	{ stage: "mid", script: "go/ipvgo-bot.js", args: ["--opponent", "The Black Hand"], restartOnNewArgs: true, until: "late" },
	{ stage: "mid", script: "contracts/solve-contracts.js", homeOnly: true },
	{ stage: "mid", script: "darknet/dnet-manager.js", homeOnly: true, ready: dnetReady },
	{ stage: "mid", script: "singularity/upgrade-home-cores.js", args: ["--once"], oneShot: true, every: 30_000, ready: homeCoresReady },
	// Spare RAM into weaken threads for hacking XP; yields to share-manager while it is sharing.
	{ stage: "mid", script: "hack/xp-farm.js" },
	// Last in mid: it only runs during faction work and only on RAM the batcher leaves free.
	{ stage: "mid", script: "share/share-manager.js", needsSF4: true },
	// Buys and installs augs by itself when the reset rule in buy-augs.js says so; startup.js comes
	// back afterwards. Add args: ["--dry"] to only log (restartOnNewArgs swaps a running copy).
	{ stage: "mid", script: "singularity/auto-reset.js", args: [], restartOnNewArgs: true, homeOnly: true },
	{ stage: "late", script: "go/ipvgo-bot.js", args: ["--opponent", "Daedalus"], restartOnNewArgs: true },
	{ stage: "late", script: "stocks/stock-trader.js", args: ["--buy-4s", "--promote", 32], homeOnly: true },
];
const STAGES = ["start", "early", "mid", "late"];
// Printed at the end of the first pass when startup.js is run by hand (see the end of main).
const STATUS_SCRIPT = "/tools/status.js";
// Home RAM at which "auto" picks each stage: `startupStages` in the config.
// Scripts placed off home may use at most this share of the other rooted servers' RAM,
// so the batcher always keeps the rest for hack/grow/weaken threads.
const MAX_OFF_HOME_SHARE = 0.65;
// Key of startup.js's own room reservation (utils/ram-reserve.js).
const RESERVE_KEY = "startup.js";
// What is waiting and why (no room, missing file); read it with `cat data/startup-why.txt`.
const WHY_FILE = "data/startup-why.txt";

const CONFIG = {
	passMs: 10_000,         // time between passes
	restartMinMs: 30_000,   // wait before restarting a script that stopped...
	restartMaxMs: 3_600_000, // ...doubling each time it stops again soon after starting, up to this
	longRunMs: 600_000,     // a script that ran this long before stopping gets the short wait again
};

/**
 * Starts the scripts for the current stage and stays running: each pass it starts what has become
 * ready (a new stage after a home upgrade, a gang, an affordable purchase), restarts scripts that
 * stopped, and runs the Singularity buyers as short one-shots.
 *   run /startup.js            pick the stage from home RAM (again on every pass)
 *   run /startup.js mid        stay on the mid stage
 *   run /startup.js --restart  also restart every script it manages that is already running,
 *                              so code synced since they started takes effect
 *   run /startup.js --once     one pass, then exit (the old behaviour)
 *   alias startup='run /startup.js'   (absolute path, so it works from any directory)
 *
 * Running it again replaces the copy that is running. At the "start" stage (home below
 * startupStages.early, e.g. a fresh BitNode) only the scripts that earn or level run, so the batcher
 * has RAM to hack with; the rest follow after a home upgrade.
 * Home first. When home is too small (a fresh 8GB start), it roots every server it can and
 * runs the script on a rooted server instead, copying the script and its imports there.
 * The free servers alone (n00dles, foodnstuff, joesguns, ...) have about 100GB.
 *
 * It is started after an augment install (auto-reset / install-augs) and, with
 * singularity/next-bitnode.js (run by auto-destroy.js), at the start of the next BitNode.
 */
/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	const flags = ns.flags([["restart", false], ["once", false]]);
	const requested = String(flags._[0] ?? "auto");
	if (requested !== "auto" && !STAGES.includes(requested)) {
		ns.tprint(`ERROR startup: unknown stage "${requested}". Use auto, ${STAGES.join(", ")}.`);
		return;
	}

	// Only one copy: this one replaces any that is running.
	for (const proc of ns.ps("home")) {
		if (proc.filename === ns.getScriptName() && proc.pid !== ns.pid) ns.kill(proc.pid);
	}
	// For loadConfig's per-BitNode settings (`bitnodes` in config.js). getResetInfo is already paid for below.
	ns.write(BITNODE_FILE, String(ns.getResetInfo().currentNode), "w");
	// Costs 1GB (getResetInfo). Doesn't change during a run, so read once.
	const sf4 = singularityInfo(ns);
	// A new run (startup.js is started after every reset): every one-shot checks once again.
	clearGates(ns);
	releaseRoom(ns, RESERVE_KEY); // a replaced copy's reservation; this one posts its own when needed

	const state = {
		sf4,
		restart: flags.restart,
		firstPass: true,
		stage: "",
		daemons: new Map(),  // label -> { running, since, stoppedAt, wait }
		lastShot: new Map(), // label -> time a one-shot was last started
		reported: new Set(), // messages already printed (no room, missing file)
		reservedFor: null,   // label of the script room is reserved for off home
		whyText: null,       // last text written to WHY_FILE
	};

	while (true) {
		runPass(ns, requested, state);
		if (flags.once) return;
		await ns.sleep(CONFIG.passMs);
	}
}

/** One pass: pick the stage, then start what should run and isn't. */
function runPass(ns, requested, state) {
	const config = loadConfig(ns);
	const homeRam = ns.getServerMaxRam("home");
	const stage = requested === "auto"
		? STAGES.filter((name) => homeRam >= (config.startupStages[name] ?? Infinity)).pop()
		: requested;
	const level = STAGES.indexOf(stage);
	const needsSingularity = (entry) => entry.needsSF4 || entry.script.startsWith("singularity/");
	const inStage = SCRIPTS.filter((entry) =>
		STAGES.indexOf(entry.stage) <= level &&
		(!entry.until || STAGES.indexOf(entry.until) > level) &&
		!config.startupSkip.includes(entry.script)
	);
	const wanted = inStage.filter((entry) => state.sf4.available || !needsSingularity(entry));
	const noSingularity = inStage.length - wanted.length;

	nukeAllServers(ns);
	// Servers we can run scripts on other than home. Darknet servers need sessions, so not those.
	const hosts = getAllServers(ns).filter((host) =>
		host !== "home" && host !== "darkweb" && ns.hasRootAccess(host) && ns.getServerMaxRam(host) > 0 && !ns.dnet.isDarknetServer(host)
	);
	let running = ["home", ...hosts].flatMap((host) => ns.ps(host).map((proc) => ({ ...proc, host })));
	const ourScripts = new Set(SCRIPTS.map((entry) => entry.script));

	// --restart: stop every copy of our scripts once, so this pass starts them with the current code.
	if (state.restart) {
		for (const proc of running) if (ourScripts.has(proc.filename)) ns.kill(proc.pid);
		running = running.filter((proc) => !ourScripts.has(proc.filename));
		state.restart = false;
	}

	const offHomeTotal = hosts.reduce((sum, host) => sum + ns.getServerMaxRam(host), 0);
	let offHomeUsed = running
		.filter((proc) => proc.host !== "home" && ourScripts.has(proc.filename))
		.reduce((sum, proc) => sum + ns.getScriptRam(proc.filename, proc.host) * proc.threads, 0);
	// A one-shot script running with other args is an older looping copy (from before it was a
	// one-shot, or started by hand): stop it, the one-shot takes over.
	for (const entry of SCRIPTS.filter((item) => item.oneShot)) {
		for (const proc of running) {
			if (proc.filename === entry.script && !sameArgs(proc.args, entry.args ?? [])) ns.kill(proc.pid);
		}
	}
	running = running.filter((proc) => ns.isRunning(proc.pid));
	// Only one one-shot at a time, so they never all want their RAM at once. Of those that are due,
	// the one that waited longest goes first, so one that is always ready can't starve the rest.
	const now = Date.now();
	const shotRunning = running.some((proc) => SCRIPTS.some((entry) => entry.oneShot && entry.script === proc.filename));
	const due = shotRunning ? [] : wanted.filter((entry) => entry.oneShot &&
		now - (state.lastShot.get(shotLabel(entry)) ?? 0) >= (entry.every ?? 0) &&
		(!entry.ready || entry.ready(ns, config)));
	const nextShot = due.sort((first, second) =>
		(state.lastShot.get(shotLabel(first)) ?? 0) - (state.lastShot.get(shotLabel(second)) ?? 0))[0];

	const started = [], restarted = [], alreadyRunning = [], noRoom = [], missing = [];
	// The first script (by priority) that could run off home but found no room: room is reserved for it.
	let waiting = null;
	for (const entry of wanted) {
		const args = entry.args ?? [];
		const label = [entry.script, ...args].join(" ");
		const copies = running.filter((proc) => proc.filename === entry.script);
		const daemon = state.daemons.get(label);
		if (copies.some((proc) => sameArgs(proc.args, args))) {
			alreadyRunning.push(entry.script);
			if (!entry.oneShot && !daemon?.running) {
				state.daemons.set(label, { running: true, since: now, wait: daemon?.wait ?? CONFIG.restartMinMs });
			}
			continue;
		}
		// Not ready (e.g. it exited because it is done for this run): forget it quietly, so it gets
		// no "stopped" toast or retry timer, and starts fresh if it becomes ready again.
		if (!entry.oneShot && entry.ready && !entry.ready(ns, config)) {
			state.daemons.delete(label);
			continue;
		}
		// A daemon we saw running has stopped: wait a little before restarting it, longer each
		// time it stops again soon (many exit on purpose: nothing to buy, no API, all done).
		if (daemon?.running) {
			const ranFor = now - daemon.since;
			daemon.running = false;
			daemon.stoppedAt = now;
			daemon.wait = ranFor >= CONFIG.longRunMs ? CONFIG.restartMinMs : Math.min(daemon.wait * 2, CONFIG.restartMaxMs);
			if (ranFor >= CONFIG.longRunMs) {
				notify(ns, "[startup]", `${entry.script} stopped after ${ns.format.time(ranFor)}; restarting it in ${ns.format.time(daemon.wait)}.`, "warning");
			} else {
				ns.print(`[startup] ${entry.script} stopped; next try in ${ns.format.time(daemon.wait)}.`);
			}
		}
		if (daemon && !daemon.running && now - daemon.stoppedAt < daemon.wait) continue;

		if (entry.oneShot && entry !== nextShot) continue;
		if (!ns.fileExists(entry.script, "home")) {
			missing.push(entry.script);
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
			else waiting ??= { label, ram };
		}
		if (!host) {
			noRoom.push(`${entry.script} (${ns.format.ram(ram)})`);
			continue;
		}
		if (entry.oneShot) {
			state.lastShot.set(label, now);
			ns.print(`[startup] one-shot ${label}${host === "home" ? "" : ` [on ${host}]`}`);
			continue;
		}
		const where = host === "home" ? label : `${label} [on ${host}]`;
		(daemon ? restarted : started).push(where);
		state.daemons.set(label, { running: true, since: now, wait: daemon?.wait ?? CONFIG.restartMinMs });
	}

	// One reservation at a time, for the highest-priority script that is waiting, so the batcher
	// gives up as little RAM as possible (utils/ram-reserve.js; the batcher's RAM pool leaves it out).
	if (waiting) {
		const held = reserveRoom(ns, RESERVE_KEY, waiting.ram, hosts);
		if (held && waiting.label !== state.reservedFor) ns.print(`[startup] keeping ${ns.format.ram(waiting.ram)} free on ${held} for ${waiting.label}`);
		state.reservedFor = held ? waiting.label : null;
	} else if (state.reservedFor) {
		releaseRoom(ns, RESERVE_KEY);
		state.reservedFor = null;
	}

	writeWhy(ns, state, { noRoom, missing });
	report(ns, state, { stage, homeRam, noSingularity, started, restarted, alreadyRunning, noRoom, missing });
	state.firstPass = false;
	state.stage = stage;
}

/** Keeps WHY_FILE up to date (written only when it changes): what could not start and what room is held for it. */
function writeWhy(ns, state, { noRoom, missing }) {
	const lines = [
		...noRoom.map((line) => `no room yet: ${line}`),
		...missing.map((file) => `missing file: ${file}`),
		...(state.reservedFor ? [`room is being kept free for: ${state.reservedFor}`] : []),
	];
	const text = lines.join("\n");
	if (text === state.whyText) return;
	state.whyText = text;
	ns.write(WHY_FILE, `${new Date().toLocaleTimeString()}\n${text || "nothing is waiting"}\n`, "w");
}

/** First pass: the full summary in the terminal. Later passes: only what changed. */
function report(ns, state, pass) {
	const { stage, homeRam, noSingularity, started, restarted, alreadyRunning, noRoom, missing } = pass;
	if (state.firstPass) {
		ns.tprint(`startup: stage "${stage}" on ${ns.format.ram(homeRam)} home; stays running to start the rest when ready`);
		if (noSingularity > 0) {
			ns.tprint(`  skipped ${noSingularity} Singularity scripts (need BitNode 4 or Source-File 4). ` +
				"Buy home RAM and programs yourself; the next stage starts by itself.");
		} else if (state.sf4.ramMultiplier > 1 && noRoom.length) {
			ns.tprint(`  note: Singularity calls cost ${state.sf4.ramMultiplier}x RAM at SF4.${state.sf4.level}, ` +
				"so some of these may wait for more home RAM.");
		}
		if (started.length) ns.tprint(`  started: ${started.join(", ")}`);
		if (alreadyRunning.length) ns.tprint(`  already running: ${[...new Set(alreadyRunning)].join(", ")}`);
		if (noRoom.length) ns.tprint(`  no room yet (starts once there is): ${noRoom.join(", ")}`);
		if (missing.length) ns.tprint(`  WARNING missing files: ${missing.join(", ")}`);
		for (const line of [...noRoom, ...missing]) state.reported.add(line);
		// Typed by hand (no parent script): finish with the one-screen status. The automatic starts
		// after a reset or a new BitNode skip it, so the terminal isn't flooded.
		if (ns.getRunningScript().parent === 0 && ns.fileExists(STATUS_SCRIPT, "home") &&
			ns.exec(STATUS_SCRIPT, "home") === 0) {
			ns.tprint(`  (no room on home for ${STATUS_SCRIPT} yet; type \`status\` once things settle)`);
		}
		return;
	}
	if (stage !== state.stage) notify(ns, "[startup]", `stage "${stage}" on ${ns.format.ram(homeRam)} home`, "info");
	if (started.length) notify(ns, "[startup]", `started ${started.join(", ")}`, "info");
	if (restarted.length) ns.print(`[startup] restarted ${restarted.join(", ")}`);
	for (const line of noRoom) {
		if (!state.reported.has(line)) ns.print(`[startup] no room yet: ${line}`);
	}
	for (const file of missing) {
		if (!state.reported.has(file)) notify(ns, "[startup]", `missing file ${file}`, "warning", true);
	}
	for (const line of [...noRoom, ...missing]) state.reported.add(line);
}

function shotLabel(entry) {
	return [entry.script, ...(entry.args ?? [])].join(" ");
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
	for (const file of [USER_CONFIG_FILE, BITNODE_FILE]) if (ns.fileExists(file, "home")) files.push(file);
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
