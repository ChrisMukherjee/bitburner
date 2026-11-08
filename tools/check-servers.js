// @ts-check
/** @param {NS} ns **/
export async function main(ns) {
	let servers = ns.cloud.getServerNames();
	let limit = ns.cloud.getServerLimit();
	ns.tprint(`=== Cloud Servers Status (${servers.length}/${limit}) ===`);

	if (servers.length === 0) {
		ns.tprint("No cloud servers purchased yet.");
		return;
	}

	for (let serv of servers) {
		let maxRam = ns.getServerMaxRam(serv);
		ns.tprint(`- ${serv}: ${maxRam} GB`);
	}
}