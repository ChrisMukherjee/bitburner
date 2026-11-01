/** @param {NS} ns **/
export async function main(ns) {
	let ram = 8;
	let servers = ns.getPurchasedServers();

	for (let i = servers.length; i < ns.getPurchasedServerLimit(); i++) {
		let name = "pserv-" + i;
		while (ns.cloud.getServerCost(ram) > ns.getServerMoneyAvailable("home")) {
			await ns.sleep(3000);
		}
		ns.cloud.purchaseServer(name, ram);
	}
}