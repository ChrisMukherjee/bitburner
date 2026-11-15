// Design: docs/sleeves.md
// @ts-check
import { GYMS, GYM_CITY, GYM_CASH_SECONDS, GYM_STATS } from "/utils/gyms.js";
import { pickCourse, CHARISMA_COURSES } from "/utils/study.js";

/**
 * The decisions of the sleeve manager, as pure functions of plain values (0GB), so `npm test` covers them and the
 * manager and its workers only read the game and carry the decisions out. Design: docs/sleeves.md.
 *
 * Ports (all written and read by the sleeves/ scripts):
 *   40 summary { time, title, script, oneShot, lines, roles }, shown by `status`
 *   41 a worker's results: JSON [{ sleeve, ok, used }, ...], one entry per sleeve it was given
 *   42 sleeve augmentation values { time, values: { name: value } }
 *   43 the game's crime stats { time, crimes: { name: { difficulty, time, money, weights } } }
 */
export const SUMMARY_PORT = 40;
export const RESULT_PORT = 41;
export const AUG_VALUE_PORT = 42;
export const CRIME_STATS_PORT = 43;

const COMBAT = ["strength", "defense", "dexterity", "agility"];
const MAX_SKILL_LEVEL = 975; // the game's divisor in a crime's success chance
const GANG_INVITE_COMBAT = 30; // the combat level a combat gang's invite needs (docs/gang.md)
const MIN_TRAVEL_CASH = 1e6; // a flight costs $200k; not worth it with less cash than this
// How a job's rep rate depends on skills (v3.0.0 CompanyPositions metadata: calculateJobPerformance weights hacking and charisma by
// these effectiveness points, over 975), averaged over each field's positions: [hacking, charisma].
export const JOB_EFFECTIVENESS = {
	Software: [76.25, 23.75], IT: [83.75, 16.25], Business: [12.5, 87.5], Security: [8.75, 21.25], Agent: [13.3, 16.7],
};
const INFILTRATE = "Infiltrate Synthoids"; // the sleeve-only Bladeburner action that adds action counts
export const BB_ROUTE_STATES = ["boot", "train", "run"];

/**
 * @typedef {{ kind: string, [key: string]: any }} Candidate  what one sleeve could do (see `family`), best first
 * @typedef {{ index: number, shock: number, sync: number, memory: number, city: string,
 *   skills: any, mults?: any, task: { type: string, [key: string]: any } | null }} SleeveInfo
 */

/** Which worker script carries a candidate out: recover.js, crime.js, train.js, work.js or blade.js. */
export function family(candidate) {
	switch (candidate.kind) {
		case "recover": case "sync": return "recover";
		case "crime": return "crime";
		case "gym": case "class": return "train";
		case "faction": case "company": return "work";
		case "bb": return "blade";
		default: return "crime";
	}
}

/** True when the sleeve is already doing what the candidate asks (so nothing needs to be sent). */
export function sameTask(task, candidate) {
	if (!task) return false;
	switch (candidate.kind) {
		case "recover": return task.type === "RECOVERY";
		case "sync": return task.type === "SYNCHRO";
		case "crime": return task.type === "CRIME" && task.crimeType === candidate.crime;
		case "gym": return task.type === "CLASS" && String(task.classType).toLowerCase().startsWith("gym") === true &&
			gymStatOf(task.classType) === candidate.stat;
		case "class": // a course of the same kind (hacking or charisma) keeps running, so paid and free courses do not flap
			return task.type === "CLASS" && !String(task.classType).toLowerCase().startsWith("gym") &&
				CHARISMA_COURSES.some((course) => isChaClass(task.classType, course)) === CHARISMA_COURSES.includes(candidate.course);
		case "faction": return task.type === "FACTION" && task.factionName === candidate.faction && task.factionWorkType === candidate.work;
		case "company": return task.type === "COMPANY" && task.companyName === candidate.company;
		case "bb":
			if (candidate.action === INFILTRATE) return task.type === "INFILTRATE";
			return task.type === "BLADEBURNER" && (candidate.contract ? task.actionName === candidate.contract : true);
		default: return false;
	}
}

