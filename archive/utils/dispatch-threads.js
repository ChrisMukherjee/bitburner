/** @param {NS} ns */
export function dispatchThreads(ns, target, script, totalThreads, delay) {
	const servers = getAllServers(ns);
	let remaining = totalThreads;

	for (let s of servers) {
		if (remaining <= 0) break;
		let serverObj = ns.getServer(s);
		if (!serverObj.hasAdminRights) continue;

		let freeRam = ns.getServerMaxRam(s) - ns.getServerUsedRam(s);
		let scriptRam = ns.getScriptRam(script);
		let possibleThreads = Math.floor(freeRam / scriptRam);

		if (possibleThreads > 0) {
			let threadsToRun = Math.min(remaining, possibleThreads);
			ns.exec(script, s, threadsToRun, target, delay);
			remaining -= threadsToRun;
		}
	}
}