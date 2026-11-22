// Design: docs/corporation.md
// @ts-check
import { loadConfig } from "/utils/config.js";
import { startHelperRam } from "/utils/start-helper.js";
import { adviseMissing } from "/utils/api-advice.js";
import { corpAccess } from "/utils/corporation.js";
import { singularityFromInfo } from "/utils/singularity.js";
import { bitnodeMults } from "/utils/bitnode-mults.js";
import { getAllServers } from "/utils/get-all-servers.js";
import { notify } from "/utils/notify.js";
import { forbids } from "/utils/forbid.js";
import { postPass } from "/utils/pass-log.js";
import {
	planCorp, newMemory, readCorpCalls, readDivisionCalls, readDataCalls, assembleSnapshot, packBatches, SUMMARY_PORT, RESULT_PORT,
} from "/corp/plan.js";
import { BOOSTS } from "/corp/formulas.js";

// The one worker: runs a batch of calls by name with exactly the RAM they need (see corp/workers/call.js).
export const CONFIG = {
	callHelper: "corp/workers/call.js", callImports: [],
	waitMs: 10_000,       // between tries while there is no corporation yet or no room for a worker
	stateTries: 10,       // corporation states to wait through for the next START before acting anyway
};
const GOALS_PORT = 23; // faction rep goals (singularity/workers/faction-goals.js), for bribes
const GOALS_MAX_AGE_MS = 3600_000;
const SCRIPT = "corp/corp-manager.js";
const TAG = "[corp]";

/**
 * Runs the corporation (BitNode 3, or anywhere with Source-File 3): creates it (free on seed money in BitNode 3, $150b of the
 * player's cash elsewhere once that is affordable), then after every START state reads it, plans (corp/plan.js) and acts:
 * divisions and cities, offices and jobs, warehouses and boost materials, products and their prices, research, the four
 * investment rounds, going public, dividends and bribes. Every corporation call goes through corp/workers/call.js, started
 * with exactly the RAM its batch needs, so this script stays small. Settings: `corp` in the config (`corp.enabled: false`
 * stops it). Summary for `status` on port 48. Design: docs/corporation.md.
 *   run /corp/corp-manager.js
 */
/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	let config = loadConfig(ns);
	if (config.corp?.enabled === false) return;
	const info = ns.getResetInfo();
	const access = corpAccess(ns, config);
	if (access.forbidden) {
		post(ns, [`no corporation: ${access.why}`], null);
		return;
	}
	if (!access.available) {
		adviseMissing(ns, "corporation", info, config);
		return;
	}
	if (!access.hasCorp && !access.canCreate) {
		post(ns, [`no corporation, and none can be made: ${access.why}`], null);
		return;
	}
	const memory = restoreMemory(ns) ?? newMemory();
	/** @type {{ industries: Record<string, any>, materialSizes: Record<string, number> } | null} */
	let data = null;
	let divisionNames = /** @type {string[]} */ ([]);
	/** @type {Record<string, string[]> | null} */
	let known = null;
	while (true) {
		config = loadConfig(ns);
		if (config.corp?.enabled === false) return;
		if (!ns.corporation.hasCorporation()) {
			if (forbids(config, "corporation")) return; // a challenge set since the start
			const made = await createCorp(ns, config, access);
			if (!made) return; // startup.js starts this again once corp/ready.js says a corporation can be made
			continue;
		}
		await waitForStart(ns);
		const result = await pass(ns, config, memory, data, divisionNames, info, known);
		data = result.data ?? data;
		divisionNames = result.divisionNames ?? divisionNames;
		known = result.known ?? known;
		if (result.waitMs) await ns.sleep(result.waitMs);
	}
}

/** Creates the corporation: on seed money in BitNode 3, else self-funded once the cash is `selfFundCash` x the price. */
async function createCorp(ns, config, access) {
	const settings = config.corp;
	if (!access.seedMoney) {
		const cash = ns.getServerMoneyAvailable("home");
		if (!settings.selfFund || cash < access.cost * settings.selfFundCash) {
			post(ns, [`no corporation yet: ${settings.selfFund ? `waiting for $${ns.format.number(access.cost * settings.selfFundCash)} cash to self-fund one ($${ns.format.number(access.cost)})` : "corp.selfFund is off"}`], null);
			return false;
		}
	}
	const outcome = await runCalls(ns, [["corporation.createCorporation", settings.name, !access.seedMoney]]);
	const made = outcome.results[0]?.ok && outcome.results[0].value !== false;
	if (made) notify(ns, TAG, `created ${settings.name}${access.seedMoney ? " on seed money" : ` for $${ns.format.number(access.cost)}`}`, "success");
	else post(ns, [`couldn't create the corporation${outcome.waiting ? `: no server has ${ns.format.ram(outcome.waiting)} free yet` : `: ${outcome.results[0]?.error ?? "refused"}`}`], null);
	if (!made) await ns.sleep(CONFIG.waitMs);
	return made;
}

