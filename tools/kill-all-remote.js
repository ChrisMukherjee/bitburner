/** @param {NS} ns **/
import { getAllServers } from "/utils/get-all-servers.js";

export async function main(ns) {
	const servers = getAllServers(ns);
	for (let s of servers) {
		if (s === "home") continue; // Keep home safe
		ns.killall(s);
		ns.tprint(`Cleared all processes on: ${s}`);
	}
	ns.tprint("Botnet successfully wiped clean!");
}