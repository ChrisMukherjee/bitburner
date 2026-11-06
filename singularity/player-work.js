// Design: docs/player-work.md
import { postPass } from "/utils/pass-log.js";
import { loadConfig } from "/utils/config.js";
import { notify } from "/utils/notify.js";
import { startHelper } from "/utils/start-helper.js";
import { postGate } from "/singularity/ready.js";
import { bladeburnerAccess } from "/utils/bladeburner.js";
import { bladeburnerState, trainFloor } from "/bladeburner/state.js";

// Ports the one-shot helpers write to (not imported: the static RAM check would charge their
// Singularity calls to this script too).
const GOALS_PORT = 23; // singularity/workers/faction-goals.js: rep goal per faction
const PLAN_PORT = 25;  // singularity/workers/city-plan.js: which city factions still sell something wanted
const GANG_PORT = 30;  // gang/workers/invite.js: crime or gym for the gang invite (BitNode 2)
const AUG_PLAN_FILE = "data/aug-plan.json"; // buy-augs.js --plan: rep rates for the goals helper
// What one pass leaves for the next (goals, city plan, what was started or announced), so a
// --once pass can pick up where the last one stopped. Ports work from any server; a new run
// (aug install) starts from scratch.
const STATE_PORT = 35;
const GATE_KEY = "player-work"; // singularity/ready.js: { done } once every part is done this run

// City factions are worked only once joined, never waited for (the city part decides which to join).
const CITY_FACTIONS = ["Sector-12", "Aevum", "Chongqing", "New Tokyo", "Ishima", "Volhaven"];
// City invite rules (v3.0.0 FactionInfo.tsx): be in the faction's city with this much money.
const INVITE_MONEY = {
	"Sector-12": 15e6, "Aevum": 40e6, "Chongqing": 20e6, "New Tokyo": 20e6, "Ishima": 30e6, "Volhaven": 50e6,
};
// Tian Di Hui: hacking 50 and $1m while in Chongqing, New Tokyo or Ishima. Not a city faction,
// so it locks nobody out. Its Neuroreceptor Management Implant removes the penalty for unfocused work.
const TIAN_DI_HUI = {
	faction: "Tian Di Hui",
	city: "Chongqing",
	inviteCities: ["Chongqing", "New Tokyo", "Ishima"],
	minHacking: 50,
	minMoney: 1e6,
};

const CONFIG = {
	loopMs: 30_000,            // between passes when it loops (no --once)
	refreshMs: 10 * 60_000,    // re-read goals and city plan this often (catches augments bought meanwhile)
	travelCost: 200e3,
	goalsHelper: "singularity/workers/faction-goals.js",
	goalsImports: ["utils/config.js", "config.js", "utils/notify.js", "utils/aug-filter.js", "utils/income.js", "utils/income-curve.js"],
	planHelper: "singularity/workers/city-plan.js",
	planImports: ["utils/config.js", "config.js", "utils/notify.js", "utils/aug-filter.js"],
	gangHelper: "gang/workers/invite.js",
	gangImports: ["utils/gang.js"],
	gangRefreshMs: 2 * 60_000, // re-check the gang invite needs (and the best crime, as the stats grow) this often
};

