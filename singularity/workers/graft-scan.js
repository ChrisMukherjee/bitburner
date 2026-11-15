// Design: docs/grafting.md
// @ts-check
import { loadConfig } from "/utils/config.js";
import { augValue } from "/utils/aug-filter.js";

// Port player-work.js reads the candidates from (see docs/NETSCRIPT.md).
const GRAFT_PORT = 46;
const PLAN_FILE = "data/aug-plan.json"; // buy-augs.js --plan: what this reset's purchases will cost
const PLAN_MAX_AGE_MS = 30 * 60_000;
const NEUROFLUX = "NeuroFlux Governor";

/**
 * One-shot for singularity/player-work.js: the augmentations worth grafting, with their numbers. Wanted ones only (the reset
 * rule's augValue), not owned or queued, with their prerequisites installed. `reachable` = a joined faction sells it.
 * Writes { time, plannedCost, candidates: [{ name, cost, hours, value, reachable }] } to port 45.
 */
/** @param {NS} ns */
export async function main(ns) {
	const config = loadConfig(ns);
	const rule = config.grafting;
	const queued = new Set(ns.singularity.getOwnedAugmentations(true));
	const installed = new Set(ns.singularity.getOwnedAugmentations(false));
	const sold = new Set();
	for (const faction of ns.getPlayer().factions) for (const aug of ns.singularity.getAugmentationsFromFaction(faction)) sold.add(aug);

	let plannedCost = 0;
	try {
		const plan = JSON.parse(ns.read(PLAN_FILE) || "null");
		if (plan && Date.now() - (plan.checkedAt ?? 0) <= PLAN_MAX_AGE_MS) plannedCost = plan.cost ?? 0;
	} catch { /* no plan */ }

	const candidates = [];
	for (const name of ns.grafting.getGraftableAugmentations()) {
		if (name === NEUROFLUX || queued.has(name)) continue;
		if (ns.singularity.getAugmentationPrereq(name).some((prereq) => !installed.has(prereq))) continue;
		const value = augValue(name, ns.singularity.getAugmentationStats(name), config.augments);
		if (!(value >= (rule?.minValue ?? 0)) || !(value > 0)) continue;
		candidates.push({
			name, value, reachable: sold.has(name),
			cost: ns.grafting.getAugmentationGraftPrice(name),
			hours: ns.grafting.getAugmentationGraftTime(name) / 3.6e6,
		});
	}
	ns.clearPort(GRAFT_PORT);
	ns.writePort(GRAFT_PORT, JSON.stringify({ time: Date.now(), plannedCost, candidates }));
}
