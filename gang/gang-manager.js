// Design: docs/gang.md
import { loadConfig } from "/utils/config.js";
import { notify } from "/utils/notify.js";
import { createPolicyTracker, getBudget, formatMoney } from "/utils/spending.js";
import { startHelper } from "/utils/start-helper.js";
import { gangAccess } from "/utils/gang.js";
import { bitnodeMults } from "/utils/bitnode-mults.js";
import {
	CYCLES_PER_SECOND, STAT_NAMES, taskWeight, territoryMult, territoryPenalty, wantedFactor, respectRate, moneyRate,
	wantedRate, skillLevel, ascensionPoints, ascensionMult, expRate, memberPower, clashOutlook,
} from "/gang/formulas.js";

// Ports (see AGENTS.md / README.md).
const SUMMARY_PORT = 28;   // this script's summary, read by tools/status.js
const EQUIPMENT_PORT = 29; // equipment list from gang/workers/equipment.js
const EQUIPMENT_HELPER = "gang/workers/equipment.js";
export const LOG_FILE = "data/gang-log.json"; // metric samples, read by gang/gang-report.js
const LOG_KEEP = 288; // samples kept (a day at 5 minutes)
const TAG = "[gang]";
const COMBAT_STATS = ["str", "def", "dex", "agi"];

/**
 * Runs the gang (BitNode 2, or anywhere once you have Source-File 2). Settings are `gang` in the
 * config (config.js, data/config.json). Design and the maths: docs/gang.md.
 *
 * What it does, every gang update (about 2s; faster while bonus time lasts):
 *   - No gang yet: creates one with the first faction in gang.factions you're a member of. That
 *     choice decides combat or hacking for good, so only list the factions you want.
 *     In BitNode 2, singularity/player-work.js commits crimes until the first one invites you.
 *   - Recruits whenever respect allows.
 *   - Growth (gang.growth, on by default): each member either earns or trains, whichever is worth more
 *     over the horizon (the run's age, at least gang.growth.horizonMinSeconds). Training is picked per stat
 *     with the game's own formulas, so charisma and hacking get trained when the best money tasks need them.
 *     A member ascends when the stronger multiplier outweighs the re-training time, the equipment lost and
 *     the respect given up. growth.enabled=false goes back to gang.trainLevel and gang.ascendAt.
 *   - Each earner gets the task that gives the most of the focus ("auto": respect while the gang can still
 *     grow, money once full), by the game's formulas (exact difficulty factors, wanted penalty, land).
 *   - Wanted level: once the wanted penalty passes gang.maxWantedPenalty, the weakest earners
 *     switch to Vigilante Justice / Ethical Hacking until it drops below gang.okWantedPenalty.
 *   - Territory: with a full gang, gang.warfareShare of the trained members build power on Territory
 *     Warfare (the ones whose pay is smallest per point of power). Clashes go on when the land we would
 *     take outweighs the land we would lose (gang.engageAt) and off below gang.disengageAt.
 *   - Buys equipment once a minute, best payback first; augmentations (which survive ascension) get the
 *     whole horizon, other gear only the time until that member's next ascension.
 *   - Logs a metric sample every gang.logMs to data/gang-log.json for gang/gang-report.js.
 *
 *   run gang/gang-manager.js
 *   run gang/gang-manager.js --no-buy    never buy equipment
 *   run gang/gang-manager.js --no-war    never use Territory Warfare or clashes
 */
/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	const flags = ns.flags([["no-buy", false], ["no-war", false]]);
	const settings = loadConfig(ns).gang;

	if (!gangAccess(ns).available) {
		ns.tprint(`${TAG} the Gang API isn't available in this run (needs BitNode 2 or Source-File 2); exiting.`);
		return;
	}

	await waitForGang(ns, settings);
	const gang = ns.gang.getGangInformation();
	const isHacking = gang.isHacking;
	ns.print(`${TAG} gang with ${gang.faction} (${isHacking ? "hacking" : "combat"})`);

	const getPolicy = createPolicyTracker(settings.buying);
	const state = {
		cooling: false, engaged: gang.territoryWarfareEngaged, members: 0, equipment: null, lastBuy: 0, lastPlan: 0, lastLine: "",
		lastLog: 0, ascensions: 0, deaths: 0, startedAt: Date.now(), milestones: {},
	};

	while (true) {
		const now = Date.now();
		recruit(ns);
		if (now - state.lastPlan >= settings.planMs) {
			ascend(ns, settings, isHacking, state);
			assignTasks(ns, settings, isHacking, state, flags["no-war"]);
			state.lastPlan = now;
		}
		setWarfare(ns, settings, state, flags["no-war"]);
		if (!flags["no-buy"] && now - state.lastBuy >= settings.buyMs) {
			buyEquipment(ns, settings, isHacking, state, getPolicy(ns));
			state.lastBuy = now;
		}
		recordMetrics(ns, settings, state);
		postSummary(ns, state);
		await ns.gang.nextUpdate();
	}
}