/**
 * The one script that decides what the player does and where they are, so nothing fights over
 * the player's focus or flies them around behind another script's back. It replaces study.js,
 * faction-work.js, company-work.js, get-tian-di-hui.js and city-factions.js (now in archive/).
 *
 * Work, one at a time, in this order:
 *   0. Bladeburner (bladeburner/bb-manage.js posts its state on port 36): while it plays ("run") nothing else
 *      is started; while the combat stats are too low ("train") the lowest goes to the gym first.
 *   1. Study: below studying.hackLevel (75), takes the free course (`studying` in the config) once
 *      and leaves the class alone. The class keeps running past the target until something
 *      better below takes over.
 *   2. Gang invite (BitNode 2, no gang yet): for gang.factions[0] (Slum Snakes), first the crime with the
 *      most expected karma per minute at the current chance (Homicide) until the karma is met, then the
 *      combat stats in the gym (gang.inviteGym; crimes otherwise); join-factions.js accepts the
 *      invite and gang/gang-manager.js creates the gang. Asked of gang/workers/invite.js every 2 minutes.
 *      Where a gang also needs karma -54,000 (Source-File 2, outside BitNode 2) that grind is slow, so it
 *      is done last, in step 4's gap, only when nothing else needs the player.
 *   3. Faction work: factionWork.workType for the first joined faction (factionWork.order) still
 *      below its real rep goal, from singularity/workers/faction-goals.js on port 23: the highest rep needed
 *      among the augments worth buying there (utils/aug-filter.js) that this run can afford and reach
 *      within the reset rule's horizon, with the BitNode's rep-cost multiplier. When a faction reaches
 *      its goal, its work stops.
 *   4. Company work: when no faction needs rep, a companyWork.field job at the first megacorp
 *      whose faction you haven't joined, until its invite (companyWork.repNeeded). Asks for a
 *      promotion every pass. Left alone while you do faction work you started yourself.
 *
 * Travel and joining, alongside the work:
 *   - Tian Di Hui first: once you have hacking 50 and $1.2m, flies to Chongqing and joins on the invite.
 *   - Then the city factions that still sell augments worth having, one rival group per run
 *     (`cities` in the config; plan from singularity/workers/city-plan.js on port 25): Sector-12 + Aevum
 *     (CashRoot, PCMatrix), then Chongqing (Neuregen) in a later run. Flies there once you have
 *     the invite money plus the $200k flight and joins only factions with something left to buy,
 *     never a rival. Says once (toast + terminal) which city invites not to accept by hand.
 *
 * The helpers (about 29GB and 17GB, for a moment) run on home, else on any rooted server with
 * room: at the start, after joining a faction, when a faction reaches its goal and every 10 minutes.
 * Until the goals helper has run once, no faction work happens (logged).
 * Exits once every part is done: hacking at the study target, Tian Di Hui joined, the city group
 * joined (or nothing wanted), every faction at its goal, every megacorp faction joined, and no
 * gang invite still to get. Then it posts that on port 33, so startup.js stops running it this run.
 *
 * Short passes: startup.js runs it with --once about every minute. Each pass decides, starts or
 * keeps the work and exits; the game keeps the work going, so its 29GB is only used for a moment.
 * What the next pass needs is kept on port 35. Each pass logs one line per part (work, travel)
 * saying what it did or why it did nothing. Without --once it loops every 30 seconds as before.
 *
 * Focus: work is focused (full speed, takes over the screen) until the Neuroreceptor Management
 * Implant is installed, then unfocused (no penalty any more, you keep the screen). The goals helper
 * reports whether it's installed; until it first runs, work is focused. Work already running
 * unfocused when the script starts is focused once, the first time the helper reports.
 *
 *   run singularity/player-work.js               focused until the implant is installed, then unfocused
 *   run singularity/player-work.js --once        one pass, then exit (how startup.js runs it)
 *   run singularity/player-work.js --focus       always focused
 *   run singularity/player-work.js --no-focus    always unfocused (80% speed without the implant)
 *   run singularity/player-work.js --study 100   study until hacking 100 instead of studying.hackLevel
 *   run singularity/player-work.js --no-company  never take megacorp jobs
 *   run singularity/player-work.js --plan        print the city plan and exit (travels and joins nothing)
 *
 * "playerFocus": true / false in the config does the same as --focus / --no-focus ("auto" = the default rule).
 */
/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	const flags = ns.flags([["focus", false], ["no-focus", false], ["study", 0], ["no-company", false], ["plan", false], ["once", false]]);

	if (flags.plan) {
		const plan = await refreshPlan(ns, loadConfig(ns).cities);
		if (!plan) ns.tprint(`No room right now for ${CONFIG.planHelper} (${ns.format.ram(ns.getScriptRam(CONFIG.planHelper))}).`);
		else printPlan(ns, plan, new Set(ns.getPlayer().factions));
		return;
	}

	const resetAt = ns.getResetInfo().lastAugReset; // state from before the last install is dropped
	const lastMessages = {};
	while (true) {
		const config = loadConfig(ns);
		const state = loadState(ns, resetAt);
		Object.assign(state, {
			config,
			focusForced: flags.focus || flags["no-focus"] || typeof config.playerFocus === "boolean",
			studyLevel: Number(flags.study) || config.studying.hackLevel,
			noCompany: flags["no-company"],
		});
		state.focus = flags.focus ? true : flags["no-focus"] ? false :
			typeof config.playerFocus === "boolean" ? config.playerFocus : state.focusAuto ?? true;

		const done = await onePass(ns, state);
		saveState(ns, state, resetAt);
		for (const [part, message] of Object.entries(done.messages)) {
			// A --once pass logs every line, so each pass's log says what it did or why it did nothing.
			if (flags.once || message !== lastMessages[part]) ns.print(message);
			lastMessages[part] = message;
		}
		if (flags.once) postPass(ns, ns.getScriptName(), Object.values(done.messages));
		if (done.all) {
			postGate(ns, GATE_KEY, { done: true });
			notify(ns, "[player-work]", "studied, joined and worked everything it can; done.", "success");
			return;
		}
		if (flags.once) return;
		await ns.sleep(CONFIG.loopMs);
	}
}

