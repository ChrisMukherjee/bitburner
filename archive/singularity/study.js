import { loadConfig } from "/utils/config.js";
import { notify } from "/utils/notify.js";
// Where to study and up to which hacking level: `studying` in the config (config.js, data/config.json).
const CONFIG = {
	checkMs: 10_000,
};

/**
 * Studies (by default Computer Science at Rothman University) until your hacking level reaches the
 * target, then exits and LEAVES THE CLASS RUNNING, so you keep gaining hacking exp until
 * faction-work.js (or you) picks something better. Replaces the old auto-study.js.
 *
 *   run singularity/study.js           study until studying.hackLevel in the config (75)
 *   run singularity/study.js 100       study until hacking 100
 *   run singularity/study.js --focus   focus on the class (faster, but takes over the screen)
 */
export async function main(ns) {
	ns.disableLog("ALL");
	const flags = ns.flags([["focus", false]]);
	const { hackLevel, city, university, course } = loadConfig(ns).studying;
	const targetLevel = Number(flags._[0] ?? hackLevel);

	if (ns.getHackingLevel() >= targetLevel) {
		ns.tprint(`Hacking is already ${ns.getHackingLevel()} (target ${targetLevel}), not studying.`);
		return;
	}
	if (ns.getPlayer().city !== city && !ns.singularity.travelToCity(city)) {
		ns.tprint(`Couldn't travel to ${city} (needs $200k).`);
		return;
	}
	if (!ns.singularity.universityCourse(university, course, flags.focus)) {
		ns.tprint(`Couldn't start ${course} at ${university}.`);
		return;
	}
	ns.print(`Studying ${course} until hacking ${targetLevel}...`);

	while (ns.getHackingLevel() < targetLevel) {
		await ns.sleep(CONFIG.checkMs);
	}
	notify(ns, "[study]", `hacking ${ns.getHackingLevel()} reached. The class keeps running until faction work takes over.`, "success");
}