/** Creates the gang with the first joined faction in gang.factions, waiting until one is joined. */
async function waitForGang(ns, settings) {
	let lastMessage = "";
	while (!ns.gang.inGang()) {
		const joined = ns.getPlayer().factions;
		const faction = settings.factions.find((name) => joined.includes(name));
		let message;
		if (!faction) {
			message = `${TAG} no gang yet: waiting to join one of ${settings.factions.join(", ")} ` +
				`(in BitNode 2, singularity/player-work.js gets the invite: a crime for the karma, the gym for the stats)`;
		} else if (ns.gang.createGang(faction)) {
			notify(ns, TAG, `created a gang with ${faction}`, "success");
			return;
		} else {
			// Outside BitNode 2 this also needs karma -54,000.
			message = `${TAG} couldn't create a gang with ${faction} yet (karma ${ns.format.number(ns.heart.break())}); retrying`;
		}
		if (message !== lastMessage) ns.print(message);
		lastMessage = message;
		await ns.sleep(30_000);
	}
}

/** Recruits as long as respect allows (the first few are free). */
export function recruit(ns) {
	for (let tries = 0; tries < 12; tries++) {
		const gang = ns.gang.getGangInformation();
		if (!(gang.respect >= gang.respectForNextRecruit)) return; // Infinity once full
		const taken = new Set(ns.gang.getMemberNames());
		let number = 1;
		while (taken.has(`member-${number}`)) number++;
		const name = `member-${number}`;
		if (!ns.gang.recruitMember(name)) return;
		ns.print(`${TAG} recruited ${name} (${taken.size + 1} members)`);
	}
}

// ---------------------------------------------------------------------------------------------------
// Member model: what a member is worth now, after an ascension, and after a stretch of training.

/** The stat that matters for this gang: hacking for a hacking gang, the combat average otherwise. */
export function mainStat(member, isHacking) {
	if (isHacking) return member["hack"];
	return COMBAT_STATS.reduce((sum, stat) => sum + member[stat], 0) / COMBAT_STATS.length;
}

/** Same for an ascension result (multiplier gains). */
export function mainGain(result, isHacking) {
	if (isHacking) return result["hack"];
	return COMBAT_STATS.reduce((sum, stat) => sum + result[stat], 0) / COMBAT_STATS.length;
}

/** item name -> item for the equipment list, rebuilt once the worker has posted it. */
function equipIndex(state) {
	if (state.equipment && state.equipIndex?.size !== state.equipment.length) state.equipIndex = new Map(state.equipment.map((item) => [item.name, item]));
	return state.equipIndex;
}

/** Does the member info carry experience? (The real API always does.) */
const hasExp = (info) => typeof info["str_exp"] === "number";

/**
 * A member as the model needs it: current stats, experience, banked ascension points, the total equipment
 * multiplier per stat (`mult`) and the part of it that is augmentations and survives ascension (`aug`).
 * @param {any} info ns.gang.getMemberInformation
 * @param {Map<string, any>} [equipment] item name -> { stats }
 */
export function memberView(info, equipment) {
	const view = { name: info.name, task: info.task, stats: {}, exp: {}, points: {}, asc: {}, mult: {}, aug: {}, earnedRespect: info.earnedRespect ?? 0, raw: info };
	for (const stat of STAT_NAMES) {
		view.stats[stat] = info[stat] ?? 1;
		view.exp[stat] = info[`${stat}_exp`] ?? 0;
		view.points[stat] = info[`${stat}_asc_points`] ?? 0;
		view.asc[stat] = info[`${stat}_asc_mult`] ?? ascensionMult(view.points[stat]);
		view.mult[stat] = info[`${stat}_mult`] ?? 1;
		let aug = 1;
		for (const name of info.augmentations ?? []) aug *= equipment?.get(name)?.stats?.[stat] ?? 1;
		view.aug[stat] = aug;
	}
	return view;
}

/**
 * What the model needs about the gang right now: gang state, the tasks, the focus, and the horizon.
 * @returns {any}
 */
export function planContext(ns, settings, isHacking, state) {
	const gang = ns.gang.getGangInformation();
	const allTasks = ns.gang.getTaskNames();
	state.taskStats ??= Object.fromEntries(allTasks.map((task) => [task, ns.gang.getTaskStats(task)])); // fixed for the game
	const full = !(gang.respectForNextRecruit < Infinity);
	const coolNames = settings.coolTasks.filter((task) => allTasks.includes(task));
	const special = new Set(["Unassigned", settings.warfareTask, ...coolNames]);
	const usable = (name) => { const stats = state.taskStats[name]; return stats && (isHacking ? stats.isHacking : stats.isCombat); };
	const trainNames = allTasks.filter((name) => name.startsWith("Train ") && usable(name));
	const earnNames = allTasks.filter((name) => !special.has(name) && !name.startsWith("Train ") && usable(name) && state.taskStats[name].baseWanted >= 0);
	const coolable = coolNames.filter(usable);
	const growth = settings.growth ?? { enabled: false };
	return {
		gang: { respect: gang.respect, wanted: gang.wantedLevel, territory: gang.territory, softcap: bitnodeMults(ns).get("GangSoftcap") },
		info: gang, tasks: state.taskStats, full, isHacking, growth,
		focus: settings.focus === "auto" ? (full ? "money" : "respect") : settings.focus,
		trainNames, earnNames, coolNames: coolable,
		trainDefault: isHacking ? settings.trainTasks.hacking : settings.trainTasks.combat,
		horizon: horizonSeconds(ns, growth),
	};
}

