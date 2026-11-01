// Megacorps to work at, in order, with the faction each job unlocks. The faction invite
// needs 400k company rep (300k once the company's server is backdoored), plus for Fulcrum
// a backdoor on fulcrumassets. The order matches faction-work.js: cheapest goals first.
const COMPANIES = [
	{ company: "Bachman & Associates", faction: "Bachman & Associates" },
	{ company: "Clarke Incorporated", faction: "Clarke Incorporated" },
	{ company: "Blade Industries", faction: "Blade Industries" },
	{ company: "OmniTek Incorporated", faction: "OmniTek Incorporated" },
	{ company: "NWO", faction: "NWO" },
	{ company: "ECorp", faction: "ECorp" },
	{ company: "Fulcrum Technologies", faction: "Fulcrum Secret Technologies" },
];

const CONFIG = {
	field: "Software", // promotions here depend on hacking (and charisma)
	repNeeded: 400_000,
	minHackLevel: 75,
	loopMs: 60_000,
};

/**
 * Works a Software job at the first megacorp whose faction you haven't joined yet, until
 * its invite arrives (join-factions.js accepts it). Asks for a promotion every pass.
 *
 * Faction work comes first: while faction-work.js has a faction to work for, this script
 * waits, and it also leaves studying alone below hacking 75. So company work fills the
 * gaps when every joined faction is at its goal.
 *
 *   run singularity/company-work.js           unfocused (80% speed)
 *   run singularity/company-work.js --focus   focused (full speed, takes over the screen)
 */
export async function main(ns) {
	ns.disableLog("ALL");
	const flags = ns.flags([["focus", false]]);
	let lastMessage = "";

	while (true) {
		const player = ns.getPlayer();
		const joined = new Set(player.factions);
		const open = COMPANIES.filter((entry) =>
			!joined.has(entry.faction) && ns.singularity.getCompanyRep(entry.company) < CONFIG.repNeeded
		);
		if (open.length === 0) {
			ns.print("[company-work] every megacorp faction is joined (or at the rep needed), done.");
			return;
		}

		const current = ns.singularity.getCurrentWork();
		let message;
		if (current?.type === "FACTION") {
			message = `[company-work] faction work for ${current.factionName} comes first, waiting`;
		} else if (current?.type === "CLASS" && player.skills.hacking < CONFIG.minHackLevel) {
			message = `[company-work] hacking ${player.skills.hacking} < ${CONFIG.minHackLevel}, leaving study alone`;
		} else {
			const target = open[0];
			const newJob = ns.singularity.applyToCompany(target.company, CONFIG.field); // hire or promote
			if (newJob) ns.print(`[company-work] ${target.company}: now ${newJob}`);
			if (!(target.company in player.jobs) && !newJob) {
				message = `[company-work] ${target.company} won't hire you for ${CONFIG.field} yet (needs more hacking or charisma)`;
			} else {
				const working = current?.type === "COMPANY" && current.companyName === target.company;
				if (!working || newJob) ns.singularity.workForCompany(target.company, flags.focus);
				const rep = ns.singularity.getCompanyRep(target.company);
				message = `[company-work] ${target.company}: ${ns.format.number(rep)} / ${ns.format.number(CONFIG.repNeeded)} rep`;
			}
		}
		if (message !== lastMessage) ns.print(message);
		lastMessage = message;

		await ns.sleep(CONFIG.loopMs);
	}
}