/** One pass: refresh what's due, then one travel step and one work step. Returns { messages, all }. */
async function onePass(ns, state) {
	const config = state.config;
	let player = ns.getPlayer();
	const order = config.factionWork.order;
	const joinedKey = order.filter((faction) => player.factions.includes(faction)).join("|");
	const reached = state.lastGoalFaction && state.goals &&
		ns.singularity.getFactionRep(state.lastGoalFaction) >= state.goals[state.lastGoalFaction].rep;
	if (!state.goals || joinedKey !== state.goalsFor || reached || Date.now() - state.goalsAt >= CONFIG.refreshMs) {
		const fresh = await refreshGoals(ns, order);
		if (fresh) {
			Object.assign(state, { goals: fresh.goals, goalsAt: Date.now(), goalsFor: joinedKey });
			// Unfocused work is slower until the Neuroreceptor Management Implant is installed.
			if (fresh.focusPenalty !== undefined) state.focusAuto = fresh.focusPenalty;
			if (!state.focusForced && fresh.focusPenalty !== undefined) state.focus = fresh.focusPenalty;
			// Once per run: work started unfocused before this run (e.g. by an older version) is
			// focused too, since only new work would pick up state.focus.
			if (!state.focusChecked) {
				state.focusChecked = true;
				if (state.focus && ns.singularity.getCurrentWork() !== null) ns.singularity.setFocus(true);
			}
		}
	}
	if (!state.cityDone && (!state.plan || Date.now() - state.planAt >= CONFIG.refreshMs)) {
		const fresh = await refreshPlan(ns, config.cities);
		if (fresh) Object.assign(state, { plan: fresh, planAt: Date.now() });
	}

	if (!state.gangDone && Date.now() - state.gangAt >= CONFIG.gangRefreshMs) {
		const { factions, inviteCrimes: crimes, inviteGym: gym } = config.gang;
		const arg = JSON.stringify({ factions, crimes, gym: gym !== false });
		// Once the gang faction is joined, startup.js starts gang/gang-manager.js by itself (gang/ready.js).
		const fresh = await runHelper(ns, CONFIG.gangHelper, CONFIG.gangImports, GANG_PORT, arg);
		if (fresh) Object.assign(state, { gang: fresh, gangAt: Date.now(), gangDone: !fresh.applies });
	}

	const trip = travelStep(ns, state, player);
	player = ns.getPlayer(); // a join or flight above changes factions, city and money
	state.holdCity = !!trip.hold; // waiting here for an invite: the gym doesn't fly away
	const work = workStep(ns, state, player);
	return { messages: { travel: trip.message, work: work.message }, all: trip.done && work.done };
}

// --- State kept between passes (port 35) ---

/** What the last pass left, or a fresh start (first pass, or a new run since). */
function loadState(ns, resetAt) {
	let saved = null;
	try {
		saved = JSON.parse(ns.peek(STATE_PORT));
	} catch { /* none yet */ }
	const state = {
		focusAuto: null, focusChecked: false,
		studyStarted: false, studyAnnounced: false,
		goals: null, goalsAt: 0, goalsFor: "", lastGoalFaction: "", factionAnnounced: false,
		plan: null, planAt: 0, lastAnnounced: "", cityDone: false, cityMessage: "",
		gang: null, gangAt: 0, gangDone: false, gangCrime: false, gangGym: false, holdCity: false,
	};
	if (saved?.resetAt !== resetAt) return state;
	const { planGroups, resetAt: _, ...rest } = saved;
	Object.assign(state, rest);
	if (planGroups) state.plan = toPlan(planGroups);
	return state;
}

