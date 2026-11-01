import { REPORT_PORT } from "darknet/config.js";

/** @param {NS} ns */
// A dedicated phishing worker. A crawler launches this on each darknet server it opens, with as many
// threads as the server's free RAM allows, because phishing income scales with threads. Kept tiny so
// each thread is cheap (base + phishingAttack only). It reports each attempt to the manager's port.
export async function main(ns) {
	ns.disableLog("ALL");
	const self = ns.getHostname();
	const port = ns.getPortHandle(REPORT_PORT);
	while (true) {
		const result = await ns.dnet.phishingAttack();
		port.tryWrite(JSON.stringify({ kind: "phish", host: self, success: result.success, at: Date.now() }));
	}
}
