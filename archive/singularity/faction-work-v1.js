// Factions in the order to work for them, with the rep that unlocks every augment worth
// buying there (base costs from the game source; "worth it" = boosts hacking, hacknet or
// rep gain). Augments sold by an earlier faction in the list are left to that one, e.g.
// DataJack is bought from The Black Hand, not NiteSec. MegaCorp, Four Sigma and KuaiGong
// sell nothing extra of that kind, so they aren't here.
const GOALS = [
	{ faction: "Daedalus", rep: 2_500_000 },       // The Red Pill: needed to finish the BitNode
	{ faction: "CyberSec", rep: 18_750 },          // Cranial Signal Processors Gen II
	{ faction: "Netburners", rep: 12_500 },        // Hacknet Node Core Direct-Neural Interface
	{ faction: "Tian Di Hui", rep: 75_000 },       // Neuroreceptor Manager (no unfocused penalty)
	{ faction: "NiteSec", rep: 50_000 },           // Cranial Signal Processors Gen III
	{ faction: "The Black Hand", rep: 125_000 },   // Cranial Signal Processors Gen IV, DataJack
	{ faction: "BitRunners", rep: 1_000_000 },     // ENM Core V2, Neurolink
	// Megacorps: invites need company rep from a job there (400k, 300k with the backdoor).
	{ faction: "Bachman & Associates", rep: 375_000 },        // SmartJaw
	{ faction: "Clarke Incorporated", rep: 437_500 },         // nextSENS Gene Modification
	{ faction: "Blade Industries", rep: 500_000 },            // PC Direct-Neural Interface Optimization Submodule
	{ faction: "OmniTek Incorporated", rep: 625_000 },        // OmniTek InfoLoad
	{ faction: "NWO", rep: 875_000 },                         // Xanipher
	{ faction: "ECorp", rep: 1_500_000 },                     // ECorp HVMind Implant
	{ faction: "Fulcrum Secret Technologies", rep: 1_500_000 }, // PC Direct-Neural Interface NeuroNet Injector
];

const CONFIG = {
	minHackLevel: 75, // below this, leave the player studying (study.js)
	loopMs: 60_000,
};

/**
 * Keeps the player doing hacking contracts for the first joined faction still below its
 * rep goal. Doesn't touch work while hacking is below minHackLevel, so study.js can run
 * first. Exits once every goal faction is joined and at its goal.
 *
 *   run singularity/faction-work.js           unfocused (80% speed, you keep the screen)
 *   run singularity/faction-work.js --focus   focused (full speed, takes over the screen)
 */
export async function main(ns) {
	ns.disableLog("ALL");
	const flags = ns.flags([["focus", false]]);
	let lastMessage = "";

	while (true) {
		const player = ns.getPlayer();
		const joined = new Set(player.factions);
		const open = GOALS.filter((goal) => !joined.has(goal.faction) || ns.singularity.getFactionRep(goal.faction) < goal.rep);
		if (open.length === 0) {
			ns.print("[faction-work] every goal faction is at its rep goal, done.");
			return;
		}

		const goal = open.find((entry) => joined.has(entry.faction));
		let message;
		if (player.skills.hacking < CONFIG.minHackLevel) {
			message = `[faction-work] hacking ${player.skills.hacking} < ${CONFIG.minHackLevel}, leaving study alone`;
		} else if (!goal) {
			message = `[faction-work] no joined faction below its goal; waiting for invites (${open.length} goal factions left)`;
		} else {
			const current = ns.singularity.getCurrentWork();
			const already = current?.type === "FACTION" && current.factionName === goal.faction;
			if (!already && ns.singularity.workForFaction(goal.faction, "hacking", flags.focus)) {
				ns.toast(`Hacking contracts for ${goal.faction}`, "info");
			}
			const rep = ns.singularity.getFactionRep(goal.faction);
			message = `[faction-work] ${goal.faction}: ${ns.format.number(rep)} / ${ns.format.number(goal.rep)} rep`;
		}
		if (message !== lastMessage) ns.print(message);
		lastMessage = message;

		await ns.sleep(CONFIG.loopMs);
	}
}
