// Every long-running script, in priority order: earlier entries get home RAM first.
// A stage starts everything tagged with that stage or an earlier one.
// restartOnNewArgs: if a copy with different args is running, kill it first
// (otherwise two go bots would fight over the same board).
const SCRIPTS = [
	{ stage: "early", script: "singularity/upgrade-home-ram.js" },
	{ stage: "early", script: "singularity/buy-programs.js" },
	// study.js exits by itself past its target (75); skipping it here keeps its 6GB free for later entries.
	{ stage: "early", script: "singularity/study.js", skip: (ns) => ns.getHackingLevel() >= 75 },
	{ stage: "early", script: "batcher.js" },
	{ stage: "early", script: "hacknet-manager.js" },
	{ stage: "early", script: "pserv-manager.js" },
	// tools/track-income.js left out (2.7GB): the batcher, darknet and stock logs already show income. Run it by hand.
	{ stage: "early", script: "go/ipvgo-bot.js", args: ["--opponent", "Netburners"], restartOnNewArgs: true, until: "mid" },
	{ stage: "mid", script: "go/ipvgo-bot.js", args: ["--opponent", "The Black Hand"], restartOnNewArgs: true, until: "late" },
	{ stage: "mid", script: "singularity/join-factions.js" },
	{ stage: "mid", script: "singularity/get-tian-di-hui.js", skip: (ns) => ns.getPlayer().factions.includes("Tian Di Hui") },
	{ stage: "mid", script: "singularity/faction-work.js" },
	{ stage: "mid", script: "singularity/company-work.js" },
	{ stage: "mid", script: "solve-contracts.js" },
	{ stage: "mid", script: "darknet/dnet-manager.js" },
	{ stage: "mid", script: "singularity/upgrade-home-cores.js" },
	// Last in mid: it only runs during faction work and only on RAM the batcher leaves free.
	{ stage: "mid", script: "share-manager.js" },
	// --dry: only logs when it would reset. Drop the flag once its timing looks right (it then resets
	// the run by itself and startup.js comes back afterwards).
	{ stage: "mid", script: "singularity/auto-reset.js", args: ["--dry"], restartOnNewArgs: true },
	{ stage: "late", script: "go/ipvgo-bot.js", args: ["--opponent", "Daedalus"], restartOnNewArgs: true },
	{ stage: "late", script: "stock-trader.js", args: ["--buy-4s", "--promote", 32] },
	{ stage: "late", script: "singularity/auto-backdoor.js" },
];
const STAGES = ["early", "mid", "late"];
// Home RAM at which "auto" picks each stage.
const STAGE_MIN_HOME_RAM = { early: 0, mid: 128, late: 256 };

/**
 * Starts the scripts for a stage on home, skipping ones already running, then exits
 * (so its own RAM is only used for a moment).
 *   run startup.js          pick the stage from home RAM
 *   run startup.js mid      start everything up to the mid stage
 * Run it again after a home RAM upgrade: scripts that didn't fit before get started.
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

	const running = ns.ps("home");
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
		if (entry.restartOnNewArgs) copies.forEach((proc) => ns.kill(proc.pid));

		const free = homeRam - ns.getServerUsedRam("home");
		if (ns.getScriptRam(entry.script, "home") > free || ns.exec(entry.script, "home", 1, ...args) === 0) {
			noRoom.push(`${entry.script} (${ns.format.ram(ns.getScriptRam(entry.script, "home"))})`);
			continue;
		}
		started.push(label);
	}

	ns.tprint(`startup: stage "${stage}" on ${ns.format.ram(homeRam)} home`);
	if (started.length) ns.tprint(`  started: ${started.join(", ")}`);
	if (alreadyRunning.length) ns.tprint(`  already running: ${alreadyRunning.join(", ")}`);
	if (noRoom.length) ns.tprint(`  no room yet: ${noRoom.join(", ")}`);
	if (missing.length) ns.tprint(`  WARNING missing files: ${missing.join(", ")}`);
}

function sameArgs(first, second) {
	return first.length === second.length && first.every((value, index) => String(value) === String(second[index]));
}