/** How far ahead growth is valued: the run's age (invest while it pays back within the time played), within limits. */
export function horizonSeconds(ns, growth) {
	let age = 0;
	try { age = (Date.now() - ns.getResetInfo().lastNodeReset) / 1000; } catch { /* no reset info: use the minimum */ }
	return Math.min(growth.horizonMaxSeconds ?? 86_400, Math.max(growth.horizonMinSeconds ?? 3600, age));
}

/** The best earning task for these stats under the focus: { task, value, money, respect, wanted } (value 0: nothing pays yet). */
export function bestEarn(stats, ctx, gang = ctx.gang) {
	let best = { task: null, value: 0, money: 0, respect: 0, wanted: 0 };
	for (const name of ctx.earnNames) {
		const task = ctx.tasks[name];
		const money = moneyRate(task, stats, gang);
		const respect = respectRate(task, stats, gang);
		const value = ctx.focus === "money" ? money : respect;
		if (value > best.value) best = { task: name, value, money, respect, wanted: wantedRate(task, stats, gang) };
	}
	return best;
}

/**
 * Experience a member would gain per second in every stat on one task.
 * @returns {Record<string, number>}
 */
function expGains(view, task) {
	const gains = {};
	for (const stat of STAT_NAMES) gains[stat] = expRate(task, stat, view.mult[stat], view.asc[stat]);
	return gains;
}

/**
 * The stats the member would have a few minutes after an ascension, given the experience it has (plus
 * `extra` per stat): banked multiplier x augmentation multiplier x the level that `recoverySeconds` of
 * training (the fastest training task for each stat) rebuilds. This is what experience is worth, since
 * stats grow with the log of experience but the banked multiplier with its square root.
 */
export function potentialStats(view, ctx, extra = {}) {
	const stats = {};
	const recovery = ctx.growth.recoverySeconds ?? 300;
	for (const stat of STAT_NAMES) {
		const bank = ascensionMult(view.points[stat] + ascensionPoints(view.exp[stat] + (extra[stat] ?? 0)));
		const expMult = view.aug[stat];
		let rate = 0;
		for (const name of ctx.trainNames) rate = Math.max(rate, expRate(ctx.tasks[name], stat, expMult, bank));
		stats[stat] = skillLevel(rate * recovery, bank * expMult);
	}
	return stats;
}

/** How fast doing `task` raises what the member could earn after an ascension (value per second per second). */
function growthRate(view, ctx, task, base, seconds) {
	const gains = expGains(view, task);
	const extra = {};
	for (const stat of STAT_NAMES) extra[stat] = gains[stat] * seconds;
	return (bestEarn(potentialStats(view, ctx, extra), ctx).value - base) / seconds;
}

/**
 * Earn or train, for one member. Each option scores what it pays now plus the growth it buys over the horizon:
 * earn = best task's value + its (small) experience; train = the experience of a Train task, nothing paid.
 * @returns {{ kind: "earn"|"train", task: string, value: number, wanted: number, earnValue: number, score: number }}
 */
export function chooseAction(view, ctx) {
	const earn = bestEarn(view.stats, ctx);
	const base = bestEarn(potentialStats(view, ctx), ctx).value;
	const probe = Math.min(ctx.growth.probeMaxSeconds ?? 7200, Math.max(600, ctx.horizon / 2));
	let train = { task: ctx.trainDefault, score: 0 };
	for (const name of ctx.trainNames) {
		const score = growthRate(view, ctx, ctx.tasks[name], base, probe) * ctx.horizon;
		if (score > train.score) train = { task: name, score };
	}
	const earnScore = earn.task ? earn.value + growthRate(view, ctx, ctx.tasks[earn.task], base, probe) * ctx.horizon : 0;
	if (earn.task && earnScore >= train.score) {
		return { kind: "earn", task: earn.task, value: earn.value, wanted: earn.wanted, earnValue: earn.value, score: earnScore };
	}
	return { kind: "train", task: train.task, value: 0, wanted: 0, earnValue: earn.value, score: train.score };
}

// ---------------------------------------------------------------------------------------------------
// Ascension

