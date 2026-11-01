/** @param {NS} ns **/
export async function main(ns) {
	ns.disableLog("ALL");

	let previousMoney = ns.getServerMoneyAvailable("home");
	let intervalSeconds = 10;

	ns.tprint("Tracking income velocity... Open tail window to view rates.");

	while (true) {
		await ns.sleep(intervalSeconds * 1000);
		let currentMoney = ns.getServerMoneyAvailable("home");
		let diff = currentMoney - previousMoney;

		// Calculate per-minute rate
		let perMinute = diff * (60 / intervalSeconds);

		ns.print(`Net change over ${intervalSeconds}s: ${ns.format.number(diff)} | Rate: ${ns.format.number(perMinute)}/min`);
		previousMoney = currentMoney;
	}
}