// Design: docs/install-persistence.md
// @ts-check
import { loadConfig } from "/utils/config.js";
import { gangAccess } from "/utils/gang.js";
import { buyEquipment } from "/gang/gang-manager.js";

const EQUIPMENT_PORT = 29; // equipment list from gang/workers/equipment.js
const EQUIPMENT_HELPER = "gang/workers/equipment.js";

/**
 * One-shot, run by singularity/install-augs.js just before an augmentation install (`persistence.spendLeftover`): an install
 * wipes the cash but keeps the gang, its members and their equipment, so the cash left after the home upgrades goes into gang
 * equipment instead of vanishing. Every item that adds pay counts (best payback first, however long), since the money would be
 * lost anyway. Exits quietly without a gang.
 *   args: [reserve = 0]  cash to leave untouched
 */
/** @param {NS} ns */
export async function main(ns) {
	const reserve = Math.max(0, Number(ns.args[0] ?? 0) || 0);
	if (!gangAccess(ns).available || !ns.gang.inGang()) return;
	if (!postedEquipment(ns)) {
		const pid = ns.exec(EQUIPMENT_HELPER, "home", 1);
		while (pid !== 0 && ns.isRunning(pid)) await ns.sleep(100);
	}
	const items = postedEquipment(ns);
	if (!items) {
		ns.tprint("[gang] no equipment list (no room for gang/workers/equipment.js): leftover cash not spent on gang equipment.");
		return;
	}
	const settings = loadConfig(ns).gang;
	const isHacking = ns.gang.getGangInformation().isHacking;
	const state = { equipment: items };
	const bought = buyEquipment(ns, settings, isHacking, state, { name: "before install", reserve, maxFraction: 1 }, { anyPayback: true });
	if (bought?.length) ns.tprint(`[gang] before the install, bought ${bought.length} piece(s) of equipment the gang keeps: ${bought.join(", ")}`);
}

/** The equipment list gang/workers/equipment.js posted, or null. */
function postedEquipment(ns) {
	const posted = ns.peek(EQUIPMENT_PORT);
	return posted && typeof posted === "object" && Array.isArray(posted.items) ? posted.items : null;
}