/** Keeps what the next pass needs (not the config or the flags, which are read again). */
function saveState(ns, state, resetAt) {
	const { config, focus, focusForced, studyLevel, noCompany, plan, ...rest } = state;
	ns.clearPort(STATE_PORT);
	ns.writePort(STATE_PORT, JSON.stringify({ ...rest, planGroups: plan?.groups ?? null, resetAt }));
}

// --- Work: study, then gang-invite crimes, then faction work, then company work ---

/** Starts or keeps the right kind of work. Returns { message, done }. */
function workStep(ns, state, player) {
	const hacking = player.skills.hacking;
	const joined = new Set(player.factions);
	let current = ns.singularity.getCurrentWork();
	const { factionWork, companyWork, studying } = state.config;

	if (state.studyStarted && !state.studyAnnounced && hacking >= state.studyLevel) {
		notify(ns, "[study]", `hacking ${hacking} reached. The class keeps running until faction work takes over.`, "success");
		state.studyAnnounced = true;
	}

	// Which faction needs rep next.
	let goalFaction = "";
	let factionDone = false;
	let factionMessage = "";
	if (!state.goals) {
		factionMessage = `[faction-work] no room yet for ${CONFIG.goalsHelper} (${ns.format.ram(ns.getScriptRam(CONFIG.goalsHelper))}), so no rep goals; retrying`;
	} else {
		const goals = state.goals;
		// A city faction we haven't joined isn't waited for (its invite may never come).
		const open = factionWork.order.filter((faction) => goals[faction]?.rep > 0 &&
			(joined.has(faction) ? ns.singularity.getFactionRep(faction) < goals[faction].rep : !CITY_FACTIONS.includes(faction)));
		factionDone = open.length === 0;
		goalFaction = open.find((faction) => joined.has(faction)) ?? "";
		if (factionDone) {
			factionMessage = "[faction-work] every faction has the rep for all its augments worth buying";
			if (!state.factionAnnounced) notify(ns, "[faction-work]", "every faction has the rep for all its augments worth buying.", "success");
		} else if (!goalFaction) {
			factionMessage = `[faction-work] no joined faction below its goal; waiting for invites (${open.join(", ")})`;
		}
		state.factionAnnounced = factionDone;
	}

	// Moving off a faction because its goal was reached: stop its work so we don't keep grinding it.
	if (!goalFaction && state.lastGoalFaction &&
		current?.type === "FACTION" && current.factionName === state.lastGoalFaction) {
		ns.singularity.stopAction();
		current = null;
	}
	state.lastGoalFaction = hacking >= state.studyLevel ? goalFaction : "";

	const companies = state.noCompany ? [] : companyWork.companies.filter((entry) =>
		!joined.has(entry.faction) && ns.singularity.getCompanyRep(entry.company) < companyWork.repNeeded);
	// Never done while Bladeburner is possible: bladeburner/bb-manage.js may ask for the gym or the whole player later.
	const done = hacking >= state.studyLevel && factionDone && companies.length === 0 && state.gangDone && !bladeburnerAccess(ns).available;

	// 0. Bladeburner (bladeburner/bb-manage.js posts its state): "run" = bb-pass.js plays, and anything else started
	// here would cancel its action; "train" = the combat stats go to the gym first, before anything else.
	const bladeburner = bladeburnerState(ns);
	if (bladeburner === "run") {
		return { message: "[bladeburner] playing: nothing else is started (see `status`)", done };
	}
	if (bladeburner === "train") {
		const trained = gymStep(ns, state, player, current, trainFloor(ns), "[bladeburner]");
		if (trained) return { message: trained, done };
	}

	// 1. Study.
	if (hacking < state.studyLevel) {
		return { message: studyStep(ns, state, player, current, studying), done };
	}
	// 2. Crime or gym for the gang invite (BitNode 2). Stopped once gang/workers/invite.js says they're no longer needed.
	// The slow karma grind outside BitNode 2 waits until nothing else needs the player (step 4).
	const invite = state.gang?.applies && (state.gang.crime || state.gang.gym) ? state.gang : null;
	if (invite && !invite.slow) {
		const message = gangStep(ns, state, player, current, invite);
		if (message) return { message, done };
	}
	current = stopGangWork(ns, state, current, invite);
	// 3. Faction work.
	if (goalFaction) {
		const already = current?.type === "FACTION" && current.factionName === goalFaction;
		if (!already && ns.singularity.workForFaction(goalFaction, factionWork.workType, state.focus)) {
			notify(ns, "[faction-work]", `${factionWork.workType} work for ${goalFaction}`, "info");
		}
		const goal = state.goals[goalFaction];
		const rep = ns.singularity.getFactionRep(goalFaction);
		return {
			message: `[faction-work] ${goalFaction}: ${ns.format.number(rep)} / ${ns.format.number(goal.rep)} rep (for ${goal.aug}, ${goal.count} augment(s) left there${goal.skipped ? `, ${goal.skipped} out of reach this run` : ""})`,
			done,
		};
	}
	// 4. Company work, filling the gaps.
	if (companies.length === 0) {
		if (invite && (!current || ["CLASS", "CRIME"].includes(current.type))) {
			const message = gangStep(ns, state, player, current, invite);
			if (message) return { message, done };
		}
		return { message: `${factionMessage}; ${state.noCompany ? "company work off (--no-company)" : "every megacorp faction is joined"}`, done };
	}
	if (current?.type === "FACTION") {
		return { message: `[company-work] you're working for ${current.factionName} yourself; leaving it alone`, done };
	}
	const target = companies[0];
	const newJob = ns.singularity.applyToCompany(target.company, companyWork.field); // hire or promote
	if (newJob) ns.print(`[company-work] ${target.company}: now ${newJob}`);
	if (!(target.company in player.jobs) && !newJob) {
		return { message: `[company-work] ${target.company} won't hire you for ${companyWork.field} yet (needs more hacking or charisma)`, done };
	}
	const working = current?.type === "COMPANY" && current.companyName === target.company;
	if (!working || newJob) ns.singularity.workForCompany(target.company, state.focus);
	const rep = ns.singularity.getCompanyRep(target.company);
	return { message: `[company-work] ${target.company}: ${ns.format.number(rep)} / ${ns.format.number(companyWork.repNeeded)} rep`, done };
}

