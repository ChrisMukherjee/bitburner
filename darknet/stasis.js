import { REPORT_PORT } from "darknet/config.js";

/** @param {NS} ns */
// One-shot on the server it runs on. With no args it applies a stasis link (if there's a free slot under
// the global cap and the server isn't already linked); with "unlink" it removes the link. A link pins the
// server (it never moves or goes offline) and lets home reach it remotely. Costs 12 GB only while it runs.
export async function main(ns) {
	const self = ns.getHostname();
	const port = ns.getPortHandle(REPORT_PORT);
	const unlink = ns.args[0] === "unlink";

	if (unlink) {
		const result = await ns.dnet.setStasisLink(false);
		port.tryWrite(JSON.stringify({ kind: "unlink", host: self, success: result.success, at: Date.now() }));
		return;
	}

	const linked = ns.dnet.getStasisLinkedServers();
	if (linked.includes(self) || linked.length >= ns.dnet.getStasisLinkLimit()) return;
	const result = await ns.dnet.setStasisLink(true);
	port.tryWrite(JSON.stringify({ kind: "stasis", host: self, success: result.success, at: Date.now() }));
}
