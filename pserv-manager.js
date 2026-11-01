import { notify } from "/utils/notify.js";
import { createPolicyTracker, getBudget, getCash, formatMoney } from "/utils/spending.js";

const CONFIG = {
	// Spending rules get stricter as income grows. A stage applies once your running
	// scripts earn at least minIncome ($/s); it never loosens again until you restart.
	//   reserve     - cash this manager never touches (raise it above what you're saving for,
	//                 e.g. HTTPWorm.exe / SQLInject.exe, so they are never blocked)
	//   maxFraction - largest share of current cash one purchase may cost
	stages: [
		{ name: "early", minIncome: 0, reserve: 1e6, maxFraction: 0.75 },
		{ name: "growing", minIncome: 1e5, reserve: 30e6, maxFraction: 0.50 },
		{ name: "established", minIncome: 1e7, reserve: 300e6, maxFraction: 0.40 },
		{ name: "late", minIncome: 1e8, reserve: 1e9, maxFraction: 0.25 },
	],
	// Time between passes. At most one server is bought or upgraded per pass.
	loopMs: 10_000,
	// After a prestige your servers are gone, so free slots get refilled first.
	namePrefix: "pserv-",
	minNewServerRam: 8,
};

/**
 * Keeps the purchased-server fleet growing:
 *   1. free slot  -> buy a new server (the biggest tier the budget allows)
 *   2. otherwise  -> upgrade the SMALLEST server IN PLACE (ns.cloud.upgradeServer),
 *                    so hostnames never change. Servers are never deleted or re-bought.
 * One purchase per pass, always within the stage's budget.
 */
export async function main(ns) {
	ns.disableLog("ALL");
	const getPolicy = createPolicyTracker(CONFIG.stages);
	let lastStageName = "";
	let lastIdleMessage = "";

	while (true) {
		const policy = getPolicy(ns);
		if (policy.name !== lastStageName) {
			ns.print(
				`[pserv] stage "${policy.name}": reserve ${formatMoney(ns, policy.reserve)}, ` +
				`max ${ns.format.percent(policy.maxFraction)} of cash per purchase`
			);
			lastStageName = policy.name;
		}

		const result = runPass(ns, policy);

		if (result.finished) {
			notify(ns, "[pserv]", result.message.replace(/^\[pserv\] /, ""), "success");
			return;
		}
		// Only print "waiting" messages when they change, so the log doesn't fill with repeats.
		if (result.acted || result.message !== lastIdleMessage) ns.print(result.message);
		lastIdleMessage = result.acted ? "" : result.message;

		await ns.sleep(CONFIG.loopMs);
	}
}

function runPass(ns, policy) {
	const ramLimit = ns.cloud.getRamLimit();
	const hostnames = ns.cloud.getServerNames();
	const budget = getBudget(ns, policy);

	if (hostnames.length < ns.cloud.getServerLimit()) {
		return buyNewServer(ns, policy, hostnames, ramLimit, budget);
	}
	return upgradeSmallestServer(ns, policy, hostnames, ramLimit, budget);
}

/**
 * Biggest power-of-two tier (starting at firstRam) whose cost fits the budget, or null.
 * Cost only rises with RAM, so stop at the first tier that is too expensive.
 */
function findBestTier(firstRam, ramLimit, budget, getCost) {
	let best = null;
	for (let tierRam = firstRam; tierRam <= ramLimit; tierRam *= 2) {
		const cost = getCost(tierRam);
		if (!Number.isFinite(cost) || cost < 0 || cost > budget) break;
		best = { ram: tierRam, cost };
	}
	return best;
}

function buyNewServer(ns, policy, hostnames, ramLimit, budget) {
	const tier = findBestTier(CONFIG.minNewServerRam, ramLimit, budget, (ram) => ns.cloud.getServerCost(ram));

	if (!tier) {
		const minCost = ns.cloud.getServerCost(CONFIG.minNewServerRam);
		return {
			acted: false,
			message:
				`[pserv] waiting: new server (${ns.format.ram(CONFIG.minNewServerRam)}) costs ${formatMoney(ns, minCost)}, ` +
				describeBudget(ns, policy, budget),
		};
	}

	const taken = new Set(hostnames);
	let serverNumber = 0;
	while (taken.has(`${CONFIG.namePrefix}${serverNumber}`)) serverNumber++;
	const name = `${CONFIG.namePrefix}${serverNumber}`;

	// purchaseServer returns the hostname, or "" on failure.
	if (ns.cloud.purchaseServer(name, tier.ram) === "") {
		return { acted: false, message: `[pserv] purchase of ${name} (${ns.format.ram(tier.ram)}) failed.` };
	}
	return {
		acted: true,
		message:
			`[pserv] bought ${name} (${ns.format.ram(tier.ram)}) for ${formatMoney(ns, tier.cost)}. ` +
			`Cash left: ${formatMoney(ns, getCash(ns))}`,
	};
}

function upgradeSmallestServer(ns, policy, hostnames, ramLimit, budget) {
	// Smallest first; servers already at the limit have nothing left to upgrade.
	const upgradable = hostnames
		.map((hostname) => ({ hostname, ram: ns.getServerMaxRam(hostname) }))
		.filter((server) => server.ram < ramLimit)
		.sort((first, second) => first.ram - second.ram);

	if (upgradable.length === 0) {
		return { finished: true, message: "[pserv] every server is at the RAM limit, nothing left to do." };
	}

	const target = upgradable[0];
	const tier = findBestTier(target.ram * 2, ramLimit, budget, (ram) =>
		ns.cloud.getServerUpgradeCost(target.hostname, ram)
	);

	if (!tier) {
		const nextCost = ns.cloud.getServerUpgradeCost(target.hostname, target.ram * 2);
		return {
			acted: false,
			message:
				`[pserv] waiting: ${target.hostname} (${ns.format.ram(target.ram)}) -> ` +
				`${ns.format.ram(target.ram * 2)} costs ${formatMoney(ns, nextCost)}, ` +
				describeBudget(ns, policy, budget),
		};
	}

	if (!ns.cloud.upgradeServer(target.hostname, tier.ram)) {
		return { acted: false, message: `[pserv] upgrade of ${target.hostname} to ${ns.format.ram(tier.ram)} failed.` };
	}
	return {
		acted: true,
		message:
			`[pserv] upgraded ${target.hostname}: ${ns.format.ram(target.ram)} -> ${ns.format.ram(tier.ram)} ` +
			`for ${formatMoney(ns, tier.cost)}. Cash left: ${formatMoney(ns, getCash(ns))}`,
	};
}

function describeBudget(ns, policy, budget) {
	return (
		`budget ${formatMoney(ns, budget)} (cash ${formatMoney(ns, getCash(ns))}, ` +
		`reserve ${formatMoney(ns, policy.reserve)})`
	);
}
