import { loadConfig } from "/utils/config.js";
const CONFIG = {
	checkMinutes: 10,
	afterReset: "startup.js", // run on home after the install
	planFile: "data/aug-plan.json",
	planner: "singularity/buy-augs.js",
	installer: "singularity/install-augs.js",
};

/**
 * Decides when to reset. Every 10 minutes it runs buy-augs.js --plan (about 29GB, for a
 * moment), which works out what you could buy and applies the reset rule in buy-augs.js
 * (decideReset): the same rule `augs` (buy-augs --dry) prints, so the two always agree.
 * When the rule says reset, it stops every other script on home, buys with buy-augs.js,
 * and installs with install-augs.js, which starts startup.js after the reset.
 *
 * The rule, in short: reset for The Red Pill or Neuroreceptor Manager right away; otherwise
 * once 5 useful augments are ready, unless another one you could also afford unlocks within
 * 30 minutes, but never waiting more than 60 minutes in total once the batch is ready; or,
 * when the run is 3+ hours old, with 2+ ready if nothing affordable unlocks within 4 hours
 * or after waiting 3 hours for the batch to fill up.
 *
 * This script itself is small (about 3.8GB); the planner only fits when home has 29GB free,
 * otherwise that check is skipped and logged.
 *
 *   run singularity/auto-reset.js               watch and reset when the rule says so
 *   run singularity/auto-reset.js --min-augs 8  wait for a bigger batch
 *   run singularity/auto-reset.js --dry         only log what it would do
 *
 * It prints a terminal line and a toast when a new useful augment becomes affordable, and
 * when the advice switches to RESET (also with --dry).
 */
export async function main(ns) {
	ns.disableLog("ALL");
	const flags = ns.flags([["min-augs", loadConfig(ns).augments.resetRule.minAugs], ["dry", false]]);

	let lastReason = "";
	let seen = null;          // augments already ready (bought or affordable); null until the first plan
	let lastReset = false;    // whether the last advice was RESET
	while (true) {
		const askedAt = Date.now();
		const ran = await runAndWait(ns, CONFIG.planner, "--plan", "--min-augs", flags["min-augs"]);
		const plan = ran ? readPlan(ns, askedAt) : null;
		if (!plan?.decision) {
			ns.print(`[auto-reset] couldn't plan: no room for ${CONFIG.planner} (${ns.format.ram(ns.getScriptRam(CONFIG.planner))}) or it failed; will try again`);
		} else {
			const summary = `${plan.queued.length} bought + ${plan.affordable.length} affordable ($${ns.format.number(plan.cost)})`;
			const line = `[auto-reset] ${plan.decision.reset ? "RESET" : "wait"}: ${summary}. ${plan.decision.reason}`;
			if (line !== lastReason) ns.print(line);
			lastReason = line;

			// Tell the player (terminal line + toast) about new affordable augments and a switch to RESET.
			const ready = [...plan.queued, ...plan.affordable];
			const fresh = seen ? plan.affordable.filter((aug) => !seen.has(aug)) : [];
			if (fresh.length > 0) notify(ns, `New aug${fresh.length > 1 ? "s" : ""} affordable: ${fresh.join(", ")} (${ready.length} ready)`, "info");
			seen = new Set([...(seen ?? []), ...ready]);
			if (plan.decision.reset && !lastReset) notify(ns, `Reset advice is now RESET: ${plan.decision.reason}`, "success");
			lastReset = plan.decision.reset;
			if (plan.decision.reset) {
				if (flags.dry) {
					ns.print("[auto-reset] would reset now (--dry, not doing it)");
				} else {
					ns.toast(`Resetting: ${plan.decision.reason}`, "warning", 10_000);
					await resetNow(ns);
					return;
				}
			}
		}
		await ns.sleep(CONFIG.checkMinutes * 60_000);
	}
}

/** A terminal line and a toast (both 0GB). */
function notify(ns, message, variant) {
	ns.tprint(`auto-reset: ${message}`);
	ns.toast(message, variant, null); // sticky until clicked: these need acting on
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
	ns.exec(CONFIG.installer, "home", 1, "--force", CONFIG.afterReset); // --force: the check just ran
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
		return plan.checkedAt >= askedAt ? plan : null;
	} catch {
		return null;
	}
}
