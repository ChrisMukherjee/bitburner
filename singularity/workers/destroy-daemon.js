// @ts-check
/**
 * Does the one costly thing next-bitnode.js leaves for last: ns.singularity.destroyW0r1dD43m0n,
 * which ends the BitNode, enters BitNode `arg 0` and runs `arg 1` there. By itself it is
 * 32GB in BitNode 4 or with SF4.3 (16x at SF4.1, 4x at SF4.2). Start it through
 * next-bitnode.js, which checks everything first; it does no checks of its own.
 */
/** @param {NS} ns */
export async function main(ns) {
	ns.singularity.destroyW0r1dD43m0n(Number(ns.args[0]), String(ns.args[1] ?? "startup.js"));
}
