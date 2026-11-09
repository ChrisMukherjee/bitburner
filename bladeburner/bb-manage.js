// Design: docs/bladeburner.md
// @ts-check
import { loadConfig } from "/utils/config.js";
import { readIncomeRate } from "/utils/income.js";
import { postPass } from "/utils/pass-log.js";
import { notify } from "/utils/notify.js";
import { bladeburnerAccess } from "/utils/bladeburner.js";
import { joiningClosesGift } from "/utils/stanek.js";
import { bladeburnerPlan, postBladeburner, readBladeburner, trainFloor } from "/bladeburner/state.js";
import { SKILL_NAMES, skillValues, pickSkill } from "/bladeburner/picks.js";

// Legacy skill tiers (`bladeburner.adaptiveSkills: false`, or no live readings yet), cheapest first within a tier: Overclock
// (shorter actions = more rank per hour), the success-chance skills, Cyber's Edge (stamina), Hyperdrive (exp).
const TIERS = [["Overclock"], ["Blade's Intuition", "Digital Observer", "Tracer", "Cloak", "Short-Circuit"], ["Cyber's Edge"], ["Hyperdrive"]];
const OVERCLOCK_MAX = 90;
const HACK_FLOOR = 10;           // before this the batcher has almost nothing to hack and programs/TOR are out of reach
const CASH_FLOOR = 5e6;          // or this much cash on hand
const BOOT_MAX_MS = 3600_000;    // never hold Bladeburner longer than an hour into a run: if the start is stuck, training is not the cause

/**
 * Bladeburner housekeeping, one short pass every few minutes (startup.js runs it): decides the state on port 36,
 * joins the division, spends skill points. Exits at once without the Bladeburner API.
 *   off    not available
 *   boot   start of a run: first get hacking to 10 and income flowing, Bladeburner waits
 *   train  a combat stat is below the floor: player-work.js trains it in the gym (also after an install resets the stats)
 *   run    stats are ready: bladeburner/bb-pass.js plays and player-work.js leaves the player alone
 *   hold   no actions: the route estimate says hacking, Bladeburner isn't worth the time now, or the division waits
 *          for Stanek's Gift (`bladeburner.stanekFirst`, see below)
 * All decided from live state each pass (Source-Files, augmentations, hacking level, income, stats, run age); the
 * only input from outside is the route estimate on the same port (`plan`), when one is written.
 * Ported from the other player's bb-manage.js, which has run in game.
 */
/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	if (!bladeburnerAccess(ns).available) {
		ns.print("Bladeburner needs BitNode 6 or 7 or Source-File 6 or 7.");
		return;
	}
	const bb = ns.bladeburner;
	const setState = (state, line) => {
		postPass(ns, ns.getScriptName(), [line ?? "run: stats ready, bb-pass.js plays"]);
		return postBladeburner(ns, {
			state, stateTime: Date.now(), script: ns.getScriptName(),
			lines: state === "run" ? undefined : [line], // while playing, bb-pass.js writes the lines
		});
	};
	// An action left running (for example from before a reset) would fight the gym or the study
	const clearAction = () => { if (bb.inBladeburner() && bb.getCurrentAction()) bb.stopBladeburnerAction(); };

	const skills = ns.getPlayer().skills;
	const config = loadConfig(ns);
	const info = ns.getResetInfo();
	const plan = bladeburnerPlan(ns);
	// On the hacking route Bladeburner takes none of the player's time (no gym, no actions), so faction and
	// company work and the hacking augments get all of it. No plan yet = `bladeburner.route` from the config.
	const route = plan?.route ?? config.bladeburner.route;
	if (route === "hacking") {
		clearAction();
		return setState("hold", `hold: the route is hacking (${plan?.route ? "estimate" : "config"})`);
	}

	// Stanek's Gift first (`bladeburner.stanekFirst`, on by default in BitNode 13): with Source-File 7.3, joining installs
	// The Blade's Simulacrum, which closes the Gift for the rest of the BitNode. So while the Gift is still open, the division
	// waits (and the gym too: an install would reset the stats) until the Gift is accepted or an install closes it.
	if (config.bladeburner.stanekFirst && !bb.inBladeburner() && joiningClosesGift(info)) {
		giftNotice(ns, info.lastNodeReset);
		return setState("hold", "hold: Stanek's Gift first (joining now would close it; see the notice)");
	}

	// Start of a run: hacking and income first (they pay for everything else), unless the run is already an hour old
	const young = Date.now() - info.lastAugReset < BOOT_MAX_MS;
	const booted = skills.hacking >= HACK_FLOOR && (readIncomeRate(ns).perSecond > 0 || ns.getPlayer().money >= CASH_FLOOR);
	if (young && !booted) {
		clearAction();
		return setState("boot", "boot: hacking and income first");
	}

	// Combat stats under the floor (new run, or never trained): gym first. The estimate can raise the floor
	// when a longer gym phase beats running now (plan.trainTarget, a level; 0 = none).
	const floor = trainFloor(ns);
	const lowest = Math.min(skills.strength, skills.defense, skills.dexterity, skills.agility);
	if (lowest < floor) {
		clearAction();
		return setState("train", `train: lowest combat stat ${Math.floor(lowest)} / ${floor}`);
	}
	if (!bb.inBladeburner()) {
		if (!bb.joinBladeburnerDivision()) return setState("off", "off: couldn't join the division");
		notify(ns, "[bladeburner]", "joined the division", "success");
	}
	// The estimate decides from the live chances whether Bladeburner is worth the player's time right now
	if (plan?.hold) {
		clearAction();
		return setState("hold", "hold: not worth the player's time right now");
	}
	setState("run");
	const post = readBladeburner(ns);
	if (!(config.bladeburner.adaptiveSkills && spendAdaptive(bb, post))) spendSkillPoints(bb);
}

