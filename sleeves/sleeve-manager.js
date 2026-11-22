// Design: docs/sleeves.md
// @ts-check
import { loadConfig } from "/utils/config.js";
import { startHelper } from "/utils/start-helper.js";
import { adviseMissing } from "/utils/api-advice.js";
import { sleevesApiFromInfo } from "/utils/sleeves.js";
import { singularityFromInfo } from "/utils/singularity.js";
import { postPass } from "/utils/pass-log.js";
import { bladeburnerState, trainFloor, bladeburnerPlan, readBladeburner } from "/bladeburner/state.js";
import { karmaNeededFromInfo } from "/utils/gang-karma.js";
import { bitnodeMults } from "/utils/bitnode-mults.js";
import { readIncomeRate } from "/utils/income.js";
import { readRouteFocus } from "/utils/route-focus.js";
import { planSleeves, jobValues, family, pickCashCrime, SUMMARY_PORT, RESULT_PORT, CRIME_STATS_PORT } from "/sleeves/plan.js";

// Ports read from other scripts (see docs/NETSCRIPT.md).
const GOALS_PORT = 23;        // faction rep goals (singularity/workers/faction-goals.js)
const INVITE_PORT = 30;       // what the gang invite needs (gang/workers/invite.js)
const PLAYER_WORK_PORT = 35;  // player-work.js's state (lastGoalFaction: the faction the player grinds)
const GOALS_MAX_AGE_MS = 3600_000;
const INVITE_MAX_AGE_MS = 15 * 60_000;
const SCRIPT = "sleeves/sleeve-manager.js";

// One-shot workers (each holds only the 4GB calls it needs, so this script stays at 20.3GB). `xImports` lists the files a
// worker imports, copied along when it runs on another server.
export const CONFIG = {
	recoverHelper: "sleeves/workers/recover.js", recoverImports: [],
	crimeHelper: "sleeves/workers/crime.js", crimeImports: [],
	trainHelper: "sleeves/workers/train.js", trainImports: [],
	workHelper: "sleeves/workers/work.js", workImports: [],
	bladeHelper: "sleeves/workers/blade.js", bladeImports: [],
	statsHelper: "sleeves/workers/crime-stats.js", statsImports: [],
};

/**
 * One pass over the sleeves: gives each its job (sleeves/plan.js decides, docs/sleeves.md explains) and posts a summary for
 * `status` on port 40. startup.js runs it every minute while the Sleeve API works (BitNode 10, or Source-File 10); settings are
 * `sleeves` in the config (`sleeves.enabled: false` stops it). It never touches the player: player-work.js owns that.
 * 20.3GB, plus the worker it starts for a moment (4 to 12GB).
 */
/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	const config = loadConfig(ns);
	if (config.sleeves?.enabled === false) return;
	if (config.sleeves?.manage === false) return; // no jobs, no experience (the BN10 challenge)
	const info = ns.getResetInfo();
	if (!sleevesApiFromInfo(info)) {
		adviseMissing(ns, "sleeves", info, config);
		return;
	}
	const count = ns.sleeve.getNumSleeves();
	if (count === 0) {
		post(ns, ["no sleeves yet (sleeve-shop.js buys the first in BitNode 10)"], [], null);
		return;
	}

	const player = ns.getPlayer();
	const sleeves = [];
	for (let index = 0; index < count; index++) {
		const person = ns.sleeve.getSleeve(index);
		sleeves.push({
			index, shock: person.shock, sync: person.sync, memory: person.memory, city: person.city,
			skills: person.skills, mults: person.mults, task: ns.sleeve.getTask(index),
		});
	}
	const crimes = await crimeStats(ns, info);
	const karma = karmaRate(ns, player.karma);
	const state = {
		sleeves, cash: player.money, joined: player.factions, jobs: /** @type {Record<string, string>} */ (player.jobs ?? {}),
		goals: fresh(ns, GOALS_PORT, GOALS_MAX_AGE_MS)?.goals ?? null,
		playerFaction: String(peekJson(ns, PLAYER_WORK_PORT)?.lastGoalFaction ?? ""),
		invite: fresh(ns, INVITE_PORT, INVITE_MAX_AGE_MS),
		bb: { state: bladeburnerState(ns), trainFloor: trainFloor(ns), route: bladeburnerPlan(ns)?.route, freeShare: readBladeburner(ns).freeShare, contractCounts: contractCounts(ns) },
		karmaLeft: Math.max(0, player.karma - karmaNeededFromInfo(info)), karmaRate: karma.rate,
		mults: bitnodeMults(ns), incomePerSecond: readIncomeRate(ns).perSecond,
		crimes, focus: readRouteFocus(ns),
	};
	const plan = planSleeves(state, config);

	// Send what changed, one worker per kind of job; a sleeve whose job the game refused falls back to cash crime.
	const lines = [];
	const failed = [];
	for (const name of ["recover", "crime", "train", "work", "blade"]) {
		const items = plan.filter((entry) => !entry.keep && family(entry.candidates[0]) === name)
			.map((entry) => ({ sleeve: entry.sleeve, candidates: entry.candidates }));
		if (!items.length) continue;
		const results = await runWorker(ns, name, items);
		if (!results) {
			lines.push(`no room for the ${name} worker (${ns.format.ram(ns.getScriptRam(CONFIG[`${name}Helper`]))}); trying again next pass`);
			continue;
		}
		for (const result of results) if (!result.ok) failed.push(result.sleeve);
	}
	if (failed.length) {
		const items = failed.map((index) => {
			const sleeve = sleeves.find((item) => item.index === index);
			const { crime } = pickCashCrime(sleeve, crimes, config.sleeves.crimeLadder, config.sleeves.minCrimeChance);
			const entry = plan.find((item) => item.sleeve === index);
			Object.assign(entry, { role: "cash", why: `${entry.why} refused; ${crime} for cash`, keep: false });
			return { sleeve: index, candidates: [{ kind: "crime", crime }] };
		});
		await runWorker(ns, "crime", items);
	}

	const roles = plan.map((entry) => entry.role);
	const tally = [...new Set(roles)].map((role) => `${roles.filter((item) => item === role).length} ${role}`).join(", ");
	lines.unshift(`${count} sleeve${count === 1 ? "" : "s"}: ${tally}`);
	if (config.sleeves.priority !== "fixed") {
		const values = jobValues(state, config);
		lines.push(`job values: ${Object.entries(values).map(([role, value]) => `${role} ${Math.round(value * 10) / 10}`).join(", ")}`);
	}
	for (const entry of plan) {
		const sleeve = sleeves[entry.sleeve];
		lines.push(`#${entry.sleeve} ${entry.why} (shock ${Math.round(sleeve.shock)}%, sync ${Math.round(sleeve.sync)}%)`);
	}
	const onKarma = roles.filter((role) => role === "karma").length;
	if (onKarma && karma.rate > 0) lines.splice(1, 0, `karma: ${Math.round(state.karmaLeft)} to go, about ${Math.round(karma.rate)} an hour per sleeve (${Math.round(state.karmaLeft / (karma.rate * onKarma) * 10) / 10} hours at ${onKarma} sleeves)`);
	post(ns, lines, roles, { time: Date.now(), value: player.karma, sleeves: onKarma, rate: karma.rate });
}

