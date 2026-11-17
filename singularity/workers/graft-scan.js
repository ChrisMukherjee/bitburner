// Design: docs/grafting.md
// @ts-check
import { loadConfig } from "/utils/config.js";
import { augValue, entropyStackCost } from "/utils/aug-filter.js";

// Port player-work.js reads the candidates from (see docs/NETSCRIPT.md).
const GRAFT_PORT = 46;
const PLAN_FILE = "data/aug-plan.json"; // buy-augs.js --plan: what this reset's purchases will cost (graftReserve)
const PLAN_MAX_AGE_MS = 30 * 60_000;
const NEUROFLUX = "NeuroFlux Governor";
const CONGRUITY = "Congruity Implant"; // clears the Entropy virus and stops it coming back (the game: 150T to graft, no faction sells it)

/**
 * One-shot for singularity/player-work.js: the augmentations worth grafting, with their numbers. Wanted ones only (the reset
 * rule's augValue), not owned or queued, with their prerequisites installed. `reachable` = a joined faction sells it.
 * Each graft adds an Entropy stack (every multiplier x0.98) unless the Congruity Implant is owned, so a candidate carries
 * `entropyCost` (graft-plan.js subtracts it from `value`), and the Congruity Implant itself is worth the stacks it would clear.
 * `grafting.entropy: false` ignores entropy. Writes { time, plannedCost, entropy, candidates: [{ name, cost, hours, value, reachable, entropyCost }] } to port 46.
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
		// graftReserve: what the batch the reset rule resets with, or is waiting for, still needs from today's cash (an older plan: the batch that fits now).
		if (plan && Date.now() - (plan.checkedAt ?? 0) <= PLAN_MAX_AGE_MS) plannedCost = plan.graftReserve ?? plan.cost ?? 0;
	} catch { /* no plan */ }

	const entropy = Number(ns.getPlayer().entropy) || 0;
	const weighEntropy = rule?.entropy !== false;
	const protectedFromEntropy = queued.has(CONGRUITY); // owned or queued: grafts add no stack
	const stackCost = weighEntropy && !protectedFromEntropy ? entropyStackCost(config.augments) : 0;

	const candidates = [];
	for (const name of ns.grafting.getGraftableAugmentations()) {
		if (name === NEUROFLUX || queued.has(name)) continue;
		if (ns.singularity.getAugmentationPrereq(name).some((prereq) => !installed.has(prereq))) continue;
		const isCongruity = name === CONGRUITY;
		// The Congruity Implant has no stats: its value is the Entropy it clears (and the stacks it prevents, not counted).
		const value = isCongruity ? (weighEntropy ? entropy * entropyStackCost(config.augments) : 0) : augValue(name, ns.singularity.getAugmentationStats(name), config.augments);
		const entropyCost = isCongruity ? 0 : stackCost;
		if (!(value - entropyCost >= (rule?.minValue ?? 0)) || !(value - entropyCost > 0)) continue;
		candidates.push({
			name, value, entropyCost, reachable: sold.has(name),
			cost: ns.grafting.getAugmentationGraftPrice(name),
			hours: ns.grafting.getAugmentationGraftTime(name) / 3.6e6,
		});
	}
	ns.clearPort(GRAFT_PORT);
	ns.writePort(GRAFT_PORT, JSON.stringify({ time: Date.now(), plannedCost, entropy, candidates }));
}