/** Fastest experience per second a stat can get from any training task at this banked and equipment multiplier. */
function bestTrainRate(ctx, stat, expMult, bank) {
	let rate = 0;
	for (const name of ctx.trainNames) rate = Math.max(rate, expRate(ctx.tasks[name], stat, expMult, bank));
	return rate;
}

/** Stats `seconds` into a stretch of training that starts at `exp` with this banked multiplier. */
function pathStats(ctx, exp, bank, expMult, seconds) {
	const stats = {};
	for (const stat of STAT_NAMES) {
		const gained = bestTrainRate(ctx, stat, expMult[stat], bank[stat]) * seconds;
		stats[stat] = skillLevel(exp[stat] + gained, bank[stat] * expMult[stat]);
	}
	return stats;
}

/**
 * Should this member ascend? Ascending banks its experience as a multiplier (stats grow with the log of
 * experience, the multiplier with its square root) but resets the stats to the multiplier alone, drops
 * non-augmentation gear and takes away the respect it earned. Two tests: a full training cycle of
 * experience has built up (growth.cycleSeconds), and following both paths for the next stretch (half the
 * horizon, 10 minutes to the probe limit) the pay gained by going, summed over the stretch so the dip right
 * after the ascension counts, covers the gear to rebuy (when money is the focus) and the respect given up.
 * `extra` adds experience first (for "when would it ascend").
 * @returns {{ go: boolean, gap: number, before: number }}
 */
export function ascensionVerdict(view, ctx, ns, extra = {}) {
	const exp = {};
	const gainedPoints = {};
	let any = false;
	for (const stat of STAT_NAMES) {
		exp[stat] = view.exp[stat] + (extra[stat] ?? 0);
		gainedPoints[stat] = ascensionPoints(exp[stat]);
		if (gainedPoints[stat] > 0) any = true;
	}
	if (!any) return { go: false, gap: 0, before: 0 };
	// Not before a full training cycle's worth of experience has built up: ascending costs the first 1000 exp of
	// every cycle and a stat reset, so cycles that are too short never get anywhere (simulated: 2-minute cycles
	// stall at multiplier 1.4 where 15 to 60 minutes reach 50 in twelve hours).
	const cycle = ctx.growth.cycleSeconds ?? 1500;
	let ripe = false;
	for (const stat of STAT_NAMES) {
		const rate = bestTrainRate(ctx, stat, view.mult[stat], ascensionMult(view.points[stat]));
		if (rate > 0 && exp[stat] >= 1000 + rate * cycle) ripe = true;
	}
	if (!ripe) return { go: false, gap: 0, before: 0 };
	const bankNow = {};
	const bankNext = {};
	for (const stat of STAT_NAMES) {
		bankNow[stat] = ascensionMult(view.points[stat]);
		bankNext[stat] = ascensionMult(view.points[stat] + gainedPoints[stat]);
	}
	const length = Math.min(ctx.growth.probeMaxSeconds ?? 7200, Math.max(600, ctx.horizon / 2));
	const slices = 8;
	const zero = Object.fromEntries(STAT_NAMES.map((stat) => [stat, 0]));
	// Respect given up lowers the share of gains that survives the wanted level.
	const lost = Math.min(view.earnedRespect, ctx.gang.respect - 1);
	const penaltyShare = Math.pow(wantedFactor({ ...ctx.gang, respect: ctx.gang.respect - lost }) / wantedFactor(ctx.gang), territoryPenalty(ctx.gang));
	let gap = 0;
	let stayTotal = 0;
	for (let slice = 0; slice < slices; slice++) {
		const at = (slice + 0.5) * length / slices;
		const stay = bestEarn(pathStats(ctx, exp, bankNow, view.mult, at), ctx).value;
		const go = bestEarn(pathStats(ctx, zero, bankNext, view.aug, at), ctx).value * penaltyShare;
		gap += (go - stay) * length / slices;
		stayTotal += stay;
	}
	const before = bestEarn(view.stats, ctx).value;
	if (stayTotal <= 0 && gap <= 0) {
		// Nothing pays on either path yet: go by the multiplier gain on the main stat against the recovery time.
		const next = { points: Object.fromEntries(STAT_NAMES.map((stat) => [stat, view.points[stat] + gainedPoints[stat]])) };
		return { go: mainRatio(view, next, ctx.isHacking) - 1 >= (ctx.growth.recoverySeconds ?? 300) / ctx.horizon, gap, before };
	}
	let rebuy = 0;
	if (ctx.focus === "money" && ns) {
		for (const name of view.raw.upgrades ?? []) rebuy += ns.gang.getEquipmentCost(name);
	}
	return { go: gap > rebuy, gap, before };
}

/** Banked-multiplier gain on the gang's main stat(s), un-weighted. */
function mainRatio(view, next, isHacking) {
	const stats = isHacking ? ["hack"] : COMBAT_STATS;
	const ratios = stats.map((stat) => ascensionMult(next.points[stat]) / ascensionMult(view.points[stat]));
	return ratios.reduce((sum, value) => sum + value, 0) / ratios.length;
}