/**
 * Contracts' remaining counts as bb-pass.js last read them ({ name: count }), or null when that reading is missing or older than
 * 15 minutes (the planner then tries every sleeve and the game's refusal decides).
 */
function contractCounts(ns) {
	const actions = readBladeburner(ns).actions;
	if (!actions?.rows || Date.now() - (actions.t ?? 0) > 15 * 60_000) return null;
	const counts = {};
	for (const row of actions.rows) if (row.type === "Contracts") counts[row.name] = Number(row.count);
	return counts;
}

/** Posts the summary `status` shows (port 40) and the pass log `debug-report` reads. */
function post(ns, lines, roles, karma) {
	ns.clearPort(SUMMARY_PORT);
	ns.writePort(SUMMARY_PORT, JSON.stringify({ time: Date.now(), title: "Sleeves", script: SCRIPT, oneShot: true, lines, roles, karma }));
	postPass(ns, SCRIPT, lines);
	for (const line of lines) ns.print(`[sleeves] ${line}`);
}

/**
 * Karma lowered per sleeve-hour while sleeves were grinding it, measured between this pass and the last (the summary on port 40 keeps
 * the last reading), smoothed with the one before. Counts the player's own crimes too when it commits any, so it can read high.
 * { rate } is 0 when there is no usable reading yet.
 */
function karmaRate(ns, karma) {
	const prev = peekJson(ns, SUMMARY_PORT)?.karma;
	if (!prev || !(prev.sleeves > 0)) return { rate: prev?.rate ?? 0 };
	const hours = (Date.now() - prev.time) / 3.6e6;
	const gained = prev.value - karma;
	if (!(hours > 0) || hours > 0.5 || !(gained > 0)) return { rate: prev.rate ?? 0 };
	const instant = gained / hours / prev.sleeves;
	return { rate: prev.rate > 0 ? (prev.rate + instant) / 2 : instant };
}

/** JSON on a port, or null. */
function peekJson(ns, port) {
	try {
		const value = JSON.parse(ns.peek(port));
		return value && typeof value === "object" ? value : null;
	} catch {
		return null;
	}
}

/** A port's JSON when it is newer than maxAgeMs (its `time`), else null. */
function fresh(ns, port, maxAgeMs) {
	const value = peekJson(ns, port);
	return value && Date.now() - (value.time ?? 0) < maxAgeMs ? value : null;
}

/**
 * The game's crime stats (port 43, posted once per BitNode run by crime-stats.js). That needs the Singularity API, so it is only
 * asked for where its RAM multiplier is 4 or less; otherwise the planner falls back to `sleeves.crimeLadder`.
 */
async function crimeStats(ns, info) {
	const posted = peekJson(ns, CRIME_STATS_PORT);
	if (posted?.crimes && posted.time >= info.lastNodeReset) return posted.crimes;
	const singularity = singularityFromInfo(info);
	if (!singularity.available || singularity.ramMultiplier > 4) return null;
	const pid = startHelper(ns, CONFIG.statsHelper, CONFIG.statsImports);
	if (pid === 0) return null;
	while (ns.isRunning(pid)) await ns.sleep(100);
	return peekJson(ns, CRIME_STATS_PORT)?.crimes ?? null;
}

/** Runs a worker with its items and returns what it reported ({ sleeve, ok, used }[], from port 41), or null when no server had room. */
async function runWorker(ns, name, items) {
	ns.clearPort(RESULT_PORT);
	const pid = startHelper(ns, CONFIG[`${name}Helper`], CONFIG[`${name}Imports`], JSON.stringify(items));
	if (pid === 0) return null;
	while (ns.isRunning(pid)) await ns.sleep(100);
	const results = JSON.parse(ns.peek(RESULT_PORT));
	return Array.isArray(results) ? results : [];
}
