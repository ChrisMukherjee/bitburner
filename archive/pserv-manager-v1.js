/** @param {NS} ns **/
export async function main(ns) {
	ns.disableLog("ALL");

	const serverPrefix = "pserv-";
	const maxServers = ns.cloud.getServerLimit();

	// Standard RAM tiers in GB (powers of 2)
	const tiers = [8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];

	ns.print("Starting Dynamic PServ Hardware Manager...");

	while (true) {
		let money = ns.getServerMoneyAvailable("home");
		let purchasedServers = ns.cloud.getServerNames();

		// Determine the highest RAM tier we can safely afford
		// Requires enough liquid cash to cover a server purchase while maintaining a safety buffer.
		let targetRam = tiers[0];
		for (let tier of tiers) {
			let costPerServer = ns.cloud.getServerCost(tier);
			// Require 2x the cost of a single server as a safety buffer so we don't starve other managers
			if (money >= costPerServer * 2) {
				targetRam = tier;
			} else {
				break;
			}
		}

		// Buy new servers up to the 25 limit if we haven't reached it yet
		if (purchasedServers.length < maxServers) {
			let cost = ns.cloud.getServerCost(targetRam);
			if (money >= cost) {
				let hostname = `${serverPrefix}${purchasedServers.length}`;
				let serverName = ns.cloud.purchaseServer(hostname, targetRam);
				if (serverName) {
					ns.print(`Purchased new server: ${serverName} with ${targetRam}GB RAM.`);
				}
			}
		}

		// Upgrade existing servers if they are below the dynamic target RAM tier
		purchasedServers = ns.cloud.getServerNames(); // Refresh server list
		for (let i = 0; i < purchasedServers.length; i++) {
			let serv = purchasedServers[i];
			let currentRam = ns.getServerMaxRam(serv);

			if (currentRam < targetRam) {
				let upgradeCost = ns.cloud.getServerUpgradeCost(serv, targetRam);
				if (ns.getServerMoneyAvailable("home") >= upgradeCost) {
					if (ns.cloud.upgradeServer(serv, targetRam)) {
						ns.print(`Upgraded ${serv} from ${currentRam}GB to ${targetRam}GB RAM.`);
					}
				}
			}
		}

		// Check every 10 seconds to save CPU cycles
		await ns.sleep(10000);
	}
}