/** True when the running class (the game's name, "LEADERSHIP") is the charisma course. */
function isChaClass(classType, course) {
	return String(classType).toUpperCase() === course.toUpperCase();
}

/** The gym stat key ("str"...) a running gym class trains, from the class name the game reports ("GYMSTRENGTH"). */
function gymStatOf(classType) {
	const name = String(classType).toUpperCase();
	return GYM_STATS.find(([, , className]) => className === name)?.[1] ?? "";
}

/** Mean of the four combat levels. */
export function combatAverage(skills) {
	return COMBAT.reduce((sum, key) => sum + (skills[key] ?? 0), 0) / COMBAT.length;
}

/**
 * Shock recovery with hysteresis: starts at `enter` (%), keeps going until `exit`, so a sleeve doesn't flip between work and
 * recovery every pass.
 */
export function needsRecovery(sleeve, rule) {
	return sleeve.task?.type === "RECOVERY" ? sleeve.shock > rule.exit : sleeve.shock >= rule.enter;
}

/** Synchronization with hysteresis: starts below `enter`, keeps going until `exit` (sync runs 1-100). */
export function needsSync(sleeve, rule) {
	return sleeve.task?.type === "SYNCHRO" ? sleeve.sync < rule.exit : sleeve.sync < rule.enter;
}

/**
 * The game's crime success chance (v3.0.0 Crime.successRate): the weighted skills over 975, divided by the crime's
 * difficulty, times the person's crime success multiplier; Intelligence only adds to it and sleeves have none.
 * `stats` is { difficulty, weights: { hacking, strength, defense, dexterity, agility, charisma } }.
 */
export function crimeChance(skills, mults, stats) {
	let weighted = 0;
	for (const [key, weight] of Object.entries(stats.weights ?? {})) weighted += weight * (skills[key] ?? 0);
	const chance = (weighted / MAX_SKILL_LEVEL / stats.difficulty) * (mults?.crime_success ?? 1);
	return Math.min(1, Math.max(0, chance));
}

/**
 * The crime for cash: with the game's crime stats, the most money per second at this sleeve's chance (a failure pays nothing)
 * among the crimes that succeed at least `minChance` of the time (the likeliest one when none does); without them the last rung
 * of `ladder` the sleeve's average combat level reaches. Returns { crime, chance, rate } (chance and rate in $/s are null when unknown).
 */
export function pickCashCrime(sleeve, crimes, ladder, minChance) {
	if (crimes && Object.keys(crimes).length) {
		const rows = Object.entries(crimes).map(([crime, stats]) => {
			const chance = crimeChance(sleeve.skills, sleeve.mults, stats);
			return { crime, chance, rate: chance * stats.money / (stats.time / 1000) };
		});
		const fit = rows.filter((row) => row.chance >= minChance);
		const best = (fit.length ? fit : rows).reduce((top, row) => (fit.length ? row.rate > top.rate : row.chance > top.chance) ? row : top);
		return { crime: best.crime, chance: best.chance, rate: best.rate };
	}
	const average = combatAverage(sleeve.skills);
	const rung = [...ladder].reverse().find(([, level]) => average >= level) ?? ladder[0];
	return { crime: rung[0], chance: null, rate: null };
}

/**
 * True while the gang invite still needs the sleeves (its karma, its combat level). Not while the hacking route has a clear next
 * step (`state.focus`, utils/route-focus.js, posted by player-work.js): the gang's money and rep don't unlock Daedalus, The Red Pill or
 * w0r1d_d43m0n, and a sleeve at the gym or on Homicide is a sleeve not earning rep for them.
 */
export function gangInviteOpen(state) {
	return !!state.invite?.applies && !state.focus?.skipSide;
}

/**
 * The combat level the sleeves should be trained to, from what this run needs: Bladeburner's floor while it is the route (its
 * contracts' chance depends on combat), the gym level the gang invite asks for, else 0. `train.combat` in the config
 * replaces it with a number.
 */
export function combatTarget(state, rule) {
	if (typeof rule.combat === "number") return rule.combat;
	let target = 0;
	if (state.bb && BB_ROUTE_STATES.includes(state.bb.state)) target = Math.max(target, state.bb.trainFloor ?? 100);
	if (gangInviteOpen(state)) target = Math.max(target, state.invite.gym || (state.invite.crime ? GANG_INVITE_COMBAT : 0));
	return target;
}

