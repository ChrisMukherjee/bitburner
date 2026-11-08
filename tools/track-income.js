// @ts-check
/** @param {NS} ns **/
export async function main(ns) {
	ns.disableLog("ALL");

	const intervalSeconds = 10;
	let previousMoney = ns.getServerMoneyAvailable("home");
	let previousHackingIncome = ns.getMoneySources().sinceInstall.hacking;

	ns.tprint("Tracking income velocity... Open tail window to view rates.");

	while (true) {
		await ns.sleep(intervalSeconds * 1000);

		const currentMoney = ns.getServerMoneyAvailable("home");
		const currentHackingIncome = ns.getMoneySources().sinceInstall.hacking;

		const netChange = currentMoney - previousMoney;
		const hackingChange = currentHackingIncome - previousHackingIncome;

		ns.print(
			`Hacking: ${ns.format.number(hackingChange)}/${intervalSeconds}s ` +
			`(${ns.format.number(hackingChange / intervalSeconds)} per sec) | ` +
			`Net home change: ${ns.format.number(netChange)}`
		);

		previousMoney = currentMoney;
		previousHackingIncome = currentHackingIncome;
	}
}