// Design: docs/bladeburner.md
import { readIncomeRate } from "/utils/income.js";
import { notify } from "/utils/notify.js";
import { bladeburnerAccess } from "/utils/bladeburner.js";
import { bladeburnerPlan, postBladeburner, trainFloor } from "/bladeburner/state.js";

// Skill tiers, cheapest first within a tier: Overclock (shorter actions = more rank per hour), the success-chance
// skills, Cyber's Edge (stamina), Hyperdrive (exp).
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
 *   hold   division joined but no actions (the route estimate says hacking, or Bladeburner isn't worth the time now)
 * All decided from live state each pass (Source-Files, hacking level, income, stats, run age); the only input
 * from outside is the route estimate on the same port (`plan`), when one is written.
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
	const setState = (state, line) => postBladeburner(ns, {
		state, stateTime: Date.now(), script: ns.getScriptName(),
		lines: state === "run" ? undefined : [line], // while playing, bb-pass.js writes the lines
	});
	// An action left running (for example from before a reset) would fight the gym or the study
	const clearAction = () => { if (bb.inBladeburner() && bb.getCurrentAction()) bb.stopBladeburnerAction(); };

	const skills = ns.getPlayer().skills;
	const plan = bladeburnerPlan(ns);
	// On the hacking route Bladeburner takes none of the player's time (no gym, no actions), so faction and
	// company work and the hacking augments get all of it. No plan yet = the combat route.
	if (plan?.route === "hacking") {
		clearAction();
		return setState("hold", "hold: the route estimate says hacking is faster");
	}

	// Start of a run: hacking and income first (they pay for everything else), unless the run is already an hour old
	const young = Date.now() - ns.getResetInfo().lastAugReset < BOOT_MAX_MS;
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
	spendSkillPoints(bb);
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