/** The hacking level the sleeves should study to: the player's study target (`studying.hackLevel`), or `train.hacking`. */
export function hackingTarget(config) {
	const rule = config.sleeves.train.hacking;
	return typeof rule === "number" ? rule : (config.studying?.hackLevel ?? 0);
}

/**
 * The charisma a sleeve should train to, 0 for none. Only while the player holds a job at one of `companyWork.companies` (a sleeve
 * can then work for that company, and charisma is part of its rep rate: JOB_EFFECTIVENESS for `companyWork.field`). A skill's
 * exp-to-level curve is level = mult x (32 ln(exp + 534.5) - 200), so a point of effectiveness buys eff x mult / (exp + 534.5) per
 * exp; charisma is trained until that equals what the sleeve's hacking level buys, i.e. exp_cha + 534.5 =
 * (effC x multC) / (effH x multH) x (exp_hack + 534.5). At most `train.charismaMax`. `train.charisma`: "auto" or a number (0 = never).
 */
export function charismaTarget(sleeve, state, config) {
	const rule = config.sleeves.train;
	if (typeof rule.charisma === "number") return rule.charisma;
	const eff = JOB_EFFECTIVENESS[config.companyWork?.field];
	if (!eff || !(config.companyWork?.companies ?? []).some((entry_) => state.jobs?.[entry_.company])) return 0;
	const multH = sleeve.mults?.hacking ?? 1;
	const multC = sleeve.mults?.charisma ?? 1;
	const hackExp = Math.exp(((sleeve.skills.hacking ?? 0) / multH + 200) / 32);
	const chaExp = (eff[1] * multC) / (eff[0] * multH) * hackExp;
	return Math.min(rule.charismaMax ?? 500, Math.max(0, Math.floor(multC * (32 * Math.log(chaExp) - 200))));
}

/**
 * Charisma training for a sleeve that would work for a company, or null: the courses cost money, like the paid hacking course
 * (Leadership, the dearest and best, once cash covers `studying.paidSeconds` of its fee, else Management at half), at the study
 * university. Used after the jobs are handed out: only a sleeve with a company job trains charisma, and goes back to the job
 * once it reaches charismaTarget.
 * @returns {Candidate | null}
 */
export function charismaTraining(sleeve, state, config) {
	const target = charismaTarget(sleeve, state, config);
	if (!(target > 0) || (sleeve.skills.charisma ?? 0) >= target) return null;
	const { university, city, paidPerSecond = 960, paidSeconds = 600 } = config.studying;
	const course = state.cash >= paidPerSecond * paidSeconds ? "Leadership" : state.cash >= paidPerSecond / 2 * paidSeconds ? "Management" : "";
	if (!course || (sleeve.city !== city && state.cash < MIN_TRAVEL_CASH)) return null;
	return { kind: "class", university, course, travel: sleeve.city === city ? null : city };
}

/**
 * Training for one sleeve, or null when it needs none: the lowest combat stat below the target goes to the best gym its city
 * has (the better gym only with cash for GYM_CASH_SECONDS of it, as player-work.js does), flying to GYM_CITY first when the
 * city has none; else hacking below its target studies at the configured university.
 * @param {SleeveInfo} sleeve
 * @returns {Candidate | null}
 */
export function trainingFor(sleeve, state, config) {
	const rule = config.sleeves.train;
	const combat = combatTarget(state, rule);
	const [stat] = GYM_STATS
		.map(([skill, key]) => /** @type {[string, number]} */ ([key, sleeve.skills[skill] ?? 0]))
		.filter(([, level]) => level < combat)
		.sort((first, second) => first[1] - second[1])[0] ?? [];
	if (stat) {
		const here = GYMS[sleeve.city];
		const city = here ? sleeve.city : GYM_CITY;
		if (!here && state.cash < MIN_TRAVEL_CASH) return null;
		const [best, cheap] = [GYMS[city][0], GYMS[city][GYMS[city].length - 1]];
		const gym = state.cash >= best[1] * GYM_CASH_SECONDS ? best[0] : cheap[0];
		return { kind: "gym", gym, stat, travel: here ? null : city };
	}
	const hacking = hackingTarget(config);
	if (hacking > 0 && (sleeve.skills.hacking ?? 0) < hacking) {
		const { university, city, course } = config.studying;
		if (sleeve.city !== city && state.cash < MIN_TRAVEL_CASH) return null;
		return { kind: "class", university, course: pickCourse(config.studying, state.cash), travel: sleeve.city === city ? null : city };
	}
	return null;
}