// [skill, the GymType the API wants, the class name the game reports for the current work]
const GYM_STATS = [["strength", "str", "GYMSTRENGTH"], ["defense", "def", "GYMDEFENSE"], ["dexterity", "dex", "GYMDEXTERITY"], ["agility", "agi", "GYMAGILITY"]];
// Gyms by city, best first, with their cost per second (v3.0.0 LocationsMetadata.ts: $120/s x costMult). Exp is
// x10 / x1 in Sector-12, x5 / x2 in Aevum, x4 in Volhaven. The better one only with cash for GYM_CASH_SECONDS.
const GYMS = {
	"Sector-12": [["Powerhouse Gym", 2400], ["Iron Gym", 120]],
	"Aevum": [["Snap Fitness Gym", 1200], ["Crush Fitness Gym", 360]],
	"Volhaven": [["Millenium Fitness Gym", 840]],
};
const GYM_CITY = "Sector-12"; // where to fly when the current city has no gym
const GYM_CASH_SECONDS = 600;

/**
 * Trains the lowest combat stat in the gym until every one reaches the floor (Bladeburner's bladeburner/state.js
 * trainFloor, or the gang invite's): the best gym in this city, else flies to Sector-12, unless the travel step is
 * waiting here for a faction invite (state.holdCity). Returns the log line, or null when no stat needs it.
 */
