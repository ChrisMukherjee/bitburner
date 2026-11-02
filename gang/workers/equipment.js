// Port gang/gang-manager.js reads the list from.
const EQUIPMENT_PORT = 29;

/**
 * One-shot: posts every gang equipment item with its type and stat multipliers on port 29, then
 * exits. The list never changes, so gang/gang-manager.js runs this once instead of holding the
 * 4GB of type/stat calls all the time. Costs are left out (they change with respect); the manager
 * reads those itself.
 */
/** @param {NS} ns */
export async function main(ns) {
	const items = ns.gang.getEquipmentNames().map((name) => ({
		name,
		type: ns.gang.getEquipmentType(name), // "Weapon", "Armor", "Vehicle", "Rootkit" or "Augmentation"
		stats: ns.gang.getEquipmentStats(name), // e.g. { str: 1.04, def: 1.04 }
	}));
	ns.clearPort(EQUIPMENT_PORT);
	ns.writePort(EQUIPMENT_PORT, { time: Date.now(), items });
}