/**
 * Who does what this pass. One entry per sleeve: { sleeve, role, why, candidates, keep }. `candidates` are tried in order by the
 * worker for their family (the first the game accepts wins); `keep` says the sleeve already does the first one.
 *
 * Per sleeve, first match wins:
 *   1. shock recovery, 2. synchronization (config.sleeves.shock / sync, with hysteresis),
 *   3. training: combat toward the run's combat target, hacking toward the study target (trainingFor),
 *   4. the jobs the run needs, in order, one sleeve each (a sleeve already doing a job's first option keeps it):
 *      the gang invite's karma (Homicide, from every free sleeve), Bladeburner contracts while it is played, a rep
 *      grind for each faction with a goal the player isn't working on (factionShare), a job the player holds (companyShare),
 *   5. cash: the best crime (pickCashCrime).
 * @param {{ sleeves: SleeveInfo[], cash: number, goals: Record<string, any> | null, playerFaction: string,
 *   joined: string[], jobs: Record<string, string>, invite: any, bb: any, crimes: any, focus?: { skipSide?: boolean } | null }} state
 *   (focus: the route-focus phase from port 44, null or missing = none)
 * @param {any} config the whole config
 */
export function planSleeves(state, config) {
	const rule = config.sleeves;
	const count = state.sleeves.length;
	/** @type {Map<number, any>} */
	const plans = new Map();
	const free = [];
	for (const sleeve of state.sleeves) {
		if (needsRecovery(sleeve, rule.shock)) {
			plans.set(sleeve.index, entry(sleeve, "recover", `shock ${Math.round(sleeve.shock)}%`, [{ kind: "recover" }]));
		} else if (needsSync(sleeve, rule.sync)) {
			plans.set(sleeve.index, entry(sleeve, "sync", `sync ${Math.round(sleeve.sync)}%`, [{ kind: "sync" }]));
		} else {
			const train = trainingFor(sleeve, state, config);
			if (train) plans.set(sleeve.index, entry(sleeve, "train", train.kind === "gym" ? `${train.stat} below ${combatTarget(state, rule.train)}` : `hacking below ${hackingTarget(config)}`, [train]));
			else free.push(sleeve);
		}
	}

	// The jobs, each for one sleeve. "auto" orders them by value (jobValues) and drops the ones worth no more than cash crime;
	// "fixed" keeps the order karma, Bladeburner, factions, companies, with factionShare and companyShare as caps.
	const auto = rule.priority !== "fixed";
	const values = jobValues(state, config);
	const decay = rule.weights?.decay ?? 0.6;
	/** @type {{ role: string, why: string, candidates: Candidate[], value: number }[]} */
	let jobs = [];
	if (gangInviteOpen(state) && state.invite.crime && state.invite.gain === "karma") {
		for (let at = 0; at < (auto ? karmaSlots(state, rule, count) : count); at++) jobs.push({ role: "karma", why: "karma for the gang", candidates: [{ kind: "crime", crime: "Homicide" }], value: values.karma * decay ** at });
	}
	if (state.bb?.state === "run") {
		const contracts = rule.bladeburner.contracts.map((contract) => ({ kind: "bb", action: "Take on contracts", contract }));
		for (let at = 0; at < count; at++) jobs.push({ role: "bladeburner", why: "Bladeburner contracts", candidates: contracts, value: values.bladeburner * decay ** at });
		// Infiltrating adds action counts, which is what limits contracts once every safe action's counts are used up.
		if (auto) for (let at = 0; at < count; at++) jobs.push({ role: "infiltrate", why: "infiltrating for action counts", candidates: [{ kind: "bb", action: INFILTRATE }], value: values.infiltrate * decay ** at });
	}
	const joined = new Set(state.joined);
	const factions = (config.factionWork?.order ?? [])
		.filter((faction) => joined.has(faction) && faction !== state.playerFaction && state.goals?.[faction]?.rep > 0);
	const factionSlots = auto ? factions.length : Math.min(factions.length, Math.ceil(count * rule.factionShare));
	for (const faction of factions.slice(0, factionSlots)) {
		const types = [config.factionWork.workType, ...["hacking", "field", "security"].filter((type) => type !== config.factionWork.workType)];
		jobs.push({ role: "faction", why: `${faction} rep`, candidates: types.map((work) => ({ kind: "faction", faction, work })), value: values.faction });
	}
	const companies = (config.companyWork?.companies ?? []).map((entry_) => entry_.company).filter((company) => state.jobs[company]);
	const companySlots = auto ? companies.length : Math.floor(count * rule.companyShare);
	for (const company of companies.slice(0, companySlots)) {
		jobs.push({ role: "company", why: `${company} rep`, candidates: [{ kind: "company", company }], value: values.company });
	}
	if (auto) jobs = jobs.filter((job) => job.value > Math.max(values.cash, 0)).sort((first, second) => second.value - first.value);

	const left = [...free];
	for (const job of jobs) {
		if (!left.length) break;
		// A sleeve already doing the job's first option keeps it; else the lowest-numbered free sleeve takes it.
		// (a sleeve training charisma for the company counts as doing it, so the job is not handed to another sleeve meanwhile)
		const doing = (sleeve) => sameTask(sleeve.task, job.candidates[0]) ||
			(job.role === "company" && sleeve.task?.type === "CLASS" && CHARISMA_COURSES.some((course) => isChaClass(sleeve.task.classType, course)));
		const at = Math.max(0, left.findIndex(doing));
		const [sleeve] = left.splice(at, 1);
		plans.set(sleeve.index, entry(sleeve, job.role, job.why, job.candidates));
	}
	for (const sleeve of left) {
		const { crime, chance } = pickCashCrime(sleeve, state.crimes, rule.crimeLadder, rule.minCrimeChance);
		const why = chance === null ? `${crime} for cash` : `${crime} for cash (${Math.round(chance * 100)}% chance)`;
		plans.set(sleeve.index, entry(sleeve, "cash", why, [{ kind: "crime", crime }]));
	}
	// A sleeve about to work for a company trains charisma first where that pays (charismaTraining).
	for (const planned of [...plans.values()]) {
		if (planned.role !== "company") continue;
		const sleeve = state.sleeves[planned.sleeve];
		const train = charismaTraining(sleeve, state, config);
		if (train) plans.set(sleeve.index, entry(sleeve, "train", `charisma below ${charismaTarget(sleeve, state, config)} before ${planned.why}`, [train]));
	}
	return state.sleeves.map((sleeve) => plans.get(sleeve.index));
}