/**
 * Ascends the members whose verdict says so (or, with growth off, whose main-stat multiplier would grow by
 * gang.ascendAt, unless they hold more than gang.ascendMaxRespectShare of the gang's respect).
 */
export function ascend(ns, settings, isHacking, state = {}) {
	const growth = settings.growth?.enabled;
	let ctx = null;
	if (growth) {
		ctx = planContext(ns, settings, isHacking, state);
	}
	const gang = ns.gang.getGangInformation();
	for (const name of ns.gang.getMemberNames()) {
		const result = ns.gang.getAscensionResult(name); // undefined until they have enough exp
		if (!result) continue;
		const gain = mainGain(result, isHacking);
		let go;
		if (growth) {
			const info = ns.gang.getMemberInformation(name);
			if (hasExp(info)) {
				go = ascensionVerdict(memberView(info, equipIndex(state)), ctx, ns).go;
			} else {
				go = gain >= 1 + (ctx.growth.recoverySeconds ?? 300) / ctx.horizon;
			}
		} else {
			go = gain >= settings.ascendAt;
			if (go && result.respect > gang.respect * settings.ascendMaxRespectShare) {
				ns.print(`${TAG} ${name} could ascend (x${gain.toFixed(2)}) but holds ${ns.format.number(result.respect)} of ${ns.format.number(gang.respect)} respect; waiting`);
				continue;
			}
		}
		if (!go) continue;
		if (ns.gang.ascendMember(name)) {
			state.ascensions = (state.ascensions ?? 0) + 1;
			ns.print(`${TAG} ascended ${name}: main stat multiplier x${gain.toFixed(2)}`);
		}
	}
}

// ---------------------------------------------------------------------------------------------------
// Tasks

/**
 * Gives every member a task. Growth: earn or train per member (chooseAction). Territory: the cheapest
 * earners per point of power build it. Wanted: the weakest earners cool it. All scored with the game's formulas.
 */