/** Waits until the corporation has just processed a START state (fresh financials, offer and offices), at 0GB. */
async function waitForStart(ns) {
	for (let tries = 0; tries < CONFIG.stateTries; tries++) {
		if (await ns.corporation.nextUpdate() === "START") return;
	}
}

/**
 * One pass: read, plan, act, post. Returns what later passes reuse (industry data, division names, the cities with a
 * warehouse) and how long to wait when a worker found no room.
 */
export async function pass(ns, config, memory, data, divisionNames, info, known = null) {
	const settings = config.corp;
	// 1. The corporation, its offer, unlocks, upgrades and the divisions it had last pass (plus the game data, once).
	const industryNames = [...new Set(Object.values(settings.industries).filter(Boolean))];
	const first = [...readCorpCalls(divisionNames), ...(data ? [] : readDataCalls(industryNames, Object.keys(BOOSTS)))];
	const one = await runCalls(ns, first);
	if (one.waiting) return waitForRoom(ns, memory, one.waiting);
	let snap = assembleSnapshot(first, one.results);
	if (!snap.corp) {
		post(ns, ["couldn't read the corporation"], memory);
		return { waitMs: CONFIG.waitMs };
	}
	data = data ?? { industries: snap.industries, materialSizes: snap.materialSizes };
	// 2. Divisions made since (by this pass's plan or by hand), and the industry data they need.
	const names = snap.corp.divisions;
	const missing = names.filter((name) => !divisionNames.includes(name));
	const extra = missing.map((name) => ["corporation.getDivision", name]);
	if (extra.length) {
		const two = await runCalls(ns, extra);
		if (two.waiting) return waitForRoom(ns, memory, two.waiting);
		extra.forEach((call, index) => { if (two.results[index]?.ok) one.results.push(two.results[index]); });
		first.push(...extra.filter((call, index) => two.results[index]?.ok));
		snap = assembleSnapshot(first, one.results);
	}
	const divisions = Object.fromEntries(names.filter((name) => snap.divisions[name]?.industry).map((name) => [name, snap.divisions[name]]));
	const unknown = [...new Set(Object.values(divisions).map((division) => division.industry))].filter((industry) => !data.industries[industry]);
	// 3. Offices, warehouses, materials, products and research (and faction rep, when bribes are possible).
	const third = [
		...readDataCalls(unknown, []),
		...readDivisionCalls(divisions, data.industries, { office: !!snap.unlocks["Office API"], warehouse: !!snap.unlocks["Warehouse API"] }, known),
		...repCalls(ns, settings, snap, info),
	];
	const three = await runCalls(ns, third);
	if (three.waiting) return waitForRoom(ns, memory, three.waiting);
	const details = assembleSnapshot(third, three.results);
	for (const industry of unknown) if (details.industries[industry]) data.industries[industry] = details.industries[industry];
	for (const [name, division] of Object.entries(divisions)) Object.assign(division, pick(details.divisions[name]));
	const goals = readGoals(ns);
	const full = {
		...snap, divisions, industries: data.industries, materialSizes: data.materialSizes,
		constants: ns.corporation.getConstants(),
		maxDivisions: Math.floor(20 * bitnodeMults(ns).get("CorporationDivisions")),
		factionRep: details.factionRep ?? null, goals, factions: ns.getPlayer().factions,
	};

	// Plan and act.
	const plan = planCorp(full, memory, config);
	const acted = plan.calls.length ? await runCalls(ns, plan.calls) : { results: [], waiting: 0 };
	const failed = plan.calls.map((call, index) => ({ call, result: acted.results[index] })).filter((item) => item.result && !item.result.ok);
	const lines = [...plan.lines];
	if (acted.waiting) lines.push(`no server has ${ns.format.ram(acted.waiting)} free for the next batch of calls; trying again`);
	for (const { call, result } of failed.slice(0, 3)) lines.push(`${call[0].replace("corporation.", "")}(${call.slice(1).join(", ")}) failed: ${result.error}`);
	if (plan.accepted && acted.results.some((result, index) => result?.ok && plan.calls[index][0] === "corporation.acceptInvestmentOffer")) {
		notify(ns, TAG, `accepted the round ${full.offer.round} investment: $${ns.format.number(full.offer.funds)}`, "success");
	}
	if (plan.calls.some((call, index) => call[0] === "corporation.goPublic" && acted.results[index]?.ok)) notify(ns, TAG, "went public", "success");
	post(ns, lines, memory);
	const warehouses = Object.fromEntries(Object.entries(divisions).map(([name, division]) => [name, Object.keys(division.warehouses)]));
	return { data, divisionNames: names, known: warehouses, waitMs: acted.waiting ? CONFIG.waitMs : 0 };
}

