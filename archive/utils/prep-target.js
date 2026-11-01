/** @param {NS} ns */
export async function prepTarget(ns, target) {
	let sec = ns.getServerSecurityLevel(target);
	let minSec = ns.getServerMinSecurityLevel(target);
	let money = ns.getServerMoneyAvailable(target);
	let maxMoney = ns.getServerMaxMoney(target);

	const servers = getAllServers(ns);
	let host = servers.find(s => ns.hasRootAccess(s) && (ns.getServerMaxRam(s) - ns.getServerUsedRam(s)) > 10) || "home";

	if (sec > minSec) {
		let threads = Math.ceil((sec - minSec) / 0.05);
		ns.exec("/workers/weaken.js", host, threads, target, 0);
		await ns.asleep(ns.getWeakenTime(target) + 200);
	} else if (money < maxMoney) {
		let threads = Math.ceil(ns.growthAnalyze(target, maxMoney / Math.max(money, 100)));
		ns.exec("/workers/grow.js", host, threads, target, 0);
		await ns.asleep(ns.getGrowTime(target) + 200);
	}
}