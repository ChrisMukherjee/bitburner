/** @param {NS} ns */
export async function main(ns) {
	const target = ns.args[0];
	const landTime = ns.args[1] || 0; // absolute Date.now() timestamp to land at; 0 = no delay

	// The action's duration depends on the target's security at the instant it starts, so measure it
	// here, synchronously right before the call, and wait just long enough to land at landTime.
	const duration = ns.getHackTime(target);
	const additionalMsec = Math.max(0, landTime - Date.now() - duration);
	await ns.hack(target, { additionalMsec });
}