/**
 * How many sleeves the karma job may take: with a measured karma rate per sleeve-hour (`state.karmaRate`) and the karma still
 * missing (`state.karmaLeft`), only as many as finish it within `weights.karmaHours`; without a reading, all of them.
 */
export function karmaSlots(state, rule, count) {
	const rate = state.karmaRate;
	if (!(rate > 0) || !(state.karmaLeft >= 0)) return count;
	return Math.min(count, Math.max(1, Math.ceil(state.karmaLeft / (rate * (rule.weights?.karmaHours ?? 2)))));
}

/**
 * What each job is worth to this run, in one unit (relative value of a sleeve-hour), so the planner can hand sleeves to the best
 * job instead of a fixed order. Each base weight (`sleeves.weights`) is scaled by what the run says:
 *   karma        0 where the gang can't run (GangSoftcap below mechanicGates.minMultiplier), else the weight: karma is a gate
 *   bladeburner  x BladeburnerRank (0 = no division), x 0.25 while the route estimate says hacking (the division is only held), x the
 *                share of passes where counts are left (1 - freeShare); infiltrate is the same weight x freeShare (counts are what
 *                limits rank then)
 *   faction      x FactionWorkRepGain, x 0.5 on the Bladeburner route (it needs fewer augmentations)
 *   company      the weight (the slowest rep there is)
 *   cash         x CrimeMoney, times the share of the money the sleeve's crime would be next to the run's income (so cash is
 *                worth little once hacking pays millions a second); half the weight where the crime stats or income are unknown
 * Missing multipliers (no Source-File 5) read 1. Pure, 0GB.
 */