function gymStep(ns, state, player, current, floor, tag) {
	const [stat, gymType] = GYM_STATS.slice().sort((first, second) => player.skills[first[0]] - player.skills[second[0]])[0];
	if (player.skills[stat] >= floor) return null;
	// Keep a gym class that is running for a stat still below the floor, so the lowest stat changing doesn't swap it every pass.
	const running = String(current?.classType ?? "").toUpperCase();
	const runningStat = GYM_STATS.find(([, type, className]) => running === className || running === type.toUpperCase())?.[0];
	if (current?.type === "CLASS" && runningStat && player.skills[runningStat] < floor) {
		return `${tag} training ${runningStat} (${Math.floor(player.skills[runningStat])} / ${floor})`;
	}
	if (!GYMS[player.city]) {
		if (state.holdCity) return `${tag} no gym in ${player.city}; staying here for a faction invite first`;
		if (player.money < CONFIG.travelCost || !ns.singularity.travelToCity(GYM_CITY)) {
			return `${tag} waiting to fly to ${GYM_CITY} for the gym ($${ns.format.number(CONFIG.travelCost)})`;
		}
	}
	const gyms = GYMS[GYMS[player.city] ? player.city : GYM_CITY];
	const [gym] = gyms.find(([, cost]) => player.money >= cost * GYM_CASH_SECONDS) ?? gyms[gyms.length - 1];
	if (!ns.singularity.gymWorkout(gym, gymType, state.focus)) return `${tag} ${gym} refused ${stat}, will retry`;
	notify(ns, tag, `training ${stat} at ${gym} (now ${Math.floor(player.skills[stat])} / ${floor})`, "info");
	return `${tag} training ${stat} at ${gym}`;
}

/**
 * What gang/workers/invite.js asked for: the gym for the combat stats, else its crime (which repeats until other
 * work replaces it). The crime also stands in for the gym while the travel step waits for an invite in a city
 * without one. Returns the log line, or null when there's nothing to do (the stats got there since it asked).
 */
function gangStep(ns, state, player, current, invite) {
	const needs = `needs ${invite.missing.join(", ")}`;
	if (invite.gym && (GYMS[player.city] || !state.holdCity || !invite.crime)) {
		const trained = gymStep(ns, state, player, current, invite.gym, "[gang-invite]");
		if (trained) state.gangGym = true;
		return trained && `${trained} for the gang: ${needs}`;
	}
	if (!invite.crime) return null;
	if (!(current?.type === "CRIME" && current.crimeType === invite.crime)) {
		ns.singularity.commitCrime(invite.crime, state.focus);
		state.gangCrime = true;
	}
	// (An answer posted by an older invite.js has no rate; the next refresh brings one.)
	const sign = invite.gain === "karma" ? "-" : "+";
	const expected = typeof invite.rate === "number"
		? ` (${Math.round(100 * invite.chance)}% success, ${sign}${ns.format.number(invite.rate)} ${invite.gain}/min expected)` : "";
	return `[gang-invite] ${invite.crime} for the gang${expected}${invite.slow ? ", karma grind when nothing else needs you" : ""}: ${needs}`;
}

/** Stops a gang crime or gym class this script started once the gang asks for nothing. Returns the current work. */
function stopGangWork(ns, state, current, invite) {
	if (invite) return current;
	const running = String(current?.classType ?? "").toUpperCase();
	const gymRunning = current?.type === "CLASS" && GYM_STATS.some(([, type, className]) => running === className || running === type.toUpperCase());
	const stop = (state.gangCrime && current?.type === "CRIME") || (state.gangGym && gymRunning);
	state.gangCrime = false;
	state.gangGym = false;
	if (!stop) return current;
	ns.singularity.stopAction();
	return null;
}

/** Starts the class once (flying to its city if needed); after that leaves the player's work alone. */
function studyStep(ns, state, player, current, studying) {
	const target = `hacking ${player.skills.hacking} < ${state.studyLevel}`;
	if (current?.type === "CLASS") {
		state.studyStarted = true;
		return `[study] ${target}, studying`;
	}
	if (state.studyStarted) return `[study] ${target}, but the class was stopped; leaving your work alone`;
	if (player.city !== studying.city) {
		if (player.money < CONFIG.travelCost) return `[study] ${target}; waiting for $${ns.format.number(CONFIG.travelCost)} to fly to ${studying.city}`;
		if (!ns.singularity.travelToCity(studying.city)) return `[study] flight to ${studying.city} failed, will retry`;
	}
	if (!ns.singularity.universityCourse(studying.university, studying.course, state.focus)) {
		return `[study] couldn't start ${studying.course} at ${studying.university}, will retry`;
	}
	state.studyStarted = true;
	return `[study] studying ${studying.course} until hacking ${state.studyLevel}`;
}

// --- Travel and joining: Tian Di Hui, then the city factions ---

