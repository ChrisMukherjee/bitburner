import { getBudget, getCash, formatMoney } from "/utils/spending.js";

const CONFIG = {
	// Cash this manager never touches. Keep it above whatever you are saving for
	// (HTTPWorm.exe, SQLInject.exe, ...) so server upgrades can't block those.
	reserve: 300e6,
	// Largest share of current cash one upgrade may cost.
	maxFraction: 0.40,
	// Time between passes. One server is upgraded per pass at most.
	loopMs: 10_000,
};

/**
 * Upgrades purchased servers IN PLACE (ns.cloud.upgradeServer), so hostnames never change.
 * Never deletes or re-buys. One upgrade per pass, always the smallest server first.
 */
export async function main(ns) {
	ns.disableLog("ALL");
	let lastIdleMessage = "";

	while (true) {
		const result = runPass(ns);

		if (result.finished) {
			ns.print(result.message);
			return;
		}
		// Only print "waiting" messages when they change, so the log doesn't fill with repeats.
		if (result.upgraded || result.message !== lastIdleMessage) {
			ns.print(result.message);
		}
		lastIdleMessage = result.upgraded ? "" : result.message;

		await ns.sleep(CONFIG.loopMs);
	}
}

function runPass(ns) {
	const ramLimit = ns.cloud.getRamLimit();

	// Smallest first; servers already at the limit have nothing left to upgrade.
	const upgradable = ns.cloud
		.getServerNames()
		.map((hostname) => ({ hostname, ram: ns.getServerMaxRam(hostname) }))
		.filter((server) => server.ram < ramLimit)
		.sort((first, second) => first.ram - second.ram);

	if (upgradable.length === 0) {
		return { finished: true, message: "[pserv] every server is at the RAM limit, nothing left to do." };
	}

	const target = upgradable[0];
	const budget = getBudget(ns, CONFIG);

	// Pick the biggest power-of-two tier whose upgrade cost fits the budget.
	// Cost only rises with RAM, so stop at the first tier that is too expensive.
	let bestRam = 0;
	let bestCost = 0;
	for (let tierRam = target.ram * 2; tierRam <= ramLimit; tierRam *= 2) {
		const cost = ns.cloud.getServerUpgradeCost(target.hostname, tierRam);
		if (!Number.isFinite(cost) || cost < 0 || cost > budget) break;
		bestRam = tierRam;
		bestCost = cost;
	}

	if (bestRam === 0) {
		const nextCost = ns.cloud.getServerUpgradeCost(target.hostname, target.ram * 2);
		return {
			upgraded: false,
			message:
				`[pserv] waiting: ${target.hostname} (${ns.format.ram(target.ram)}) -> ` +
				`${ns.format.ram(target.ram * 2)} costs ${formatMoney(ns, nextCost)}, ` +
				`budget ${formatMoney(ns, budget)} (cash ${formatMoney(ns, getCash(ns))}, ` +
				`reserve ${formatMoney(ns, CONFIG.reserve)})`,
		};
	}

	if (!ns.cloud.upgradeServer(target.hostname, bestRam)) {
		return { upgraded: false, message: `[pserv] upgrade of ${target.hostname} to ${ns.format.ram(bestRam)} failed.` };
	}

	return {
		upgraded: true,
		message:
			`[pserv] upgraded ${target.hostname}: ${ns.format.ram(target.ram)} -> ${ns.format.ram(bestRam)} ` +
			`for ${formatMoney(ns, bestCost)}. Cash left: ${formatMoney(ns, getCash(ns))}`,
	};
}