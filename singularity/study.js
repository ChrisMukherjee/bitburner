import { notify } from "/utils/notify.js";
const CONFIG = {
	city: "Sector-12",
	university: "Rothman University",
	course: "Computer Science", // the free course
	targetLevel: 75,
	checkMs: 10_000,
};

/**
 * Studies Computer Science at Rothman University until your hacking level reaches the
 * target, then exits and LEAVES THE CLASS RUNNING, so you keep gaining hacking exp until
 * faction-work.js (or you) picks something better. Replaces the old auto-study.js.
 *
 *   run singularity/study.js           study until hacking 75
 *   run singularity/study.js 100       study until hacking 100
 *   run singularity/study.js --focus   focus on the class (faster, but takes over the screen)
 */
export async function main(ns) {
	ns.disableLog("ALL");
	const flags = ns.flags([["focus", false]]);
	const targetLevel = Number(flags._[0] ?? CONFIG.targetLevel);

	if (ns.getHackingLevel() >= targetLevel) {
		ns.tprint(`Hacking is already ${ns.getHackingLevel()} (target ${targetLevel}), not studying.`);
		return;
	}
	if (ns.getPlayer().city !== CONFIG.city && !ns.singularity.travelToCity(CONFIG.city)) {
		ns.tprint(`Couldn't travel to ${CONFIG.city} (needs $200k).`);
		return;
	}
	if (!ns.singularity.universityCourse(CONFIG.university, CONFIG.course, flags.focus)) {
		ns.tprint(`Couldn't start ${CONFIG.course} at ${CONFIG.university}.`);
		return;
	}
	ns.print(`Studying ${CONFIG.course} until hacking ${targetLevel}...`);

	while (ns.getHackingLevel() < targetLevel) {
		await ns.sleep(CONFIG.checkMs);
	}
	notify(ns, "[study]", `hacking ${ns.getHackingLevel()} reached. The class keeps running until faction work takes over.`, "success");
}
