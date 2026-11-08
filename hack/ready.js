// Design: docs/bitnode-mults.md
// @ts-check
import { readGates, postGate } from "/singularity/ready.js";
import { bitnodeMults } from "/utils/bitnode-mults.js";
import { bitnodeMultsAccess, MULTS_GATE } from "/utils/sf5.js";

const TOLD_GATE = "hack-worth-told";
const WAIT_GATE = "hack-worth-wait";
const WAIT_MS = 120_000; // how long to wait for the multipliers to be saved before starting the batcher anyway

/**
 * For startup.js: false when hacking pays almost nothing in this BitNode, so the batcher's RAM is left to share and the XP
 * farm. That is when ScriptHackMoney x ScriptHackMoneyGain is below `hackWorth.minProduct` (needs the saved BitNode
 * multipliers, so BitNode 5 or Source-File 5; without them hacking is assumed worth it). Overrides: `hackWorth.enabled: false`, or
 * "hack/batcher.js" in `mechanicGates.force` (or `mechanicGates.enabled: false`) in the config.
 * With the multipliers available but not saved yet, it waits for tools/save-bitnode-mults.js (at most WAIT_MS), so the
 * batcher isn't started a moment before the answer is known. 1GB (getResetInfo).
 */
/** @param {NS} ns */
export function batcherReady(ns, config) {
	if (!config.hackWorth?.enabled || !config.mechanicGates?.enabled || config.mechanicGates.force?.includes("hack/batcher.js")) return true;
	const mults = bitnodeMults(ns);
	if (!mults.known) {
		if (!bitnodeMultsAccess(ns).available || readGates(ns)[MULTS_GATE]?.done) return true; // nothing to learn
		const since = readGates(ns)[WAIT_GATE]?.time;
		if (since === undefined) { postGate(ns, WAIT_GATE, { waiting: true }); return false; }
		return Date.now() - since > WAIT_MS;
	}
	const worth = mults.get("ScriptHackMoney") * mults.get("ScriptHackMoneyGain");
	if (worth >= config.hackWorth.minProduct) return true;
	if (!readGates(ns)[TOLD_GATE]) {
		postGate(ns, TOLD_GATE, { told: true });
		ns.tprint(`startup: hack/batcher.js not started: hacking pays ${worth} of the usual in this BitNode (hackWorth in the config; ` +
			"set hackWorth.enabled to false, or add hack/batcher.js to mechanicGates.force, to hack anyway).");
	}
	return false;
}

/**
 * True when the saved BitNode multipliers say hacking pays almost nothing here (the same test batcherReady uses, without
 * its waiting or message). False when unknown, so a run without Source-File 5 never counts as one. 0GB.
 */
/** @param {NS} ns */
export function hackIsWorthless(ns, config) {
	if (!config.hackWorth?.enabled || !config.mechanicGates?.enabled || config.mechanicGates.force?.includes("hack/batcher.js")) return false;
	const mults = bitnodeMults(ns);
	return mults.known && mults.get("ScriptHackMoney") * mults.get("ScriptHackMoneyGain") < config.hackWorth.minProduct;
}
