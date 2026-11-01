import { notify } from "/utils/notify.js";
import { createPolicyTracker, getBudget, getCash, formatMoney } from "/utils/spending.js";

/**
 * Shared loop for the home RAM and home cores buyers. It references no singularity
 * functions itself: each entry script passes its own costOf/doUpgrade, so the static
 * RAM check only charges that script for the two functions it really uses.
 *
 *   label      - log prefix, e.g. "home-ram"
 *   stages     - spending stages for createPolicyTracker (see utils/spending.js)
 *   loopMs     - time between passes
 *   costOf     - () => cost of the next upgrade
 *   doUpgrade  - () => true if the upgrade went through
 *   describe   - optional () => current level, e.g. "64GB", for the log (cores can't be
 *                read without the 2GB getServer, so the cores buyer leaves it out)
 *   onUpgrade  - optional () => called after each upgrade that went through
 *   afterPass  - optional () => called at the end of every pass (and before exiting)
 *
 * Flags: --once buys whatever the budget allows right now, then exits (handy while home
 * RAM is too small to keep a loop running).
 */
export async function runUpgradeLoop(ns, options) {
	ns.disableLog("ALL");
	const flags = ns.flags([["once", false]]);
	const getPolicy = createPolicyTracker(options.stages);
	const tag = `[${options.label}]`;
	let lastStageName = "";
	let lastIdleMessage = "";

	while (true) {
		const policy = getPolicy(ns);
		if (policy.name !== lastStageName) {
			ns.print(
				`${tag} stage "${policy.name}": reserve ${formatMoney(ns, policy.reserve)}, ` +
				`max ${ns.format.percent(policy.maxFraction)} of cash per upgrade`
			);
			lastStageName = policy.name;
		}

		// Buy as many levels in a row as the budget allows; the budget is re-read each time.
		let bought = 0;
		while (true) {
			const cost = options.costOf();
			const level = options.describe ? options.describe() : "";
			const budget = getBudget(ns, policy);
			if (!Number.isFinite(cost) || cost > budget) {
				const message =
					`${tag} waiting: next upgrade${level ? ` from ${level}` : ""} costs ${formatMoney(ns, cost)}, ` +
					`budget ${formatMoney(ns, budget)} (cash ${formatMoney(ns, getCash(ns))}, ` +
					`reserve ${formatMoney(ns, policy.reserve)})`;
				if (bought > 0 || message !== lastIdleMessage) ns.print(message);
				lastIdleMessage = message;
				break;
			}
			if (!options.doUpgrade()) {
				// It was affordable, so a refusal means home is already at the maximum.
				notify(ns, tag, `home is maxed${level ? ` (${level})` : ""}, nothing left to do.`, "success");
				if (options.afterPass) options.afterPass();
				return;
			}
			bought++;
			const change = level ? `${level} -> ${options.describe()}` : "one level";
			notify(ns, tag, `upgraded ${change} for ${formatMoney(ns, cost)}`, "success");
			if (options.onUpgrade) options.onUpgrade();
		}

		if (options.afterPass) options.afterPass();
		if (flags.once) return;
		await ns.sleep(options.loopMs);
	}
}
