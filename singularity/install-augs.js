const PLAN_FILE = "data/aug-plan.json";
const PLANNER = "singularity/buy-augs.js";

/**
 * Installs the augments you've bought, which resets the run (money, servers, scripts).
 *
 * Safeguard: first it runs buy-augs.js --plan (the same reset rule `augs` and auto-reset.js
 * use) and refuses unless that says RESET. It also refuses when useful augments are
 * affordable but not bought yet (run buy-augs.js first), and when nothing is bought.
 * --force skips the check (auto-reset.js passes it, since it has just decided and bought).
 * The check needs room for buy-augs.js on home (about 29GB); without it, it refuses too.
 *
 *   run singularity/install-augs.js                        install, nothing runs afterwards
 *   run singularity/install-augs.js startup.js             install, then run that script on home
 *   run singularity/install-augs.js --force [startup.js]   install without the check
 *
 * The script after the reset gets no arguments and 1 thread.
 */
export async function main(ns) {
	const flags = ns.flags([["force", false]]);
	const afterReset = flags._[0];
	if (afterReset !== undefined && !ns.fileExists(afterReset, "home")) {
		ns.tprint(`${afterReset} isn't on home, not installing.`);
		return;
	}
	if (!flags.force && !await resetAdvised(ns)) return;
	ns.tprint("Installing augments...");
	ns.singularity.installAugmentations(afterReset);
}

/** Runs the planner and prints why not, if the reset rule says to wait. */
async function resetAdvised(ns) {
	const askedAt = Date.now();
	const pid = ns.exec(PLANNER, "home", 1, "--plan");
	if (pid === 0) {
		ns.tprint(`Not installing: no room on home for ${PLANNER} (${ns.format.ram(ns.getScriptRam(PLANNER))}) to check the reset advice. Free some RAM, or use --force.`);
		return false;
	}
	while (ns.isRunning(pid)) await ns.sleep(200);
	let plan = null;
	try {
		plan = JSON.parse(ns.read(PLAN_FILE));
	} catch { /* handled below */ }
	if (!plan?.decision || plan.checkedAt < askedAt) {
		ns.tprint(`Not installing: ${PLANNER} --plan didn't write a fresh ${PLAN_FILE}. Use --force to install anyway.`);
		return false;
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
