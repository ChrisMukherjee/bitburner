/** @param {NS} ns **/
export async function main(ns) {
	ns.disableLog("ALL");

	// Launch Hacknet Manager (background passive income)
	if (ns.fileExists("hacknet-manager.js", "home")) {
		if (!ns.isRunning("hacknet-manager.js", "home")) {
			ns.run("hacknet-manager.js");
			ns.print("Launched hacknet-manager.js");
		}
	}

	// Launch PServ Manager
	if (ns.fileExists("pserv-manager.js", "home")) {
		if (!ns.isRunning("pserv-manager.js", "home")) {
			ns.run("pserv-manager.js");
			ns.print("Launched pserv-manager.js");
		}
	}

	// Launch your main orchestrator / hacking manager
	if (ns.fileExists("hack-manager.js", "home")) {
		if (!ns.isRunning("hack-manager.js", "home")) {
			ns.run("hack-manager.js");
			ns.print("Launched hack-manager.js");
		}
	}

	ns.tprint("Startup sequence complete. All automation managers active.");
}