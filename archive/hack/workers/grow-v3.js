/** @param {NS} ns */
export async function main(ns) {
	const target = ns.args[0];
	const additionalMsec = ns.args[1] || 0;
	await ns.grow(target, { additionalMsec });
}