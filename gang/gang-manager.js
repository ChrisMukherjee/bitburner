// Design: docs/gang.md
import { loadConfig } from "/utils/config.js";
import { notify } from "/utils/notify.js";
import { createPolicyTracker, getBudget, formatMoney } from "/utils/spending.js";
import { startHelper } from "/utils/start-helper.js";

// Ports (see AGENTS.md / README.md).
const SUMMARY_PORT = 28;   // this script's summary, read by tools/status.js
const EQUIPMENT_PORT = 29; // equipment list from workers/gang-equipment.js
const EQUIPMENT_HELPER = "workers/gang-equipment.js";
const TAG = "[gang]";
const COMBAT_STATS = ["str", "def", "dex", "agi"];
// Game cycles are 200ms: the per-cycle rates in getGangInformation are times 5 for per second.
const CYCLES_PER_SECOND = 5;

/**
 * Runs the gang (BitNode 2, or anywhere once you have Source-File 2). Settings are `gang` in the
 * config (config.js, data/config.json).
 *
 * UNTESTED IN GAME: written against the v3.0.0 Gang API before reaching BitNode 2. Every decision
 * is logged (tail the script) so the first run can be checked. Parts most likely to need tuning
 * are marked "UNTESTED" below.
 *
 * What it does, every gang update (about 2s; faster while bonus time lasts):
 *   - No gang yet: creates one with the first faction in gang.factions you're a member of. That
 *     choice decides combat or hacking for good, so only list the factions you want.
 *     In BitNode 2, singularity/player-work.js commits crimes until the first one invites you.
 *   - Recruits whenever respect allows.
 *   - Ascends a member once it multiplies their main stat by gang.ascendAt or more.
 *   - Members below gang.trainLevel train. The rest earn: respect while the gang can still grow
 *     ("auto" focus), money once it's full. Each member gets the task that gives them the most,
 *     found by trying each task and reading the member's gain (no Formulas.exe needed).
 *   - Wanted level: once the wanted penalty passes gang.maxWantedPenalty, the weakest earners
 *     switch to Vigilante Justice / Ethical Hacking until it drops below gang.okWantedPenalty.
 *   - Territory: with a full gang, gang.warfareShare of the trained members build power on
 *     Territory Warfare. Clashes go on when the win chance against every gang that still holds
 *     territory is at least gang.engageAt, and off below gang.disengageAt.
 *   - Buys equipment once a minute: augmentations first (they survive ascension), cheapest
 *     first, only ones that raise the gang's stats. Spending follows gang.buying stages
 *     (reserve + share of cash, as for hacknet and servers).
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

	const info = ns.getResetInfo();
	if (info.currentNode !== 2 && !info.ownedSF.has(2) && !ns.gang.inGang()) {
		notify(ns, TAG, "the Gang API needs BitNode 2 or Source-File 2; exiting.", "warning", true);
		return;
	}

	await waitForGang(ns, settings);
	const gang = ns.gang.getGangInformation();
	const isHacking = gang.isHacking;
	ns.print(`${TAG} gang with ${gang.faction} (${isHacking ? "hacking" : "combat"})`);

	const getPolicy = createPolicyTracker(settings.buying);
	const state = { cooling: false, engaged: gang.territoryWarfareEngaged, members: 0, equipment: null, lastBuy: 0, lastPlan: 0, lastLine: "" };

	while (true) {
		const now = Date.now();
		recruit(ns);
		if (now - state.lastPlan >= settings.planMs) {
			ascend(ns, settings, isHacking);
			assignTasks(ns, settings, isHacking, state, flags["no-war"]);
			state.lastPlan = now;
		}
		setWarfare(ns, settings, state, flags["no-war"]);
		if (!flags["no-buy"] && now - state.lastBuy >= settings.buyMs) {
			buyEquipment(ns, settings, isHacking, state, getPolicy(ns));
			state.lastBuy = now;
		}
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
				`(in BitNode 2, singularity/player-work.js commits crimes for the invite)`;
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
function recruit(ns) {
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

/** The stat that matters for this gang: hacking for a hacking gang, the combat average otherwise. */
function mainStat(member, isHacking) {
	if (isHacking) return member.hack;
	return COMBAT_STATS.reduce((sum, stat) => sum + member[stat], 0) / COMBAT_STATS.length;
}

/** Same for an ascension result (multiplier gains). */
function mainGain(result, isHacking) {
	if (isHacking) return result.hack;
	return COMBAT_STATS.reduce((sum, stat) => sum + result[stat], 0) / COMBAT_STATS.length;
}

/**
 * Ascends members whose main-stat multiplier would grow by gang.ascendAt or more. Ascending resets
 * the member's stats and non-augment equipment and takes away the respect they earned, so it is
 * skipped while that respect is more than gang.ascendMaxRespectShare of the gang's.
 */