/** One step towards Tian Di Hui, then the city group. Returns { message, done }. */
function travelStep(ns, state, player) {
	const joined = new Set(player.factions);
	const tdh = TIAN_DI_HUI;
	if (!joined.has(tdh.faction)) {
		if (ns.singularity.joinFaction(tdh.faction)) {
			notify(ns, "[tdh]", `joined ${tdh.faction}`, "success");
			return { message: `[tdh] joined ${tdh.faction}`, done: false };
		}
		let message;
		let hold = false;
		if (tdh.inviteCities.includes(player.city)) {
			message = `[tdh] in ${player.city}, waiting for the invite (keep $1m and hacking ${tdh.minHacking})`;
			hold = true;
		} else if (player.skills.hacking < tdh.minHacking) {
			message = `[tdh] waiting for hacking ${tdh.minHacking} (now ${player.skills.hacking})`;
		} else if (player.money < tdh.minMoney + CONFIG.travelCost) {
			message = `[tdh] waiting for $${ns.format.number(tdh.minMoney + CONFIG.travelCost)}`;
		} else if (ns.singularity.travelToCity(tdh.city)) {
			message = `[tdh] flew to ${tdh.city}`;
			hold = true;
		} else {
			message = `[tdh] flight to ${tdh.city} failed, will retry`;
		}
		return { message, done: false, hold };
	}
	if (state.cityDone) return { message: state.cityMessage, done: true };
	const plan = state.plan;
	if (!plan) {
		return { message: `[city] no room yet for ${CONFIG.planHelper} (${ns.format.ram(ns.getScriptRam(CONFIG.planHelper))}); retrying`, done: false };
	}

	const wanted = (group) => group.factions.filter((faction) => plan.needs(group, faction).length > 0);
	const lockedIndex = plan.groups.findIndex((group) => group.factions.some((faction) => joined.has(faction)));
	const groupIndex = lockedIndex >= 0 ? lockedIndex : plan.groups.findIndex((group) => wanted(group).length > 0);
	state.lastAnnounced = announcePlan(ns, plan, groupIndex, joined, wanted, state.lastAnnounced);

	if (groupIndex < 0) {
		state.cityDone = true;
		state.cityMessage = "[city] no city faction sells anything you still want; done.";
		return { message: state.cityMessage, done: true };
	}
	const group = plan.groups[groupIndex];
	const todo = wanted(group).filter((faction) => !joined.has(faction));
	if (todo.length === 0) {
		state.cityDone = true;
		const next = plan.groups.findIndex((other, index) => index !== groupIndex && wanted(other).length > 0);
		state.cityMessage = `[city] joined everything wanted in ${group.factions.join(" + ")}` +
			(next >= 0 ? `; once its augments are bought, a later run goes for ${wanted(plan.groups[next]).join(" + ")}.` : ".");
		return { message: state.cityMessage, done: true };
	}
	const message = pursue(ns, player, todo, plan, group);
	if (message.startsWith("[city] joined")) state.planAt = 0; // refresh: the next faction or group may change
	return { message, done: false, hold: todo.includes(ns.getPlayer().city) };
}

/** One step towards the first faction in todo: join it, fly there, or say what we wait for. */
function pursue(ns, player, todo, plan, group) {
	for (const faction of todo) {
		if (ns.singularity.joinFaction(faction)) {
			notify(ns, "[city]", `joined ${faction}`, "success");
			return `[city] joined ${faction} (for ${plan.needs(group, faction).join(", ")})`;
		}
	}
	const faction = todo[0];
	const augs = plan.needs(group, faction).join(", ");
	const needed = INVITE_MONEY[faction];
	if (player.city === faction) {
		return `[city] in ${faction}, waiting for the invite (needs $${ns.format.number(needed)} on hand; for ${augs})`;
	}
	if (player.money < needed + CONFIG.travelCost) {
		return `[city] next: ${faction} for ${augs}; waiting for $${ns.format.number(needed + CONFIG.travelCost)} (invite + flight)`;
	}
	return ns.singularity.travelToCity(faction)
		? `[city] flew to ${faction}, waiting for the invite (for ${augs})`
		: `[city] flight to ${faction} failed, will retry`;
}

/**
 * Says which city invites to accept this run (toast + terminal line, since a wrong click by hand
 * locks out the rival group). Only when the plan changes; returns the new key.
 */
