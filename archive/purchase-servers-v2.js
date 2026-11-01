/** @param {NS} ns **/
export async function main(ns) {

	let ram = 8;
	let servers = ns.cloud.getServerNames();

	while (true) {
		for (let i = 0; i < ns.cloud.getServerNames().length; i++) {
			let name = "pserv-" + i;
			while (ns.cloud.getServerCost(ram) > ns.getServerMoneyAvailable("home")) {
				await ns.sleep(3000);
			}
			if (servers.includes(name)) {
				if (ns.getServerMaxRam(name) < ram) {
					ns.killall(name);
					ns.deleteServer(name);
				} else {
					continue;
				}
			}
			ns.purchaseServer(name, ram);
		}

		ram *= 2;
		servers = ns.cloud.getServerNames();
		await ns.sleep(1000);
	}
}