function ascend(ns, settings, isHacking) {
	const gang = ns.gang.getGangInformation();
	for (const name of ns.gang.getMemberNames()) {
		const result = ns.gang.getAscensionResult(name); // undefined until they have enough exp
		if (!result) continue;
		const gain = mainGain(result, isHacking);
		if (gain < settings.ascendAt) continue;
		if (result.respect > gang.respect * settings.ascendMaxRespectShare) {
			ns.print(`${TAG} ${name} could ascend (x${gain.toFixed(2)}) but holds ${ns.format.number(result.respect)} of ${ns.format.number(gang.respect)} respect; waiting`);
			continue;
		}
		if (ns.gang.ascendMember(name)) ns.print(`${TAG} ascended ${name}: main stat multiplier x${gain.toFixed(2)}`);
	}
}

/**
 * Gives every member a task. Tries each earning task on each member and reads the member's
 * respect/money/wanted gain back (getMemberInformation computes them for the current task), all
 * within one tick, so the game never runs a cycle on a trial task.
 * UNTESTED: assumes getMemberInformation's gains update right after setMemberTask.
 */
function assignTasks(ns, settings, isHacking, state, noWar) {
	const gang = ns.gang.getGangInformation();
	const names = ns.gang.getMemberNames();
	const full = !(gang.respectForNextRecruit < Infinity);
	if (names.length < state.members) notify(ns, TAG, `lost ${state.members - names.length} member(s) (killed in a clash?)`, "warning");
	state.members = names.length;

	const allTasks = ns.gang.getTaskNames();
	const trainTask = isHacking ? settings.trainTasks.hacking : settings.trainTasks.combat;
	const coolTasks = settings.coolTasks.filter((task) => allTasks.includes(task));
	const special = new Set(["Unassigned", settings.warfareTask, ...coolTasks, ...Object.values(settings.trainTasks)]);
	const earnTasks = allTasks.filter((task) => !special.has(task) && !task.startsWith("Train "));
	const focus = settings.focus === "auto" ? (full ? "money" : "respect") : settings.focus;

	// Wanted penalty: wantedPenalty is the multiplier on gains (1 = no penalty).
	const penalty = 1 - gang.wantedPenalty;
	if (!state.cooling && penalty > settings.maxWantedPenalty) state.cooling = true;
	if (state.cooling && (penalty <= settings.okWantedPenalty || gang.wantedLevel <= 1.05)) state.cooling = false;

	const members = names.map((name) => ({ name, info: ns.gang.getMemberInformation(name) }))
		.sort((first, second) => mainStat(second.info, isHacking) - mainStat(first.info, isHacking));
	const trained = members.filter((member) => mainStat(member.info, isHacking) >= settings.trainLevel);
	const plan = new Map();
	for (const member of members) if (!trained.includes(member)) plan.set(member.name, { task: trainTask, value: 0, wanted: 0 });

	// Territory Warfare for the strongest trained members, once the gang is full and territory is left to take.
	const territoryLeft = gang.territory < 0.9999 && othersWithTerritory(ns, gang.faction).length > 0;
	const warriors = (!noWar && full && territoryLeft) ? Math.round(trained.length * settings.warfareShare) : 0;
	for (const member of trained.slice(0, warriors)) plan.set(member.name, { task: settings.warfareTask, value: 0, wanted: 0 });

	// The rest earn: best task for the focus, by trying each one.
	const earners = [];
	for (const member of trained.slice(warriors)) {
		let best = null;
		let bestCool = null;
		for (const task of [...earnTasks, ...coolTasks]) {
			ns.gang.setMemberTask(member.name, task);
			const after = ns.gang.getMemberInformation(member.name);
			const value = focus === "money" ? after.moneyGain : after.respectGain;
			const trial = { task, value, wanted: after.wantedLevelGain };
			if (coolTasks.includes(task)) {
				if (!bestCool || trial.wanted < bestCool.wanted) bestCool = trial;
			} else if (value > 0 && (!best || value > best.value)) {
				best = trial;
			}
		}
		// Nothing earns yet (stats too low for every task): keep training.
		const choice = best ?? { task: trainTask, value: 0, wanted: 0 };
		plan.set(member.name, choice);
		if (best) earners.push({ name: member.name, choice, cool: bestCool });
	}

	// Cooling: move the weakest earners to the best wanted-lowering task until wanted falls.
	if (state.cooling) {
		let wantedGain = [...plan.values()].reduce((sum, entry) => sum + entry.wanted, 0);
		earners.sort((first, second) => first.choice.value - second.choice.value);
		for (const earner of earners) {
			if (wantedGain < 0 || !earner.cool) break;
			wantedGain += earner.cool.wanted - earner.choice.wanted;
			plan.set(earner.name, earner.cool);
		}
	}

	const counts = {};
	for (const [name, entry] of plan) {
		ns.gang.setMemberTask(name, entry.task);
		counts[entry.task] = (counts[entry.task] ?? 0) + 1;
	}
	state.tasks = counts;
	state.focus = focus;
	const line = `${TAG} ${names.length} members, focus ${focus}${state.cooling ? ", cooling wanted" : ""}: ` +
		Object.entries(counts).map(([task, count]) => `${count} ${task}`).join(", ");
	if (line !== state.lastLine) ns.print(line);
	state.lastLine = line;
}