export function jobValues(state, config) {
	const weights = config.sleeves.weights;
	const mult = (name) => state.mults?.get?.(name) ?? 1;
	const gates = config.mechanicGates;
	const gangOk = !gates?.enabled || mult("GangSoftcap") >= gates.minMultiplier;
	const combatRoute = state.bb?.route !== "hacking";
	const first = state.sleeves?.[0];
	const rate = first ? pickCashCrime(first, state.crimes, config.sleeves.crimeLadder, config.sleeves.minCrimeChance).rate : null;
	const income = state.incomePerSecond ?? 0;
	// Share of passes where every safe action's counts were used up (bb-pass.js): contracts earn little then, infiltrating adds counts.
	const free = Number.isFinite(state.bb?.freeShare) ? Math.min(1, Math.max(0, state.bb.freeShare)) : 0;
	const share = rate === null || !(income >= 0) ? 0.5 : rate / (rate + income || 1);
	return {
		karma: gangOk ? weights.karma : 0,
		bladeburner: weights.bladeburner * mult("BladeburnerRank") * (combatRoute ? 1 : 0.25) * (1 - free),
		infiltrate: weights.bladeburner * mult("BladeburnerRank") * (combatRoute ? 1 : 0.25) * free,
		faction: weights.faction * mult("FactionWorkRepGain") * (state.bb?.route === "combat" ? 0.5 : 1),
		company: weights.company,
		cash: weights.cash * mult("CrimeMoney") * 2 * share,
	};
}

function entry(sleeve, role, why, candidates) {
	return { sleeve: sleeve.index, role, why, candidates, keep: sameTask(sleeve.task, candidates[0]) };
}

/** The spending stage for the current income: the last one whose minIncome is reached (stages ascend, the first is 0). */
export function pickStage(stages, perSecond) {
	let stage = stages[0];
	for (const next of stages) if (perSecond >= next.minIncome) stage = next;
	return stage;
}

/** What may be spent now: the smaller of maxFraction of the cash and the cash above the reserve; never negative. */
export function budgetFor(cash, stage) {
	return Math.max(0, Math.min(cash * stage.maxFraction, cash - stage.reserve));
}

/**
 * The next purchase within `budget`, or null. A sleeve first (BitNode 10 only, while the game offers one), then a memory
 * upgrade for the sleeve with the lowest memory, then the sleeve augmentation with the most value per dollar (an augmentation
 * whose value is known to be 0 is never bought; unknown values count 1, so the cheapest goes first).
 * `sleeveBudget` (default: `budget`) is what a sleeve purchase may use: sleeves are permanent and their price is huge next to the stage's share of cash.
 * @param {{ budget: number, sleeveBudget?: number, canBuy: boolean, buy: { sleeves: boolean, memory: boolean, augments: boolean }, sleeveCost: number,
 *   memory: { index: number, memory: number, cost: number }[], augs: { index: number, name: string, cost: number, value?: number }[] }} view
 * @returns {{ type: "sleeve", cost: number } | { type: "memory", index: number, cost: number } | { type: "aug", index: number, name: string, cost: number } | null}
 */
export function nextPurchase(view) {
	const { budget, canBuy, buy } = view;
	if (canBuy && buy.sleeves && Number.isFinite(view.sleeveCost) && view.sleeveCost <= (view.sleeveBudget ?? budget)) return { type: "sleeve", cost: view.sleeveCost };
	if (canBuy && buy.memory) {
		const [row] = view.memory.filter((item) => item.memory < 100 && item.cost <= budget).sort((first, second) => first.memory - second.memory);
		if (row) return { type: "memory", index: row.index, cost: row.cost };
	}
	if (buy.augments) {
		const [row] = view.augs
			.filter((aug) => aug.cost <= budget && (aug.value ?? 1) > 0)
			.sort((first, second) => (second.value ?? 1) / second.cost - (first.value ?? 1) / first.cost);
		if (row) return { type: "aug", index: row.index, name: row.name, cost: row.cost };
	}
	return null;
}
