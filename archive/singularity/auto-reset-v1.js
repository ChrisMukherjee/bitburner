const CONFIG = {
	minAugs: 5,              // install once this many augments are queued or affordable...
	keyAugs: ["The Red Pill", "Neuroreceptor Manager"], // ...or as soon as one of these is
	checkMinutes: 10,
	afterReset: "startup.js", // run on home after the install
	planFile: "data/aug-plan.json",
	planner: "singularity/buy-augs.js",
	installer: "singularity/install-augs.js",
};

/**
 * Decides when to reset. Every 10 minutes it runs buy-augs.js --plan (about 28GB, for a
 * moment) to see which augments you could buy now. Once that reaches 5 (counting ones
 * already bought), or includes The Red Pill or Neuroreceptor Manager, it stops every
 * other script on home, buys them with buy-augs.js, and installs with install-augs.js,
 * which starts startup.js after the reset.
 *
 * This script itself is small (about 3.8GB); the planner only fits when home has 28GB free,
 * otherwise that check is skipped and logged.
 *
 *   run singularity/auto-reset.js               watch and reset when it's worth it
 *   run singularity/auto-reset.js --min-augs 8  wait for a bigger batch
 *   run singularity/auto-reset.js --dry         only log when it would reset
 */
export async function main(ns) {
	ns.disableLog("ALL");
	const flags = ns.flags([["min-augs", CONFIG.minAugs], ["dry", false]]);

	while (true) {
		const askedAt = Date.now();
		const plan = await runAndWait(ns, CONFIG.planner, "--plan") ? readPlan(ns, askedAt) : null;
		if (!plan) {
			ns.print(`[auto-reset] couldn't plan: no room for ${CONFIG.planner} (${ns.format.ram(ns.getScriptRam(CONFIG.planner))}) or it failed; will try again`);
		} else {
			const total = plan.queued.length + plan.affordable.length;
			const key = CONFIG.keyAugs.filter((aug) => plan.queued.includes(aug) || plan.affordable.includes(aug));
			ns.print(
				`[auto-reset] ${plan.queued.length} bought + ${plan.affordable.length} affordable ` +
				`($${ns.format.number(plan.cost)}), need ${flags["min-augs"]}` + (key.length ? `; key: ${key.join(", ")}` : "")
			);
			if (total > 0 && (total >= flags["min-augs"] || key.length > 0)) {
				if (flags.dry) {
					ns.print("[auto-reset] would reset now (--dry, not doing it)");
				} else {
					ns.toast(`Resetting: installing ${total} augments`, "warning", 10_000);
					await resetNow(ns);
					return;
				}
			}
		}
		await ns.sleep(CONFIG.checkMinutes * 60_000);
	}
}

/** Frees home for the buyer, buys, then installs (the install ends this script too). */
async function resetNow(ns) {
	for (const proc of ns.ps("home")) {
		if (proc.pid !== ns.pid) ns.kill(proc.pid);
	}
	if (!await runAndWait(ns, CONFIG.planner)) {
		ns.tprint(`auto-reset: couldn't run ${CONFIG.planner} even on an empty home. Not installing.`);
		return;
	}
	ns.exec(CONFIG.installer, "home", 1, CONFIG.afterReset);
}

/** Runs a script on home and waits for it to finish. False if it couldn't start. */
async function runAndWait(ns, script, ...args) {
	const pid = ns.exec(script, "home", 1, ...args);
	if (pid === 0) return false;
	while (ns.isRunning(pid)) await ns.sleep(200);
	return true;
}

/** The plan written since askedAt, or null (a crashed planner leaves an old file behind). */
function readPlan(ns, askedAt) {
	try {
		const plan = JSON.parse(ns.read(CONFIG.planFile));
		return plan.time >= askedAt ? plan : null;
	} catch {
		return null;
	}
}