/** The parts of a division the detail read fills in (offices, warehouses, materials, products, research); empty where it failed. */
function pick(details) {
	return {
		offices: details?.offices ?? {}, warehouses: details?.warehouses ?? {}, materials: details?.materials ?? {},
		productData: details?.productData ?? {}, researched: details?.researched ?? {},
	};
}

/**
 * Faction reputation reads for bribes: only once the valuation allows them, the goals are fresh, and the Singularity API's RAM
 * multiplier is 1x or 4x (getFactionRep is the only way to read it).
 */
function repCalls(ns, settings, snap, info) {
	if (!settings.bribes?.enabled) return [];
	if (!(snap.corp.valuation >= (ns.corporation.getConstants().bribeThreshold ?? 100e12))) return [];
	const singularity = singularityFromInfo(info);
	if (!singularity.available || singularity.ramMultiplier > 4) return [];
	const goals = readGoals(ns);
	if (!goals) return [];
	return Object.keys(goals).map((faction) => ["singularity.getFactionRep", faction]);
}

function readGoals(ns) {
	try {
		const posted = JSON.parse(ns.peek(GOALS_PORT));
		if (posted && Date.now() - (posted.time ?? 0) < GOALS_MAX_AGE_MS && posted.goals) return posted.goals;
	} catch { /* nothing posted */ }
	return null;
}

/**
 * Runs `calls` in order, in as few workers as the largest free RAM block allows. { results, waiting }: one result per call
 * that ran, and the GB a batch is waiting for when no server had room (the rest didn't run; startHelperRam reserved room).
 */
async function runCalls(ns, calls) {
	const base = ns.getScriptRam(CONFIG.callHelper, "home");
	const costOf = (name) => ns.getFunctionRamCost(name);
	const batches = packBatches(calls, costOf, Math.max(largestFree(ns), base), base);
	const results = [];
	for (const batch of batches) {
		ns.clearPort(RESULT_PORT);
		const pid = startHelperRam(ns, CONFIG.callHelper, CONFIG.callImports, batch.ram, JSON.stringify(batch.calls));
		if (pid === 0) return { results, waiting: batch.ram };
		while (ns.isRunning(pid)) await ns.sleep(20);
		let posted = [];
		try {
			posted = JSON.parse(ns.peek(RESULT_PORT));
		} catch { /* the worker died */ }
		for (let index = 0; index < batch.calls.length; index++) results.push(posted[index] ?? { ok: false, error: "no result (the worker stopped)" });
	}
	return { results, waiting: 0 };
}

/** The most free RAM on any one server this script can start a worker on. */
function largestFree(ns) {
	let best = 0;
	for (const host of getAllServers(ns)) {
		if (host !== "home" && !ns.hasRootAccess(host)) continue;
		best = Math.max(best, ns.getServerMaxRam(host) - ns.getServerUsedRam(host));
	}
	return best;
}

function waitForRoom(ns, memory, ram) {
	post(ns, [`waiting for a server with ${ns.format.ram(ram)} free to read the corporation`], memory);
	return { waitMs: CONFIG.waitMs };
}

/** Posts the summary `status` shows (port 48), with the planner's memory so a restart keeps prices and offer history. */
function post(ns, lines, memory) {
	ns.clearPort(SUMMARY_PORT);
	ns.writePort(SUMMARY_PORT, JSON.stringify({ time: Date.now(), title: "Corporation", script: SCRIPT, lines, memory }));
	postPass(ns, SCRIPT, lines);
	for (const line of lines) ns.print(`${TAG} ${line}`);
}

function restoreMemory(ns) {
	try {
		const posted = JSON.parse(ns.peek(SUMMARY_PORT));
		if (posted?.memory && typeof posted.memory === "object") return { ...newMemory(), ...posted.memory };
	} catch { /* nothing posted */ }
	return null;
}
