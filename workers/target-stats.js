/** @param {NS} ns */
/**
 * One-shot helper for batcher.js when Formulas.exe is NOT owned. The analyze functions cost 1GB each
 * (4GB here), so the batcher doesn't call them itself: it runs this for a moment every 30s instead and
 * reads the result from port 27 (STATS_PORT in batcher.js). With Formulas.exe it is never run.
 *   args: the hostnames to measure
 * Posts { time, weakenPerThread, targets: { host: { security, hackPerThread, chance, growPerLn } } },
 * all measured at the target's CURRENT security (the batcher rescales them to min security).
 * growPerLn = grow threads per unit of ln(money multiplier), so threads = growPerLn x ln(multiplier).
 */
export async function main(ns) {
	const targets = {};
	for (const host of ns.args) {
		const target = String(host);
		targets[target] = {
			security: ns.getServerSecurityLevel(target),
			hackPerThread: ns.hackAnalyze(target),
			chance: ns.hackAnalyzeChance(target),
			growPerLn: ns.growthAnalyze(target, Math.E),
		};
	}
	ns.clearPort(27);
	ns.writePort(27, { time: Date.now(), weakenPerThread: ns.weakenAnalyze(1), targets });
}
