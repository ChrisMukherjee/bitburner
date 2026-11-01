const CONFIG = {
	faction: "Tian Di Hui",
	city: "Chongqing", // Chongqing, New Tokyo or Ishima all work
	inviteCities: ["Chongqing", "New Tokyo", "Ishima"],
	minHacking: 50,
	minMoney: 1e6,
	travelCost: 200e3,
	loopMs: 30_000,
};

/**
 * Gets the Tian Di Hui invite: once you have hacking 50 and $1.2m (the invite needs $1m,
 * the flight is $200k), flies to Chongqing and waits there until you've joined. It's not a
 * city faction, so it locks nobody out. Its Neuroreceptor Manager (75k rep) removes the
 * penalty for unfocused work. Needs join-factions.js running to accept the invite; then
 * faction-work.js works for it right after CyberSec.
 *
 *   run singularity/get-tian-di-hui.js
 */
export async function main(ns) {
	ns.disableLog("ALL");
	let lastMessage = "";

	while (true) {
		const player = ns.getPlayer();
		let message;
		if (player.factions.includes(CONFIG.faction)) {
			ns.print(`[tdh] joined ${CONFIG.faction}, done.`);
			return;
		}
		if (CONFIG.inviteCities.includes(player.city)) {
			message = `[tdh] in ${player.city}, waiting for the invite (keep $1m and hacking ${CONFIG.minHacking})`;
		} else if (player.skills.hacking < CONFIG.minHacking) {
			message = `[tdh] waiting for hacking ${CONFIG.minHacking} (now ${player.skills.hacking})`;
		} else if (player.money < CONFIG.minMoney + CONFIG.travelCost) {
			message = `[tdh] waiting for $${ns.format.number(CONFIG.minMoney + CONFIG.travelCost)}`;
		} else if (ns.singularity.travelToCity(CONFIG.city)) {
			message = `[tdh] flew to ${CONFIG.city}`;
		} else {
			message = `[tdh] flight to ${CONFIG.city} failed, will retry`;
		}
		if (message !== lastMessage) ns.print(message);
		lastMessage = message;
		await ns.sleep(CONFIG.loopMs);
	}
}
