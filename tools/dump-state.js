// @ts-check
/** @param {NS} ns **/
import { getAllServers } from "/utils/get-all-servers.js";
import { isHackable, estimateAtMinSecurity, scoreTarget } from "/utils/targets.js";
import { readIncomeRate } from "/utils/income.js";

// Prints a snapshot of the game state to the terminal so it can be pasted into a chat.
export async function main(ns) {
	const allServers = getAllServers(ns);
	const purchasedNames = new Set(ns.cloud.getServerNames());

	let totalMaxRam = 0;
	let totalUsedRam = 0;
	let totalProcesses = 0;
	let rootedCount = 0;
	const purchasedRams = [];

	for (const server of allServers) {
		if (!ns.hasRootAccess(server)) continue;
		rootedCount++;
		const maxRam = ns.getServerMaxRam(server);
		totalMaxRam += maxRam;
		totalUsedRam += ns.getServerUsedRam(server);
		totalProcesses += ns.ps(server).length;
		if (purchasedNames.has(server)) purchasedRams.push(maxRam);
	}

	const expPerSecond = ns.getTotalScriptIncome()[1];
	const income = readIncomeRate(ns); // batcher hacks don't show in getTotalScriptIncome
	const portTools = ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe", "HTTPWorm.exe", "SQLInject.exe"]
		.filter((tool) => ns.fileExists(tool, "home"));

	ns.tprint("=== STATE DUMP ===");
	ns.tprint(`Hacking level: ${ns.getHackingLevel()}`);
	ns.tprint(`Player money: ${ns.format.number(ns.getPlayer().money)}`);
	ns.tprint(`Home: ${ns.getServerMaxRam("home")} GB, ${ns.getServer("home").cpuCores} cores`);
	ns.tprint(`Formulas.exe: ${ns.fileExists("Formulas.exe", "home")}`);
	ns.tprint(`Port tools owned: ${portTools.length} (${portTools.join(", ")})`);
	ns.tprint(`Servers total / rooted: ${allServers.length} / ${rootedCount}`);
	ns.tprint(`Total RAM (rooted): ${totalMaxRam} GB, used ${totalUsedRam.toFixed(0)} GB, processes running ${totalProcesses}`);
	ns.tprint(`Purchased servers: ${purchasedRams.length} / ${ns.cloud.getServerLimit()}, RAM each: ${purchasedRams.join(", ")}`);
	ns.tprint(`Income: ${ns.format.number(income.perSecond)}/s (${income.source}), ${expPerSecond.toFixed(1)} hack xp/s from running scripts`);

	// Ranked the same way the batcher ranks them (utils/targets.js), with times and chance at min security
	const hackingLevel = ns.getHackingLevel();
	const candidates = [];
	for (const server of allServers) {
		if (!isHackable(ns, server, hackingLevel)) continue;
		const estimate = estimateAtMinSecurity(ns, server);
		candidates.push({
			server,
			score: scoreTarget(ns, server, estimate),
			maxMoney: ns.getServerMaxMoney(server),
			requiredLevel: ns.getServerRequiredHackingLevel(server),
			minSecurity: ns.getServerMinSecurityLevel(server),
			growth: ns.getServerGrowth(server),
			weakenSeconds: estimate["weaken"] / 1000,
			hackChance: estimate.chance,
		});
	}
	candidates.sort((a, b) => b.score - a.score);

	ns.tprint("Top targets, batcher ranking (server | maxMoney | reqLevel | minSec | growth | weakenSec@min | hackChance@min):");
	for (const candidate of candidates.slice(0, 12)) {
		ns.tprint(
			`${candidate.server} | ${ns.format.number(candidate.maxMoney)} | ${candidate.requiredLevel} | ` +
			`${candidate.minSecurity} | ${candidate.growth} | ${candidate.weakenSeconds.toFixed(1)} | ` +
			`${candidate.hackChance.toFixed(2)}`
		);
	}
	ns.tprint("=== END DUMP ===");
}