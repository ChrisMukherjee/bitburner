/** @param {NS} ns **/
import { getBestTarget } from "/utils/get-best-target.js";
import { dispatchBatchThreads } from "/utils/workpool.js";
import { nukeAllServers } from "/utils/nuke-all.js";

export async function main(ns) {
	ns.disableLog("ALL");
	ns.print("Starting Pipelined HWGW Batch Manager...");

	const WORKER_FILES = [
		"/workers/hack.js",
		"/workers/grow.js",
		"/workers/weaken.js"
	];

	let batchCount = 0;

	while (true) {
		// Automatically nuke any newly available servers/ports
		nukeAllServers(ns);

		// Pick the best single target based on Max Money
		const target = getBestTarget(ns);
		ns.tprint(`[BatchManager] Locked target: ${target}`);

		// Ensure target is fully prepped (Max Money, Min Security) before batching
		let sec = ns.getServerSecurityLevel(target);
		let minSec = ns.getServerMinSecurityLevel(target);
		let money = ns.getServerMoneyAvailable(target);
		let maxMoney = ns.getServerMaxMoney(target);

		if (sec > minSec + 0.1 || money < maxMoney * 0.99) {
			ns.print(`Prep loop: Sec ${sec.toFixed(2)}/${minSec}, Money ${(money / 1e6).toFixed(1)}m/${(maxMoney / 1e6).toFixed(1)}m`);
			await prepTarget(ns, target, WORKER_FILES);
			// Brief pause before re-checking prep state
			await ns.asleep(1000);
			continue;
		}

		// Calculate Batch Timings
		let weakenTime = ns.getWeakenTime(target);
		let growTime = ns.getGrowTime(target);
		let hackTime = ns.getHackTime(target);

		// Calculate Thread Requirements for a 10% Hack Batch
		let hackPercent = 0.10;
		let hackThreads = Math.max(1, Math.floor(hackPercent / ns.hackAnalyze(target)));
		let hackSecurityIncrease = ns.hackAnalyzeSecurity(hackThreads);

		let weaken1Threads = Math.ceil(hackSecurityIncrease / 0.05); // 0.05 security drop per weaken thread

		// Grow threads needed to restore the 10% taken
		let growThreads = Math.ceil(ns.growthAnalyze(target, 1 / (1 - hackPercent)));
		let growSecurityIncrease = ns.growthAnalyzeSecurity(growThreads);
		let weaken2Threads = Math.ceil(growSecurityIncrease / 0.05);

		// Stagger buffer (200ms between actions to prevent race conditions)
		let buffer = 200;

		let batchStartTime = Date.now();

		// Anchor everything so Weaken 2 finishes last, and they land in order: Hack -> W1 -> Grow -> W2
		let finishBase = batchStartTime + weakenTime + (buffer * 3);

		let targetFinishHack = finishBase - (buffer * 3);
		let targetFinishWeaken1 = finishBase - (buffer * 2);
		let targetFinishGrow = finishBase - buffer;
		let targetFinishWeaken2 = finishBase;

		// Calculate exact start delays relative to 'batchStartTime'
		let hackDelay = Math.max(0, targetFinishHack - hackTime - batchStartTime);
		let weaken1Delay = Math.max(0, targetFinishWeaken1 - weakenTime - batchStartTime);
		let growDelay = Math.max(0, targetFinishGrow - growTime - batchStartTime);
		let weaken2Delay = Math.max(0, targetFinishWeaken2 - weakenTime - batchStartTime);

		// Dispatch Batch across available botnet and purchased servers
		await dispatchBatchThreads(ns, WORKER_FILES, "/workers/hack.js", hackThreads, target, hackDelay);
		await dispatchBatchThreads(ns, WORKER_FILES, "/workers/weaken.js", weaken1Threads, target, weaken1Delay);
		await dispatchBatchThreads(ns, WORKER_FILES, "/workers/grow.js", growThreads, target, growDelay);
		await dispatchBatchThreads(ns, WORKER_FILES, "/workers/weaken.js", weaken2Threads, target, weaken2Delay);

		batchCount++;
		if (batchCount % 10 === 0) {
			ns.print(`[Pipeline] Dispatched batch #${batchCount} against ${target}`);
		}

		// Pipeline spacing: launch a new batch every 1000ms (5 * buffer) to stack concurrency
		await ns.asleep(buffer * 5);
	}
}

async function prepTarget(ns, target, workerFiles) {
	let sec = ns.getServerSecurityLevel(target);
	let minSec = ns.getServerMinSecurityLevel(target);
	let money = ns.getServerMoneyAvailable(target);
	let maxMoney = ns.getServerMaxMoney(target);

	if (sec > minSec) {
		let threads = Math.ceil((sec - minSec) / 0.05);
		ns.print(`Prep: Weakening ${target} with ${threads} threads across pool...`);
		await dispatchBatchThreads(ns, workerFiles, "/workers/weaken.js", threads, target, 0);
		await ns.asleep(ns.getWeakenTime(target) + 200);
	} else if (money < maxMoney) {
		let threads = Math.ceil(ns.growthAnalyze(target, maxMoney / Math.max(money, 100)));
		ns.print(`Prep: Growing ${target} with ${threads} threads across pool...`);
		await dispatchBatchThreads(ns, workerFiles, "/workers/grow.js", threads, target, 0);
		await ns.asleep(ns.getGrowTime(target) + 200);
	}
}