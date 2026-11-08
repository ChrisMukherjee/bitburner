// Design: docs/aug-reset.md
// @ts-check
const PLAN_FILE = "data/aug-plan.json";
const RESET_LOG = "data/reset-log.json"; // one line per install, for singularity/reset-log.js (tuning the reset rule)
const RESET_LOG_KEEP = 40;
const PLANNER = "singularity/buy-augs.js";
const PLAN_FRESH_MS = 5 * 60_000; // a plan this new (e.g. buy-augs.js just ran) is used as it is
// Run with --once --spend-all just before installing: home upgrades survive an install, cash doesn't.
const HOME_BUYERS = ["singularity/upgrade-home-ram.js", "singularity/upgrade-home-cores.js"];

/**
 * Installs the augments you've bought, which resets the run (money, servers, scripts).
 *
 * Safeguard: it checks the reset advice in data/aug-plan.json (the same rule `augs` and
 * auto-reset.js use) and refuses unless it says RESET. A plan from the last 5 minutes (and
 * from this run) is used as it is (buy-augs.js and its buyer keep it up to date); otherwise
 * it runs buy-augs.js --plan first, which needs room on home (about 30GB). It also refuses when useful augments
 * are affordable but not bought yet (run buy-augs.js first), and when nothing is bought.
 * --force skips the check (auto-reset.js passes it, since it has just decided and bought).
 *
 * Before installing it spends the cash that's left on home RAM, then home cores (both buyers
 * with --once --spend-all, about 7GB and 9GB), since home upgrades survive the install. Both stop at
 * the cap in homeUpgrades (a challenge), if one is set. Run
 * buy-augs.js first so augments get the money before home does (it leaves NeuroFlux
 * to home when a home upgrade is affordable).
 *
 *   run singularity/install-augs.js                        install, nothing runs afterwards
 *   run singularity/install-augs.js startup.js             install, then run that script on home
 *   run singularity/install-augs.js --force [startup.js]   install without the check
 *   run singularity/install-augs.js --keep-cash ...        don't spend the cash on home first
 *
 * The script after the reset gets no arguments and 1 thread. If the game refuses the install
 * (nothing bought, even with --force), that script is started right away instead, since
 * auto-reset.js has stopped everything on home by then.
 */
/** @param {NS} ns */
export async function main(ns) {
	const flags = ns.flags([["force", false], ["keep-cash", false]]);
	const afterReset = flags._[0];
	if (afterReset !== undefined && !ns.fileExists(afterReset, "home")) {
		ns.tprint(`${afterReset} isn't on home, not installing.`);
		return;
	}
	if (!flags.force && !await resetAdvised(ns)) return;
	if (!flags["keep-cash"]) {
		for (const script of HOME_BUYERS) {
			if (!await runAndWait(ns, script, "--once", "--spend-all")) {
				ns.tprint(`No room on home for ${script} (${ns.format.ram(ns.getScriptRam(script))}); its cash is left unspent.`);
			}
		}
	}
	recordReset(ns);
	ns.tprint("Installing augments...");
	// The game returns false when nothing is bought (typed void, but v3.0.0 does); a real install ends this script.
	// @ts-expect-error installAugmentations is typed void but returns false when nothing is bought
	if (ns.singularity.installAugmentations(afterReset) === false) {
		ns.tprint("Not installed: no augments are bought, so there is nothing to install.");
		if (afterReset !== undefined && ns.exec(afterReset, "home", 1) !== 0) ns.tprint(`Started ${afterReset} again instead.`);
	}
}

/** Checks the plan (running the planner if it's old) and prints why not, if the rule says to wait. */
async function resetAdvised(ns) {
	let plan = readPlan(ns);
	// A plan from before the last install belongs to the previous run, however new it is.
	const stale = !plan || Date.now() - plan.checkedAt > PLAN_FRESH_MS || plan.checkedAt < ns.getResetInfo().lastAugReset;
	if (stale) {
		const askedAt = Date.now();
		if (!await runAndWait(ns, PLANNER, "--plan")) {
			ns.tprint(`Not installing: no room on home for ${PLANNER} (${ns.format.ram(ns.getScriptRam(PLANNER))}) to check the reset advice. Free some RAM, or use --force.`);
			return false;
		}
		plan = readPlan(ns);
		if (!plan || plan.checkedAt < askedAt) {
			ns.tprint(`Not installing: ${PLANNER} --plan didn't write a fresh ${PLAN_FILE}. Use --force to install anyway.`);
			return false;
		}
	}
	if (plan.affordable.length > 0) {
		ns.tprint(`WARNING: ${plan.affordable.length} useful augment(s) affordable but not bought: ${plan.affordable.join(", ")}.`);
		ns.tprint(`Not installing: run ${PLANNER} first to buy them (or --force to install without them).`);
		return false;
	}
	if (plan.queued.length === 0) {
		ns.tprint("Not installing: no augments bought, so the install would do nothing.");
		return false;
	}
	if (!plan.decision.reset) {
		ns.tprint(`Not installing, the reset advice is WAIT: ${plan.decision.reason}`);
		ns.tprint("Use --force to install anyway.");
		return false;
	}
	ns.tprint(`Reset advice: ${plan.decision.reason}`);
	return true;
}

/**
 * Appends what the reset rule saw at this install to data/reset-log.json: run length, what was bought,
 * the batch's value and value per hour, the best later moment it was weighing and the income then.
 * singularity/reset-log.js prints it, so the rule's settings can be compared with real runs.
 */
function recordReset(ns) {
	try {
		const plan = readPlan(ns);
		const lastAugReset = ns.getResetInfo().lastAugReset;
		let history = [];
		try { history = JSON.parse(ns.read(RESET_LOG) || "[]"); } catch { history = []; }
		const samples = plan?.incomeHistory?.samples ?? [];
		const current = plan && plan.checkedAt >= lastAugReset; // a plan from before the last install describes the previous run
		history.push({
			at: Date.now(),
			runMinutes: Math.round((Date.now() - lastAugReset) / 60000),
			bought: plan?.queued?.length ?? 0,
			value: current ? plan.decision.value : null,
			rate: current ? plan.decision.rate : null,
			best: current ? plan.decision.best : null,
			reason: current ? plan.decision.reason : null,
			income: samples.length > 0 ? samples[samples.length - 1][1] : null,
		});
		ns.write(RESET_LOG, JSON.stringify(history.slice(-RESET_LOG_KEEP)), "w");
	} catch { /* a log problem must never stop an install */ }
}

/** The plan file with a decision in it, or null. */
function readPlan(ns) {
	try {
		const plan = JSON.parse(ns.read(PLAN_FILE));
		return plan?.decision ? plan : null;
	} catch {
		return null;
	}
}

/** Runs a script on home and waits for it to finish. False if it couldn't start. */
async function runAndWait(ns, script, ...args) {
	const pid = ns.exec(script, "home", 1, ...args);
	if (pid === 0) return false;
	while (ns.isRunning(pid)) await ns.sleep(200);
	return true;
}