function announcePlan(ns, plan, groupIndex, joined, wanted, lastKey) {
	const allCities = plan.groups.flatMap((group) => group.factions);
	let key;
	let message;
	if (groupIndex < 0) {
		key = "none";
		message = "City plan: no city faction sells anything you still want, so join-factions.js accepts any city invite (for the favor).";
	} else {
		const group = plan.groups[groupIndex];
		const want = wanted(group);
		const todo = want.filter((faction) => !joined.has(faction));
		if (todo.length === 0) return lastKey; // already joined everything wanted: nothing to decide
		const augs = want.flatMap((faction) => plan.needs(group, faction));
		const avoid = allCities.filter((faction) => !group.factions.includes(faction) && !joined.has(faction));
		key = `${groupIndex}|${todo.join(",")}`;
		message = `City plan: ${want.join(" + ")} (${augs.join(", ")}); player-work.js joins them for you.` +
			(avoid.length ? ` Don't accept ${avoid.join(", ")} this run (rivals).` : "");
	}
	if (key !== lastKey) notify(ns, "[city]", message, "info", true);
	return key;
}

function printPlan(ns, plan, joined) {
	const wanted = (group) => group.factions.filter((faction) => plan.needs(group, faction).length > 0);
	const lockedIndex = plan.groups.findIndex((group) => group.factions.some((faction) => joined.has(faction)));
	const groupIndex = lockedIndex >= 0 ? lockedIndex : plan.groups.findIndex((group) => wanted(group).length > 0);
	ns.tprint("City plan (augments still wanted that only a city sells):");
	plan.groups.forEach((group, index) => {
		const tag = index === lockedIndex ? " [joined this run]" : index === groupIndex ? " [next]" : "";
		const parts = group.factions.map((faction) => {
			const augs = plan.needs(group, faction);
			return `${faction}: ${augs.length ? augs.join(", ") : "-"}`;
		});
		ns.tprint(`  ${index + 1}. ${parts.join("  |  ")}${tag}`);
	});
}

// --- Helpers that run for a moment on home, else on any server with room ---

/** Runs singularity/workers/faction-goals.js and returns its goals, or null if it couldn't run. */
async function refreshGoals(ns, order) {
	// Rep rates from buy-augs.js --plan (auto-reset), so the helper can drop augments whose rep
	// can't be reached in time. Missing file (or not on home): it checks money only.
	let rates = {};
	let ratesTime = 0;
	let incomeModel = null;
	let push = null;
	let pushTime = 0;
	try {
		const plan = JSON.parse(ns.read(AUG_PLAN_FILE));
		rates = plan.perSecond ?? {};
		ratesTime = plan.time ?? 0;
		incomeModel = plan.incomeModel ?? null; // income curve, for the money budget
		push = plan.daedalusPush ?? null;      // Daedalus invite only lacks installed augments
		pushTime = plan.checkedAt ?? 0;
	} catch {
		// no plan yet
	}
	const arg = JSON.stringify({ factions: order, rates, ratesTime, incomeModel, push, pushTime });
	const result = await runHelper(ns, CONFIG.goalsHelper, CONFIG.goalsImports, GOALS_PORT, arg);
	return result?.goals ? result : null;
}

/** Runs singularity/workers/city-plan.js and returns the plan, or null if it couldn't run. */
async function refreshPlan(ns, cities) {
	const arg = JSON.stringify({ groups: cities.groups, otherSources: cities.otherSources });
	const result = await runHelper(ns, CONFIG.planHelper, CONFIG.planImports, PLAN_PORT, arg);
	return result?.groups ? toPlan(result.groups) : null;
}

/** The city plan with a lookup of what each faction in a group still sells that's wanted. */
function toPlan(groups) {
	return { groups, needs: (group, faction) => group.needs[faction] ?? [] };
}

/** Starts a helper, waits for it, and returns the JSON it posted on its port (only if posted after asking). */
async function runHelper(ns, script, imports, port, ...args) {
	const askedAt = Date.now();
	const pid = startHelper(ns, script, imports, ...args);
	if (pid === 0) return null;
	while (ns.isRunning(pid)) await ns.sleep(100);
	try {
		const result = JSON.parse(ns.peek(port));
		return result.time >= askedAt ? result : null;
	} catch {
		return null;
	}
}