export function assignTasks(ns, settings, isHacking, state, noWar) {
	const ctx = planContext(ns, settings, isHacking, state);
	const gang = ctx.info;
	const names = ns.gang.getMemberNames();
	if (names.length < state.members) {
		state.deaths = (state.deaths ?? 0) + state.members - names.length;
		notify(ns, TAG, `lost ${state.members - names.length} member(s) (killed in a clash?)`, "warning");
	}
	state.members = names.length;
	const growth = ctx.growth.enabled;

	// Wanted penalty: wantedPenalty is the multiplier on gains (1 = no penalty).
	const penalty = 1 - gang.wantedPenalty;
	if (!state.cooling && penalty > settings.maxWantedPenalty) state.cooling = true;
	if (state.cooling && (penalty <= settings.okWantedPenalty || gang.wantedLevel <= 1.05)) state.cooling = false;

	const members = names.map((name) => {
		const info = ns.gang.getMemberInformation(name);
		return { name, info, view: memberView(info, equipIndex(state)) };
	});
	const plan = new Map(); // name -> { kind, task, value, wanted, earnValue }
	for (const member of members) {
		if (growth && hasExp(member.info)) {
			member.action = chooseAction(member.view, ctx);
		} else {
			// Growth off (or no experience data): train below gang.trainLevel, else the best earning task.
			const earn = bestEarn(member.view.stats, ctx);
			const trained = mainStat(member.info, isHacking) >= settings.trainLevel && earn.task;
			member.action = trained
				? { kind: "earn", task: earn.task, value: earn.value, wanted: earn.wanted, earnValue: earn.value }
				: { kind: "train", task: ctx.trainDefault, value: 0, wanted: 0, earnValue: earn.value };
		}
		plan.set(member.name, member.action);
	}

	// Keep some cash flow and respect coming: at least growth.minEarnShare of the gang earns (the trainees who would give up
	// the most pay are the ones kept earning), however good training looks. Respect is what recruits the rest of the gang.
	if (growth) {
		const minEarners = Math.max(1, Math.ceil(members.length * (ctx.growth.minEarnShare ?? 1 / 3)));
		const earners = members.filter((member) => plan.get(member.name).kind === "earn").length;
		const spare = members.filter((member) => member.action.kind === "train" && member.action.earnValue > 0)
			.sort((first, second) => second.action.earnValue - first.action.earnValue);
		for (const member of spare.slice(0, Math.max(0, minEarners - earners))) {
			const earn = bestEarn(member.view.stats, ctx);
			plan.set(member.name, { kind: "earn", task: earn.task, value: earn.value, wanted: earn.wanted, earnValue: earn.value });
		}
	} else if (!ctx.full) {
		const minEarners = Math.max(1, Math.ceil(members.length / 3));
		const earners = members.filter((member) => plan.get(member.name).kind === "earn").length;
		const spare = members.filter((member) => member.action.kind === "train" && member.action.earnValue > 0)
			.sort((first, second) => second.action.earnValue - first.action.earnValue);
		for (const member of spare.slice(0, Math.max(0, minEarners - earners))) {
			const earn = bestEarn(member.view.stats, ctx);
			plan.set(member.name, { kind: "earn", task: earn.task, value: earn.value, wanted: earn.wanted, earnValue: earn.value });
		}
	}

	// Territory Warfare for the earners that lose the least pay per point of power, once the gang is full and land is left.
	const territoryLeft = gang.territory < 0.9999 && othersWithTerritory(ns, gang.faction).length > 0;
	const earning = members.filter((member) => plan.get(member.name).kind === "earn");
	const warriors = (!noWar && ctx.full && territoryLeft) ? Math.round(earning.length * settings.warfareShare) : 0;
	earning.sort((first, second) => cheapness(first, plan) - cheapness(second, plan));
	for (const member of earning.slice(0, warriors)) {
		plan.set(member.name, { kind: "war", task: settings.warfareTask, value: 0, wanted: 0, earnValue: plan.get(member.name).earnValue });
	}

	// Cooling: move the weakest earners to the best wanted-lowering task until the wanted level falls.
	if (state.cooling) {
		let wantedGain = [...plan.values()].reduce((sum, entry) => sum + entry.wanted, 0);
		const candidates = members.filter((member) => plan.get(member.name).kind === "earn")
			.sort((first, second) => plan.get(first.name).value - plan.get(second.name).value);
		for (const member of candidates) {
			if (wantedGain < 0) break;
			let cool = null;
			for (const name of ctx.coolNames) {
				const rate = wantedRate(ctx.tasks[name], member.view.stats, ctx.gang);
				if (rate < 0 && (!cool || rate < cool.wanted)) cool = { kind: "cool", task: name, value: 0, wanted: rate, earnValue: plan.get(member.name).earnValue };
			}
			if (!cool) continue;
			wantedGain += cool.wanted - plan.get(member.name).wanted;
			plan.set(member.name, cool);
		}
	}

	const counts = {};
	const kinds = {};
	for (const [name, entry] of plan) {
		ns.gang.setMemberTask(name, entry.task);
		counts[entry.task] = (counts[entry.task] ?? 0) + 1;
		kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1;
	}
	state.tasks = counts;
	state.kinds = kinds;
	state.focus = ctx.focus;
	state.horizon = ctx.horizon;
	state.ceiling = ceilingMoney(members, ctx);
	state.avgMain = members.length ? members.reduce((sum, member) => sum + mainStat(member.info, isHacking), 0) / members.length : 0;
	state.minMain = members.length ? Math.min(...members.map((member) => mainStat(member.info, isHacking))) : 0;
	const line = `${TAG} ${names.length} members, focus ${ctx.focus}${state.cooling ? ", cooling wanted" : ""}: ` +
		Object.entries(counts).map(([task, count]) => `${count} ${task}`).join(", ");
	if (line !== state.lastLine) ns.print(line);
	state.lastLine = line;
}

/** Pay given up per point of power when a member does Territory Warfare (lower = a better warrior). */
function cheapness(member, plan) {
	return plan.get(member.name).earnValue / Math.max(1e-9, memberPower(member.view.stats));
}

/** Money per second if every member did its best money task with no wanted penalty: the ceiling to compare income with. */
function ceilingMoney(members, ctx) {
	const clean = { ...ctx.gang, wanted: 0 };
	let total = 0;
	for (const member of members) {
		let best = 0;
		for (const name of ctx.earnNames) best = Math.max(best, moneyRate(ctx.tasks[name], member.view.stats, clean));
		total += best;
	}
	return total;
}

/** Other gangs that still hold territory. */
export function othersWithTerritory(ns, ownFaction) {
	return Object.entries(ns.gang.getAllGangInformation())
		.filter(([name, other]) => name !== ownFaction && other.territory > 0);
}

/**
 * Clashes on when the share of contested land we would take (clashOutlook: win chance and the land each
 * win or loss moves, over every gang still holding territory) reaches gang.engageAt, off below
 * gang.disengageAt (or when nobody holds any).
 */
export function setWarfare(ns, settings, state, noWar) {
	const gang = ns.gang.getGangInformation();
	const others = othersWithTerritory(ns, gang.faction).map(([, other]) => other);
	const outlook = others.length ? clashOutlook({ power: gang.power, territory: gang.territory }, others) : null;
	state.outlook = outlook; // kept for the status line: now the outlook, not the worst single chance
	const engage = !noWar && outlook !== null &&
		(state.engaged ? outlook >= settings.disengageAt : outlook >= settings.engageAt);
	if (engage !== gang.territoryWarfareEngaged) {
		ns.gang.setTerritoryWarfare(engage);
		notify(ns, TAG, `territory clashes ${engage ? "on" : "off"} (land outlook ${ns.format.percent(outlook ?? 0)})`, "info");
	}
	state.engaged = engage;
}

