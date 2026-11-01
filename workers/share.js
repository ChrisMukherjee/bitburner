/** @param {NS} ns */
// One ns.share() call (about 10s), then exit, so share-manager.js's RAM goes back to the
// batcher every cycle instead of being held forever.
export async function main(ns) {
	await ns.share();
}