/** Other gangs that still hold territory. */
function othersWithTerritory(ns, ownFaction) {
	return Object.entries(ns.gang.getAllGangInformation())
		.filter(([name, other]) => name !== ownFaction && other.territory > 0);
}

/**
 * Clashes on when the win chance against every gang still holding territory reaches gang.engageAt,
 * off below gang.disengageAt (or when nobody holds any). Win chance = our power / (ours + theirs),
 * the game's own formula, so getChanceToWinClash (4GB) isn't needed.
 */
function setWarfare(ns, settings, state, noWar) {
	const gang = ns.gang.getGangInformation();
	const others = othersWithTerritory(ns, gang.faction);
	const chances = others.map(([, other]) => gang.power / Math.max(1e-9, gang.power + other.power));
	const worst = chances.length ? Math.min(...chances) : 0;
	state.worstChance = chances.length ? worst : null;
	const engage = !noWar && chances.length > 0 &&
		(state.engaged ? worst >= settings.disengageAt : worst >= settings.engageAt);
	if (engage !== gang.territoryWarfareEngaged) {
		ns.gang.setTerritoryWarfare(engage);
		notify(ns, TAG, `territory clashes ${engage ? "on" : "off"} (worst win chance ${ns.format.percent(worst)})`, "info");
	}
	state.engaged = engage;
}

/**
 * Buys equipment within one pass's budget (gang.buying stages: reserve and share of cash).
 * Augmentations first, since they survive ascension; then cheapest first. Only items that raise
 * a stat the gang uses (combat stats or hacking, plus charisma).
 */
function buyEquipment(ns, settings, isHacking, state, policy) {
	if (!state.equipment) state.equipment = readEquipment(ns);
	if (!state.equipment) return;
	const useful = new Set(isHacking ? ["hack", "cha"] : [...COMBAT_STATS, "cha"]);
	const items = state.equipment
		.filter((item) => Object.entries(item.stats).some(([stat, mult]) => useful.has(stat) && mult > 1))
		.filter((item) => item.type !== "Augmentation" || settings.buyAugmentations)
		.map((item) => ({ ...item, cost: ns.gang.getEquipmentCost(item.name) }))
		.sort((first, second) => (second.type === "Augmentation") - (first.type === "Augmentation") || first.cost - second.cost);

	let budget = getBudget(ns, policy);
	const bought = [];
	for (const item of items) {
		if (item.cost > budget) continue;
		for (const name of ns.gang.getMemberNames()) {
			if (item.cost > budget) break;
			const member = ns.gang.getMemberInformation(name);
			if (member.upgrades.includes(item.name) || member.augmentations.includes(item.name)) continue;
			if (ns.gang.purchaseEquipment(name, item.name)) {
				budget -= item.cost;
				bought.push(`${item.name} for ${name}`);
			}
		}
	}
	if (bought.length) {
		ns.print(`${TAG} bought (${policy.name} stage, ${formatMoney(ns, budget)} of the pass budget left): ${bought.join(", ")}`);
	}
}

/** Equipment names, types and stats from workers/gang-equipment.js (run once; static data). */
function readEquipment(ns) {
	const posted = ns.peek(EQUIPMENT_PORT);
	if (posted && typeof posted === "object" && Array.isArray(posted.items)) return posted.items;
	if (startHelper(ns, EQUIPMENT_HELPER, []) === 0) {
		ns.print(`${TAG} no room yet for ${EQUIPMENT_HELPER}; buying nothing until it has run`);
	}
	return null; // picked up on the next pass
}

/** One summary for tools/status.js. */
function postSummary(ns, state) {
	const gang = ns.gang.getGangInformation();
	ns.clearPort(SUMMARY_PORT);
	ns.writePort(SUMMARY_PORT, {
		time: Date.now(),
		faction: gang.faction,
		isHacking: gang.isHacking,
		members: state.members,
		full: !(gang.respectForNextRecruit < Infinity),
		respect: gang.respect,
		respectPerSecond: gang.respectGainRate * CYCLES_PER_SECOND,
		moneyPerSecond: gang.moneyGainRate * CYCLES_PER_SECOND,
		wantedPenalty: 1 - gang.wantedPenalty,
		cooling: state.cooling,
		territory: gang.territory,
		engaged: state.engaged,
		worstChance: state.worstChance,
		focus: state.focus,
		tasks: state.tasks ?? {},
	});
}