// ---------------------------------------------------------------------------------------------------
// Equipment

/**
 * Buys equipment within one pass's budget (gang.buying stages: reserve and share of cash). With growth on:
 * every (item, member) is valued by what it adds to the member's pay and bought best payback first when the
 * payback fits the item's horizon (the run's age for augmentations; for other gear, until the member's next
 * ascension wipes it). With growth off: augmentations first, then cheapest first. Only items that raise a stat
 * the gang uses.
 */
export function buyEquipment(ns, settings, isHacking, state, policy) {
	if (!state.equipment) state.equipment = readEquipment(ns);
	if (!state.equipment) return;
	const growthOn = settings.growth?.enabled;
	// With growth on, every item is valued by what it adds; without, only items for the stats the gang is built on.
	const useful = new Set(isHacking ? ["hack", "cha"] : [...COMBAT_STATS, "cha"]);
	const items = state.equipment
		.filter((item) => growthOn || Object.entries(item.stats).some(([stat, mult]) => useful.has(stat) && mult > 1))
		.filter((item) => item.type !== "Augmentation" || settings.buyAugmentations)
		.map((item) => ({ ...item, cost: ns.gang.getEquipmentCost(item.name) }));

	let budget = getBudget(ns, policy);
	const bought = [];
	const buy = (item, name) => {
		if (!ns.gang.purchaseEquipment(name, item.name)) return false;
		budget -= item.cost;
		bought.push(`${item.name} for ${name}`);
		return true;
	};

	if (growthOn) {
		const ctx = planContext(ns, settings, isHacking, state);
		const offers = [];
		for (const name of ns.gang.getMemberNames()) {
			const info = ns.gang.getMemberInformation(name);
			if (!hasExp(info)) continue;
			const view = memberView(info, equipIndex(state));
			const owned = new Set([...(info.upgrades ?? []), ...(info.augmentations ?? [])]);
			let leaves = null; // seconds until this member's next ascension (found once, only if gear needs it)
			for (const item of items) {
				if (owned.has(item.name) || item.cost > budget) continue;
				const aug = item.type === "Augmentation";
				let horizon = ctx.horizon;
				if (!aug) {
					leaves ??= secondsToAscension(ns, view, ctx);
					horizon = Math.min(horizon, leaves);
				}
				const gain = equipmentGain(view, ctx, item, aug);
				if (gain <= 0) continue;
				const payback = item.cost / gain;
				if (payback <= horizon) offers.push({ item, name, payback });
			}
		}
		offers.sort((first, second) => first.payback - second.payback);
		for (const offer of offers) if (offer.item.cost <= budget) buy(offer.item, offer.name);
	} else {
		items.sort((first, second) => (second.type === "Augmentation") - (first.type === "Augmentation") || first.cost - second.cost);
		for (const item of items) {
			if (item.cost > budget) continue;
			for (const name of ns.gang.getMemberNames()) {
				if (item.cost > budget) break;
				const member = ns.gang.getMemberInformation(name);
				if (member.upgrades.includes(item.name) || member.augmentations.includes(item.name)) continue;
				buy(item, name);
			}
		}
	}
	if (bought.length) {
		ns.print(`${TAG} bought (${policy.name} stage, ${formatMoney(ns, budget)} of the pass budget left): ${bought.join(", ")}`);
	}
}

/** Extra money per second an item gives a member: augmentations on its post-ascension stats, other gear on its current stats. */
function equipmentGain(view, ctx, item, aug) {
	const bump = (table) => Object.fromEntries(STAT_NAMES.map((stat) => [stat, table[stat] * (item.stats[stat] > 1 ? item.stats[stat] : 1)]));
	const moneyCtx = { ...ctx, focus: "money" };
	if (aug) {
		const better = { ...view, aug: bump(view.aug) };
		return bestEarn(potentialStats(better, moneyCtx), moneyCtx).value - bestEarn(potentialStats(view, moneyCtx), moneyCtx).value;
	}
	const stats = {};
	for (const stat of STAT_NAMES) stats[stat] = skillLevel(view.exp[stat], view.mult[stat] * (item.stats[stat] > 1 ? item.stats[stat] : 1) * view.asc[stat]);
	const now = {};
	for (const stat of STAT_NAMES) now[stat] = skillLevel(view.exp[stat], view.mult[stat] * view.asc[stat]);
	return bestEarn(stats, moneyCtx).value - bestEarn(now, moneyCtx).value;
}

/** Seconds until the member would ascend, at the experience its task gives (doubling search; Infinity if beyond the horizon). */
export function secondsToAscension(ns, view, ctx) {
	const task = ctx.tasks[view.task] ?? ctx.tasks[ctx.trainDefault];
	if (!task) return ctx.horizon;
	const gains = expGains(view, task);
	for (let seconds = 60; seconds <= ctx.horizon; seconds *= 2) {
		const extra = {};
		for (const stat of STAT_NAMES) extra[stat] = gains[stat] * seconds;
		if (ascensionVerdict(view, ctx, ns, extra).go) return seconds;
	}
	return ctx.horizon;
}