/**
 * Buys the skill with the most rank-rate gain per point, from the live readings (bladeburner/picks.js: success chance
 * where it isn't capped yet, Overclock only while the player isn't resting for stamina, Cyber's Edge only while it is,
 * Reaper and Evasive System through the combat stats). Waits for points when the best one costs more than is in hand.
 * Returns false when there are no readings yet, so the caller uses the fixed tiers.
 */
function spendAdaptive(bb, post) {
	if (!post.actions || !Array.isArray(post.actions.rows) || post.actions.rows.length === 0) return false;
	/** @type {Record<string, number>} */
	const levels = {};
	for (const name of SKILL_NAMES) levels[name] = bb.getSkillLevel(name);
	const values = skillValues(post.actions, levels, post.restShare);
	let points = bb.getSkillPoints();
	for (let guard = 0; guard < 100; guard++) {
		/** @type {Record<string, number>} */
		const costs = {};
		for (const name of SKILL_NAMES) costs[name] = name === "Overclock" && levels[name] >= OVERCLOCK_MAX ? Infinity : bb.getSkillUpgradeCost(name, 1);
		const pick = pickSkill(costs, values);
		if (!pick || pick.cost > points || !bb.upgradeSkill(pick.name, 1)) break;
		points -= pick.cost;
		levels[pick.name]++;
		Object.assign(values, skillValues(post.actions, levels, post.restShare));
	}
	return true;
}

/** Says once per BitNode why the division waits for Stanek's Gift and how to go on (kept on port 36 as `giftNotice`). */
function giftNotice(ns, nodeStart) {
	if (readBladeburner(ns).giftNotice === nodeStart) return;
	notify(ns, "[bladeburner]", "Bladeburner waits for Stanek's Gift: joining with Source-File 7.3 installs The Blade's " +
		"Simulacrum, which closes the Gift for this BitNode. Accept the Gift at the Church of the Machine God in Chongqing " +
		"before buying any augmentation, or join now with `run /tools/set-config.js set bladeburner.stanekFirst false`. " +
		"Otherwise the division is joined after the first augmentation install.", "warning", true);
	postBladeburner(ns, { giftNotice: nodeStart });
}

/** Buys skills tier by tier, cheapest first; waits for points rather than skipping ahead to a lesser tier. */
function spendSkillPoints(bb) {
	let points = bb.getSkillPoints();
	for (const tier of TIERS) {
		for (let guard = 0; guard < 50; guard++) {
			const options = tier.map((name) => ({ name, cost: bb.getSkillUpgradeCost(name, 1) }))
				.filter((option) => Number.isFinite(option.cost) && option.cost > 0 &&
					(option.name !== "Overclock" || bb.getSkillLevel("Overclock") < OVERCLOCK_MAX));
			if (options.length === 0) break;
			const cheapest = options.sort((first, second) => first.cost - second.cost)[0];
			if (cheapest.cost > points) return;
			if (!bb.upgradeSkill(cheapest.name, 1)) break;
			points -= cheapest.cost;
		}
	}
}
