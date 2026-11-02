// Design: docs/aug-reset.md
const CONFIG = {
	checkMinutes: 10,
	afterReset: "startup.js", // run on home after the install
	planFile: "data/aug-plan.json",
	planner: "singularity/buy-augs.js",
	stockTrader: "stocks/stock-trader.js", // sold out before buying (the reset wipes held shares)
	installer: "singularity/install-augs.js",
};

/**
 * Decides when to reset. Every 10 minutes it runs buy-augs.js --plan (about 30GB, for a
 * moment), which works out what you could buy and applies the reset rule in buy-augs.js
 * (decideReset): the same rule `augs` (buy-augs --dry) prints, so the two always agree.
 * When the rule says reset, it stops every other script on home, buys with buy-augs.js,
 * and installs with install-augs.js, which starts startup.js after the reset.
 *
 * The rule, in short: reset at the moment that gives the most augment value per hour of the
 * run, comparing now with forecasts up to 6 hours ahead; The Red Pill resets at once; and
 * around Daedalus it either keeps working for The Red Pill or resets for 150 favor so the
 * next run can buy its rep with money. Design: docs/aug-reset.md.
 *
 * Before buying it sells every stock position (stock-trader.js --liquidate): the reset
 * wipes held shares, so their value would otherwise be lost.
 *
 * This script itself is small (about 4GB); the planner only fits when home has 30GB free,
 * otherwise that check is skipped and logged.
 *
 *   run singularity/auto-reset.js               watch and reset when the rule says so
 *   run singularity/auto-reset.js --dry         only log what it would do
 *
 * It prints a terminal line and a toast when a new useful augment becomes affordable, and
 * when the advice switches to RESET (also with --dry).
 */
export async function main(ns) {
	ns.disableLog("ALL");
	const flags = ns.flags([["dry", false]]);

	let lastReason = "";
	let seen = null;          // augments already ready (bought or affordable); null until the first plan
	let lastReset = false;    // whether the last advice was RESET
	while (true) {
		const askedAt = Date.now();
		const ran = await runAndWait(ns, CONFIG.planner, "--plan");
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

/** Frees home for the buyer, sells stocks, buys, then installs (the install ends this script too). */
async function resetNow(ns) {
	for (const proc of ns.ps("home")) {
		if (proc.pid !== ns.pid) ns.kill(proc.pid);
	}
	// A stock trader left running elsewhere would buy back in after the sell-off.
	for (const host of allServers(ns)) {
		for (const proc of ns.ps(host)) if (proc.filename === CONFIG.stockTrader) ns.kill(proc.pid);
	}
	if (ns.fileExists(CONFIG.stockTrader, "home") && !await runAndWait(ns, CONFIG.stockTrader, "--liquidate", "--no-buy-tix")) {
		ns.tprint(`auto-reset: couldn't run ${CONFIG.stockTrader} --liquidate; any stock positions will be lost.`);
	}
	if (!await runAndWait(ns, CONFIG.planner)) {
		ns.tprint(`auto-reset: couldn't run ${CONFIG.planner} even on an empty home. Not installing.`);
		return;
	}
	ns.exec(CONFIG.installer, "home", 1, "--force", CONFIG.afterReset); // --force: the check just ran
}

/** Every server reachable from home (purchased ones included). */
function allServers(ns) {
	const seen = new Set(["home"]);
	for (const host of seen) for (const next of ns.scan(host)) seen.add(next);
	return [...seen];
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