/** Equipment names, types and stats from gang/workers/equipment.js (run once; static data). */
function readEquipment(ns) {
	const posted = ns.peek(EQUIPMENT_PORT);
	if (posted && typeof posted === "object" && Array.isArray(posted.items)) return posted.items;
	if (startHelper(ns, EQUIPMENT_HELPER, []) === 0) {
		ns.print(`${TAG} no room yet for ${EQUIPMENT_HELPER}; buying nothing until it has run`);
	}
	return null; // picked up on the next pass
}

// ---------------------------------------------------------------------------------------------------
// Metrics

/** One metric sample (also what the report script prints). */
export function metricSample(gang, state) {
	const money = gang.moneyGainRate * CYCLES_PER_SECOND;
	return {
		t: Date.now(), members: state.members, money, respect: gang.respect, respectRate: gang.respectGainRate * CYCLES_PER_SECOND,
		penalty: 1 - gang.wantedPenalty, wanted: gang.wantedLevel, territory: gang.territory, power: gang.power,
		engaged: !!state.engaged, kinds: state.kinds ?? {}, ascensions: state.ascensions ?? 0, deaths: state.deaths ?? 0,
		avgMain: state.avgMain ?? 0, minMain: state.minMain ?? 0, ceiling: state.ceiling ?? 0,
		efficiency: state.ceiling ? money / state.ceiling : null, horizon: state.horizon ?? 0,
	};
}

/** Notes when the gang first fills up and first owns all land, and appends a sample to data/gang-log.json every gang.logMs. */
export function recordMetrics(ns, settings, state) {
	const gang = ns.gang.getGangInformation();
	const since = Math.round((Date.now() - state.startedAt) / 1000);
	state.milestones ??= {};
	if (!state.milestones.full && !(gang.respectForNextRecruit < Infinity)) state.milestones.full = since;
	if (!state.milestones.landAll && gang.territory >= 0.9999) state.milestones.landAll = since;
	if (!state.milestones.firstClash && gang.territoryWarfareEngaged) state.milestones.firstClash = since;
	if (!settings.logMs || Date.now() - state.lastLog < settings.logMs) return;
	state.lastLog = Date.now();
	let samples = [];
	try { samples = JSON.parse(ns.read(LOG_FILE)).samples ?? []; } catch { /* first sample */ }
	samples.push(metricSample(gang, state));
	ns.write(LOG_FILE, JSON.stringify({ milestones: state.milestones, samples: samples.slice(-LOG_KEEP) }), "w");
}

/** One summary for tools/status.js. */
function postSummary(ns, state) {
	const gang = ns.gang.getGangInformation();
	const money = (amount) => "$" + ns.format.number(amount);
	const tasks = Object.entries(state.tasks ?? {}).map(([task, count]) => `${count} ${task}`).join(", ");
	const full = !(gang.respectForNextRecruit < Infinity);
	const kinds = state.kinds ?? {};
	const rate = gang.moneyGainRate * CYCLES_PER_SECOND;
	const efficiency = state.ceiling ? ` (${ns.format.percent(rate / state.ceiling)} of the ${money(state.ceiling)}/s ceiling)` : "";
	// Ready-made lines in the shared mechanic summary format { time, title, script, lines } that
	// tools/status.js shows as they are.
	ns.clearPort(SUMMARY_PORT);
	ns.writePort(SUMMARY_PORT, {
		time: Date.now(),
		title: "Gang",
		script: "gang/gang-manager.js",
		lines: [
			`${gang.faction} (${gang.isHacking ? "hacking" : "combat"}), ${state.members}${full ? " (full)" : ""} members, ` +
				`${money(rate)}/s${efficiency}, respect ${ns.format.number(gang.respect)} ` +
				`(+${ns.format.number(gang.respectGainRate * CYCLES_PER_SECOND)}/s), ` +
				`wanted penalty ${ns.format.percent(1 - gang.wantedPenalty)}${state.cooling ? " (cooling)" : ""}`,
			`territory ${ns.format.percent(gang.territory)}, clashes ${state.engaged ? "on" : "off"}` +
				(state.outlook == null ? "" : ` (land outlook ${ns.format.percent(state.outlook)})`) +
				` | focus ${state.focus} | ${tasks}`,
			`${kinds.earn ?? 0} earning, ${kinds.train ?? 0} training, ${kinds.war ?? 0} warfare, ${kinds.cool ?? 0} cooling | ` +
				`${state.ascensions ?? 0} ascensions, ${state.deaths ?? 0} deaths | main stat avg ${ns.format.number(state.avgMain ?? 0)}, ` +
				`weakest ${ns.format.number(state.minMain ?? 0)}`,
		],
		metrics: metricSample(gang, state),
	});
}
