/** @param {NS} ns **/
export async function main(ns) {
	const targetHackingLevel = ns.args[0] || 50; // Pass target level as argument, default to 50

	// Join a university (e.g., Rothman University in Sector-12)
	// Make sure you adjust city/university to match where you start/travel to
	let university = "Rothman University";
	let city = "Sector-12";
	let course = "Algorithms";

	if (ns.getPlayer().city !== city) {
		ns.singularity.travelToCity(city);
	}

	ns.singularity.universityCourse(university, course);
	ns.tprint(`Studying ${course} at ${university} until hacking level ${targetHackingLevel}...`);

	while (ns.getPlayer().skills.hacking < targetHackingLevel) {
		await ns.sleep(5000);
	}

	ns.singularity.stopClass();
	ns.tprint(`Target hacking level ${targetHackingLevel} reached! Stopping studies.`);
}