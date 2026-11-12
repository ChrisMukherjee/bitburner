// Design: docs/bladeburner.md
// @ts-check
import { readIncomeRate } from "/utils/income.js";
import { hasSingularity } from "/utils/singularity.js";
import { bladeburnerAccess, bladeburnerNodeMults } from "/utils/bladeburner.js";
import { postPass } from "/utils/pass-log.js";
import { readBladeburner, postBladeburner } from "/bladeburner/state.js";
import * as RM from "/bladeburner/route-model.js";
import { augPriceStep } from "/utils/aug-price.js";
import { staminaRegen, MIN_RATE_SPAN_MS } from "/bladeburner/ideal.js";
import { loadConfig } from "/utils/config.js";
import { daemonLevelFor } from "/utils/route-progress.js";

// Every faction that sells augmentations (names from the game), to build the pool of augs the simulation can buy
const ALL_FACTIONS = ["CyberSec", "NiteSec", "The Black Hand", "BitRunners", "Daedalus", "The Covenant", "Illuminati", "ECorp", "MegaCorp",
	"Bachman & Associates", "Blade Industries", "NWO", "Clarke Incorporated", "OmniTek Incorporated", "Four Sigma", "KuaiGong International",
	"Fulcrum Secret Technologies", "Tian Di Hui", "Netburners", "Sector-12", "Aevum", "Chongqing", "New Tokyo", "Ishima", "Volhaven",
	"Slum Snakes", "Tetrads", "Silhouette", "Speakers for the Dead", "The Dark Army", "The Syndicate"];
// Faction reputation multiplier of the BitNode (game source)
const BN_FACTION_REP = { 2: 0.5, 4: 0.75, 13: 0.6, 14: 0.2 };
const COMBAT_STATS = ["strength", "defense", "dexterity", "agility"];
const RED_PILL = "The Red Pill";
const DAEDALUS = "Daedalus";
const WORLD = "w0r1d_d43m0n";
const RUN_HOURS = 4;             // modelled length of a run
const GYM_CHOICES = [1, 2, 3];   // gym hours per run the combat model tries
const HISTORY_FILE = "data/node-eta-history.json";   // income vs multiplier across runs; survives resets, so it is a file
const ROUTE_FILE = "data/node-eta-route.json";       // the committed route, so an install does not forget it
const REPORT_FILE = "data/node-eta.txt";
const YOUNG_RUN_MS = 30 * 60_000;   // within this a run's own income and exp rate are still ramping up
const PRIOR_MARGIN = 0.75;       // a first guess commits hacking only when hacking takes under 75 % of Bladeburner's modelled time
const HOLD_BELOW = 0.3;          // hold Bladeburner under this best chance, resume only above RESUME_ABOVE
const RESUME_ABOVE = 0.4;

/** Hacking exp needed for a level at a multiplier (inverse of the game's skill formula). */
const expFor = (level, mult) => Math.max(0, Math.exp((level / mult + 200) / 32) - 534.5);
const fmt = (s) => !Number.isFinite(s) ? "unknown" : s < 90 ? `${Math.ceil(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;

/**
 * Route estimate, ONE short pass (startup.js runs it every few minutes, on any server with room): how long would each way out of this
 * BitNode take, hacking (Daedalus, The Red Pill, then the daemon's hacking level) or Bladeburner (combat augs, gym, rank 400000 and
 * every Black Op)? Walks both routes reset by reset with the models in route-model.js, from live game state only (no per-BitNode tables).
 *
 * Writes the verdict on port 36 as `plan` ({ route, hold, daemonLevel, time }), which bb-manage.js follows:
 *   route  "hacking" or "combat"; kept between passes and changed only for a 25 % better route. Left out until bb-pass.js has posted
 *          live action readings, so Bladeburner can measure itself before the first verdict (the config route applies meanwhile)
 *   daemonLevel  the hacking level w0r1d_d43m0n needs (the live server once it exists, else the BitNode's table), for tools/status.js
 *   hold   true when the best action's chance, rescaled to the current skills, is too low to earn rank (hysteresis 30 % / 40 %)
 * and the readable report in data/node-eta.txt (`cat data/node-eta.txt`).
 * Reads from port 36: the live action readings and rank samples of bb-pass.js. Keeps its exp samples there too (`eta`).
 * Ported from the other player's node-eta.js, which has run in game. The combat-aug shopping plan was left out: the faction-goals
 * and buy-augs helpers already decide what to buy.
 */
/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	if (!hasSingularity(ns) || !bladeburnerAccess(ns).available) {
		ns.print("The route estimate needs the Singularity and Bladeburner APIs.");
		return;
	}
	const home = ns.getHostname() === "home";
	for (const file of [HISTORY_FILE, ROUTE_FILE]) if (!home && ns.fileExists(file, "home")) ns.scp(file, ns.getHostname(), "home");
	const started = Date.now();
	try {
		const lines = estimate(ns);
		postPass(ns, ns.getScriptName(), lines.filter((line) => /^(Hacking, |Bladeburner, |RECOMMENDED|Bladeburner "run"|Confidence)/.test(line)));
		lines.push(`(computed in ${Date.now() - started} ms)`);
		ns.write(REPORT_FILE, lines.join("\n") + "\n", "w");
	} catch (error) {
		ns.write(REPORT_FILE, `${new Date().toLocaleTimeString()}  route estimate failed: ${String(error && error.stack ? error.stack : error).slice(0, 600)}\n`, "w");
		ns.tprint(`[bladeburner] route estimate failed: ${String(error).slice(0, 120)}`);
	}
	if (!home) ns.scp([REPORT_FILE, HISTORY_FILE, ROUTE_FILE].filter((file) => ns.fileExists(file)), "home");
}

/** The whole estimate; returns the report lines and posts the plan. */
function estimate(ns) {
	const sing = ns.singularity;
	const info = ns.getResetInfo();
	const node = info.currentNode;
	const augStep = augPriceStep(info.ownedSF); // price step per augmentation bought: 1.9, less with Source-File 11
	const player = ns.getPlayer();
	const level = player.skills.hacking;
	const mult = player.mults.hacking || 1;
	const exp = player.exp.hacking;
	// The models need the multipliers the levels really grow with: the player's mults leave out the BitNode's level multiplier
	// (hacking x0.35 in BitNode 6), so read it back from the live levels (route-model.js modelMults), or take it from the BitNode's
	// multipliers while the levels are too low to read (combat at the start of a run). The history keeps the raw mult.
	const nodeMults = bladeburnerNodeMults(ns);
	const effective = RM.modelMults(player, { hacking: nodeMults.hackingLevel ?? undefined, combat: nodeMults.combatLevel ?? undefined });
	const hackMult = effective.hacking;
	const now = Date.now();
	const shared = readBladeburner(ns);
	const lines = [`${new Date().toLocaleTimeString()}  BitNode ${node}`];

	// Daemon requirement: the server once it exists, otherwise 3000 x the BitNode's difficulty
	let required = daemonLevelFor(node) ?? 3000;
	try { required = ns.getServer(WORLD).requiredHackingSkill; } catch { /* hidden until The Red Pill is installed */ }

	// Measured hacking exp rate: samples of this run, kept on port 36 (trimmed to 30 minutes)
	const stamp = String(info.lastAugReset);
	const old = shared.eta && shared.eta.stamp === stamp ? shared.eta : { stamp, samples: [] };
	const samples = old.samples.filter((sample) => now - sample.t < 30 * 60_000 && sample.exp <= exp);
	samples.push({ t: now, exp });
	let rate = now - samples[0].t >= 2 * 60_000 ? (exp - samples[0].exp) / ((now - samples[0].t) / 1000) : NaN; // exp per second
	let income = readIncomeRate(ns).perSecond;
	const money = ns.getServerMoneyAvailable("home");

	// The Red Pill and Daedalus
	const installed = sing.getOwnedAugmentations(false).includes(RED_PILL);
	const joined = player.factions.includes(DAEDALUS);
	const rpRep = sing.getAugmentationRepReq(RED_PILL);
	const rpPrice = sing.getAugmentationPrice(RED_PILL);
	const haveRep = joined ? sing.getFactionRep(DAEDALUS) : 0;
	const bnLevel = hackMult / mult;
	lines.push(`Hacking ${level}/${required}; multiplier ${mult.toFixed(2)}${Math.abs(bnLevel - 1) > 0.02 ? ` (x${bnLevel.toFixed(2)} BitNode level multiplier on top: ${hackMult.toFixed(2)} effective)` : ""}; exp rate ${Number.isFinite(rate) ? rate.toFixed(1) + "/s" : "still measuring"}`);
	lines.push(`Red Pill: ${installed ? "installed" : joined ? `rep ${Math.round(haveRep)}/${Math.round(rpRep)}, price $${ns.format.number(rpPrice)}` : "Daedalus has not invited you"}`);

	// The pool of augs the simulation can buy: every hacking or combat aug of every faction (prices scaled back to "none queued")
	const installedNow = new Set(sing.getOwnedAugmentations(false));
	const queued = Math.max(0, sing.getOwnedAugmentations(true).length - installedNow.size);
	const pool = new Map();
	// Invite gates of the factions not joined yet: their augs count in a modelled run only once its levels open the faction
	// (Illuminati's hacking 1500 and combat 1200, say). Without them the hacking route bought augs it could never reach.
	/** @type {Record<string, any>} */
	const gates = {};
	// Favor and this run's rep per faction: an install restarts rep at 0 and keeps the favor it turns into (route-model.js)
	/** @type {Record<string, number>} */
	const favor = {};
	/** @type {Record<string, number>} */
	const repNow = {};
	for (const faction of new Set([...player.factions, ...ALL_FACTIONS])) {
		let list = [];
		try { list = sing.getAugmentationsFromFaction(faction); } catch { continue; }
		try { favor[faction] = sing.getFactionFavor(faction); } catch { /* unknown faction: no favor */ }
		if (player.factions.includes(faction)) repNow[faction] = sing.getFactionRep(faction);
		if (!player.factions.includes(faction)) {
			try { gates[faction] = RM.inviteGate(sing.getFactionInviteRequirements(faction)); } catch { /* no gate: assumed open */ }
		}
		for (const name of list) {
			if (installedNow.has(name) || name === "NeuroFlux Governor" || name === RED_PILL) continue;
			const stats = sing.getAugmentationStats(name);
			const hackMult = stats.hacking ?? 1;
			const hackExp = stats.hacking_exp ?? 1;
			const combat = COMBAT_STATS.map((key) => stats[key] ?? 1);
			if (hackMult <= 1 && hackExp <= 1 && combat.every((value) => value <= 1)) continue;
			const rep = sing.getAugmentationRepReq(name);
			const seen = pool.get(name);
			if (seen) { seen.rep = Math.min(seen.rep, rep); seen.f.push(faction); continue; }
			pool.set(name, { name, price: sing.getAugmentationPrice(name) / augStep ** queued, rep, f: [faction], h: hackMult, e: hackExp, cs: combat });
		}
	}
	const augList = [...pool.values()];
	let neuroFlux = null;
	try {
		const stats = sing.getAugmentationStats("NeuroFlux Governor");
		neuroFlux = {
			price: sing.getAugmentationPrice("NeuroFlux Governor") / augStep ** queued, rep: sing.getAugmentationRepReq("NeuroFlux Governor"),
			h: stats.hacking ?? 1, e: stats.hacking_exp ?? 1, cs: COMBAT_STATS.map((key) => stats[key] ?? 1),
		};
	} catch { /* not offered */ }

	// Income growth with the multiplier: measured over earlier runs when there are enough, otherwise three scenarios
	let history = [];
	try { history = JSON.parse(ns.read(HISTORY_FILE)); } catch { /* none yet */ }
	if (!Array.isArray(history)) history = [];
	if (income > 0 && level >= 10) {
		const current = history.find((entry) => entry.stamp === stamp);
		const rateNow = Number.isFinite(rate) && rate > 0 ? rate : undefined;   // the exp rate too, so the next run can start from it (seedFromHistory)
		if (current) {
			if (income > current.income) { current.income = income; current.t = now; }
			if (rateNow && !(rateNow <= current.expRate)) current.expRate = rateNow;
			current.mult = mult;
		} else history.push({ stamp, t: now, mult, income, expRate: rateNow });
		history = history.slice(-30);
		ns.write(HISTORY_FILE, JSON.stringify(history), "w");
	}
	// Only a fit that explains the data counts (route-model.js fitIncomeExponent); otherwise the scenarios are shown and the verdict
	// uses the flat-income one, the conservative case for both routes. Income that jumps for another reason (RAM, servers) would
	// otherwise be credited to the multiplier and make hacking look far better than it is.
	const fit = RM.fitIncomeExponent(history);
	const incomeExponent = fit.reliable ? fit.exponent : NaN;
	const scenarios = Number.isFinite(incomeExponent)
		? [{ name: "low", income: incomeExponent * 0.7, exp: incomeExponent * 0.35 }, { name: "measured", income: incomeExponent, exp: incomeExponent * 0.5 }, { name: "high", income: incomeExponent * 1.3, exp: incomeExponent * 0.65 },
			{ name: "flat (income and exp do not grow)", income: 0, exp: 0 }]
		: [{ name: "low (income flat)", income: 0, exp: 0 }, { name: "middle (income ~ multiplier)", income: 1, exp: 0.5 }, { name: "high (income ~ multiplier^2)", income: 2, exp: 1 }];
	// The scenario the verdict is based on: the measured one, or the flat one while the growth is not measured
	const verdictIndex = Number.isFinite(incomeExponent) ? 1 : 0;
	lines.push(Number.isFinite(incomeExponent)
		? `Confidence: medium, income growth measured over ${fit.runs} runs (income ~ multiplier^${incomeExponent.toFixed(2)}, R2 ${fit.r2.toFixed(2)}); the verdict uses the "measured" scenario`
		: fit.runs >= 3 && Number.isFinite(fit.raw)
			? `Confidence: low, the income fit over ${fit.runs} runs is not usable (slope ${fit.raw.toFixed(1)}, R2 ${fit.r2.toFixed(2)}: income moved for other reasons than the multiplier), so the verdict uses the flat-income scenario`
			: "Confidence: low, income growth with the multiplier is not measured yet (needs 3 runs with different multipliers), so the verdict uses the flat-income scenario");
	const fmtHours = (result) => !result ? "unknown" : result.reached && result.hours <= 400 ? `${result.hours.toFixed(0)} h (${result.runs} runs)`
		: result.reached ? `over 400 h (${result.hours.toFixed(0)} h modelled: too uncertain to call an estimate)` : "not reached within 60 runs";
	// persistence.routeRepResets (config.js): false = the old model, rep kept across installs
	const config = loadConfig(ns);
	const repResets = config.persistence?.routeRepResets !== false;
	// A young run has measured nothing yet (a reset empties income and the exp rate), so the hacking route could not be simulated
	// and Bladeburner was the only route left to "measure", at the cost of the gym. Start from the last run's peak instead.
	const seed = config.bladeburner?.priorHistory !== false ? RM.seedFromHistory(history, stamp, mult, incomeExponent) : null;
	if (seed) {
		const young = (now - info.lastAugReset) < YOUNG_RUN_MS;
		const noIncome = !(income > 0), noRate = !(rate > 0);
		if (noIncome || (young && seed.income > income)) {
			lines.push(`Income $${ns.format.number(income > 0 ? income : 0)}/s this run is still ${noIncome ? "unmeasured" : "ramping up"}: using the last run's peak $${ns.format.number(seed.income)}/s for the estimate`);
			income = seed.income;
		}
		if (Number.isFinite(seed.expRate) && (noRate || (young && seed.expRate > rate))) {
			lines.push(`Hacking exp rate ${noRate ? "unmeasured" : "ramping up"}: using the last run's ${seed.expRate.toFixed(1)}/s for the estimate`);
			rate = seed.expRate;
		}
	}
	const repConfig = { facMult: player.mults.faction_rep || 1, bn: BN_FACTION_REP[node] ?? 1, timeShare: 0.7, favor, now: repNow,
		donateFavor: ns.getFavorToDonate(), resetOnInstall: repResets };
	const combatNow = effective.combat;
	const combatLevel = Math.min(...COMBAT_STATS.map((key) => player.skills[key] || 1));
	const blackOpsDone = !!shared.blackOps?.done;

	// Hacking route: Daedalus (installed augs, money in hand, level), The Red Pill, then the final level in one run
	let hackSim = null;
	let hackRoute = null;
	if (!installed || level < required) {
		hackRoute = { required, daedalusAugs: 30, daedalusMoney: 1e11, daedalusHack: 2500, rpRep, rpPrice, rpHeld: haveRep >= rpRep, startStage: installed ? 2 : joined ? 1 : 0 };
		try {
			for (const requirement of sing.getFactionInviteRequirements(DAEDALUS)) {
				if (requirement.type === "numAugmentations") hackRoute.daedalusAugs = requirement.numAugmentations;
				if (requirement.type === "money") hackRoute.daedalusMoney = requirement.money;
			}
		} catch { /* keep the defaults */ }
		if (Number.isFinite(rate) && rate > 0 && income > 0) {
			hackSim = scenarios.map((scenario) => ({
				scenario, result: RM.projectRoute("hacking", {
					augs: augList, nf: neuroFlux, mult: { hacking: hackMult, hackExp: player.mults.hacking_exp || 1, combat: combatNow, combatExp: 1 }, income, expRate: rate,
					installed: installedNow.size, runHours: RUN_HOURS, augStep, rep: repConfig, gates, combatLevel, scenario, maxRuns: 60, hackRoute,
				}),
			}));
		}
	}

	// Bladeburner route, from the live readings bb-pass.js posts
	const actData = shared.actions;
	const skillsNow = { ...player.skills };
	const rankSamples = Array.isArray(shared.rank) ? shared.rank : [];
	let acts = null;
	let live = false;   // acts come from bb-pass.js' readings (false: the first guess, or none)
	let bladeSim = null;
	let chanceNow = null;
	let duty = 0.5;
	let predicted = NaN;
	let measured = NaN;
	let calibrated = false;
	let rankNow = 0;
	// Skill points bought as rank comes in (Overclock, Blade's Intuition), from the levels and cost bb-manage.js posted
	const skills = RM.skillStart(shared.skillModel?.levels, shared.skillModel?.costs);
	// Stamina: maximum from bb-pass.js' readings, regeneration from the game's formula (ideal.js, as bb-pass.js' efficiency line)
	const levelsNow = shared.skillLevels ?? {};
	const maxStamina = Array.isArray(shared.actions?.stamina) ? Number(shared.actions.stamina[1]) : NaN;
	const agility = (player.skills.agility || 1) * (1 + 0.02 * (levelsNow["Reaper"] ?? 0)) * (1 + 0.04 * (levelsNow["Evasive System"] ?? 0));
	const stamina = maxStamina > 0 ? { max: maxStamina, regen: staminaRegen(maxStamina, agility, (1 + 0.02 * (levelsNow["Cyber's Edge"] ?? 0)) * (player.mults.bladeburner_stamina_gain || 1)) } : undefined;
	if (!blackOpsDone) {
		if (rankSamples.length > 0) {
			const first = rankSamples[0];
			const last = rankSamples[rankSamples.length - 1];
			rankNow = last.rank;
			// Samples bb-pass.js stopped adding over 10 minutes ago (held, training) don't measure the play now
			const current = now - last.t < 10 * 60_000;
			if (current && last.t - first.t >= MIN_RATE_SPAN_MS) measured = (last.rank - first.rank) / ((last.t - first.t) / 3600_000);
			calibrated = current && last.t - first.t > 30 * 60_000;
		}
		if (actData && Array.isArray(actData.rows) && actData.rows.length) {
			live = true;
			acts = RM.makeBladeburner(actData.rows.map((row) => ({ ...row, lv: actData.lv })));
			chanceNow = RM.bestChanceNow(acts, skillsNow);
			const bestThen = RM.bestChanceNow(acts, actData.lv).chance;
			predicted = RM.predictRankPerHour(acts, actData.lv, 1, Math.min(0.4, bestThen * 0.9), stamina);
			// Only a calibrated window (30 min of play) sets the duty: the first minutes (first actions at level 1, resting) read
			// several times too low, and a low duty made the route look slow enough to be held before it was ever measured properly
			if (calibrated && predicted > 0 && Number.isFinite(measured)) duty = Math.min(1, Math.max(0.05, measured / predicted));
		} else if (config.bladeburner?.priorRoute !== false && nodeMults.rank > 0) {
			// No readings yet: a first guess from the game's action formulas and this BitNode's multipliers (rank gain, skill cost,
			// combat levels), so a BitNode that nerfs Bladeburner hard can go to hacking before any gym time is spent on measuring it
			acts = RM.makeBladeburner(RM.priorRows(player.skills, nodeMults.rank, player.mults.bladeburner_success_chance || 1));
			if (!shared.skillModel?.costs) skills.costMult = nodeMults.skillCost;
		}
		if (acts && income > 0) {
			bladeSim = scenarios.map((scenario) => {
				let best = null;
				for (const gym of GYM_CHOICES) {
					const result = RM.projectRoute("combat", {
						augs: augList, nf: neuroFlux, mult: { hacking: hackMult, hackExp: 1, combat: combatNow, combatExp: player.mults.strength_exp || 1 }, income, expRate: rate || 1,
						installed: installedNow.size, runHours: RUN_HOURS, augStep, rep: repConfig, gates, combatLevel, scenario, maxRuns: 60, bb: { acts, rank: rankNow, lv: skillsNow, duty, gymHours: gym, skills, stamina },
					});
					result.gym = gym;
					if (!best || (result.reached && !best.reached) || (result.reached === best.reached && result.hours < best.hours)) best = result;
				}
				return { scenario, result: best };
			});
		}
	}

	// "Income that would make a route take about 100 h" (flat-income model): the robust comparison when no scenario finishes
	// Only worked out when the verdict scenario finishes within 400 h on neither route (it reruns the routes up to 13 times each, so
	// it costs a second or two); the verdict uses it only then
	const someFinish = [hackSim, bladeSim].some((sim) => sim?.[verdictIndex] && sim[verdictIndex].result.reached && sim[verdictIndex].result.hours <= 400);
	let needHack = NaN;
	let needBlade = NaN;
	if (hackSim && !someFinish) {
		needHack = RM.incomeNeeded("hacking", { augs: augList, nf: neuroFlux, mult: { hacking: hackMult, hackExp: player.mults.hacking_exp || 1, combat: combatNow, combatExp: 1 }, income, expRate: rate, installed: installedNow.size, runHours: RUN_HOURS, augStep, rep: repConfig, gates, combatLevel, maxRuns: 60, hackRoute });
	}
	if (bladeSim && !someFinish) {
		needBlade = Math.min(...GYM_CHOICES.map((gym) => RM.incomeNeeded("combat", { augs: augList, nf: neuroFlux, mult: { hacking: hackMult, hackExp: 1, combat: combatNow, combatExp: player.mults.strength_exp || 1 }, income, expRate: rate || 1, installed: installedNow.size, runHours: RUN_HOURS, augStep, rep: repConfig, gates, combatLevel, maxRuns: 60, bb: { acts, rank: rankNow, lv: skillsNow, duty, gymHours: gym, skills, stamina } })));
	}

	lines.push(`--- Assumptions: aug multipliers multiply and stay installed through every reset; skill level = mult x (32 ln(exp+534.5) - 200) with exp restarting at each install; ${RUN_HOURS} h per run + 0.25 h reset overhead; about half of income x run is spendable; each aug bought in a run costs x${Number(augStep.toFixed(3))} more; pool of ${augList.length} hacking/combat augs; a faction not joined yet sells only once a run reaches its invite's hacking, combat and installed-aug levels (${Object.keys(gates).length} gated; its other conditions are assumed met); ${repResets ? "faction rep restarts at 0 at every install and becomes favor (rep x (1 + favor/100) later, donations from the favor line), so an aug's rep must be earned within one run, and Daedalus invites again each run" : "faction rep kept across installs (persistence.routeRepResets off)"}`);
	lines.push("--- Route simulation (reset by reset)");
	if (hackSim) {
		for (const { scenario, result } of hackSim) {
			const last = result.log[result.log.length - 1];
			lines.push(`Hacking, ${scenario.name}: ${fmtHours(result)}${result.reached ? "" : `; after ${result.runs} runs hacking x${last.hackMult.toFixed(1)}`}`);
		}
	} else if (!installed || level < required) lines.push("Hacking: needs a measured exp rate and income first");
	if (bladeSim && !live) lines.push(`Bladeburner first guess (no live readings yet): the game's action formulas at combat ${RM.JOIN_LEVEL}, this BitNode's rank x${nodeMults.rank.toFixed(2)} and skill cost x${nodeMults.skillCost.toFixed(2)}, combat levels x${(nodeMults.combatLevel ?? 1).toFixed(2)} (${nodeMults.known ? "this BitNode's multipliers" : "multipliers unknown without Source-File 5: no nerf assumed"}); it commits hacking only when hacking takes under ${PRIOR_MARGIN * 100} % of this time, otherwise Bladeburner trains and measures itself`);
	if (bladeSim) {
		for (const { scenario, result } of bladeSim) {
			const last = result.log[result.log.length - 1];
			lines.push(`Bladeburner, ${scenario.name}: ${fmtHours(result)}${result.reached ? "" : `; after ${result.runs} runs combat x${last.combat.map((value) => value.toFixed(0)).join("/")}, rank ${Math.round(last.rank || 0)}`} (gym ${result.gym} h per run)`);
		}
		if (live) lines.push(`Bladeburner calibration: the model predicts ${Number.isFinite(predicted) ? predicted.toFixed(1) : "?"} rank/h at full duty; measured ${Number.isFinite(measured) ? measured.toFixed(1) : "?"} rank/h${calibrated ? "" : " (window under 30 min: not yet reliable)"} => duty ${Math.round(duty * 100)}% ${calibrated ? "applied" : "assumed until 30 min of play are measured"}`);
		if (live) lines.push(`Best action chance now ${Math.round((chanceNow?.chance ?? 0) * 100)}% (${chanceNow?.name ?? "n/a"}); rank ${Math.floor(rankNow)}/400000. Skill points modelled for Overclock (now ${skills.oc}) and Blade's Intuition (now ${skills.bi}); stamina ${stamina ? "modelled" : "not modelled yet (no reading)"}; not modelled: Black Op chances and rank gates (hurt), city population`);
	} else if (blackOpsDone) lines.push("Bladeburner: every Black Op is done");
	else lines.push(`Bladeburner: ${acts ? "needs measured income" : "no live readings yet (they appear after bb-pass.js has run once)"}`);
	if ((hackSim || bladeSim) && !someFinish) {
		const income100 = (need) => Number.isFinite(need) ? `$${ns.format.number(income * need)}/s (x${need})` : "more than x4096";
		lines.push(`Income that would make a route take about 100 h (flat-income model, today's $${ns.format.number(income)}/s): hacking ${income100(needHack)}; Bladeburner ${income100(needBlade)}`);
	}

	// Verdict: only calibrated numbers count (over 400 h is "no estimate")
	const middle = (sim) => sim && sim[verdictIndex] ? sim[verdictIndex].result : null;
	const finishes = (result) => result && result.reached && result.hours <= 400 ? result.hours : Infinity;
	const hackHours = finishes(middle(hackSim));
	const bladeHours = finishes(middle(bladeSim));
	// The committed route survives an install: the port is emptied by the reset, and a fresh estimate would judge hacking by the
	// 75 % first-guess margin instead of the 25 % a route in progress gets (data/node-eta-route.json, kept per BitNode run)
	let kept = "";
	try {
		const saved = JSON.parse(ns.read(ROUTE_FILE) || "{}");
		if (saved.node === info.lastNodeReset && (saved.route === "hacking" || saved.route === "combat")) kept = saved.route;
	} catch { /* none yet */ }
	const previous = shared.plan?.route ?? (kept || undefined);
	let route = "";
	if (!blackOpsDone) {
		// One route at a time: flipping wastes the gym time, rank and faction rep already put into the committed one, so the other
		// route must be 25 % better by its own measure (hours when a scenario finishes, else the income it would need).
		const anyHours = Number.isFinite(hackHours) || Number.isFinite(bladeHours);
		const scoreHack = anyHours ? hackHours : (Number.isFinite(needHack) ? needHack : Infinity);
		const scoreBlade = anyHours ? bladeHours : (Number.isFinite(needBlade) ? needBlade : Infinity);
		route = pickRoute(scoreHack, scoreBlade, { hasHack: !!hackSim, previous, guess: !live && !!acts });
		const anyNumber = Number.isFinite(hackHours) || Number.isFinite(bladeHours);
		lines.push(`RECOMMENDED ROUTE${live ? "" : " (first guess)"}: ${route === "hacking" ? "hacking over several resets" : "Bladeburner (combat augs first)"}${anyNumber ? `, about ${Math.min(hackHours, bladeHours).toFixed(0)} h in the verdict scenario` : ": ETA unknown (no scenario finishes within 400 h at today's income); the route that needs the smaller income increase to become a 100 h route"}`);
	}
	// Is Bladeburner worth the player's time right now? From the live chance rescaled to the current skills (hysteresis).
	const wasHold = shared.plan?.hold === true;
	const hold = !!(live && chanceNow && chanceNow.chance < (wasHold ? RESUME_ABOVE : HOLD_BELOW));
	lines.push(`Bladeburner "run" now: ${!live ? "no data yet, it runs once to read the real chances" : hold ? `HOLD: best chance ${Math.round(chanceNow.chance * 100)}% is too low to earn rank; the player's time goes to faction rep and earning instead (resumes above ${RESUME_ABOVE * 100}%)` : `run: best chance ${Math.round(chanceNow.chance * 100)}%`}`);

	// Commit a route only once both sides have been measured: with no readings yet, "hacking" would make bb-manage.js hold Bladeburner,
	// so bb-pass.js would never read the chances and the combat route could never be evaluated. No route = the config route applies.
	// The exception is a first guess that puts hacking clearly ahead (the BitNode nerfs Bladeburner): training only to measure a
	// route that loses anyway is the waste it avoids. It stays a guess: re-checked every pass, and a clearly better Bladeburner
	// guess lets it train and measure again.
	const commit = committedRoute(route, live, !!acts);
	const priorHacking = commit.prior;
	if (!live && route && !priorHacking) lines.push("Route not committed yet: Bladeburner has no live readings, so it trains, joins and measures first");
	if (priorHacking) lines.push("Route committed from the first guess: hacking, without training for Bladeburner (bladeburner.priorRoute false turns this off)");
	if (commit.route && commit.route !== kept) ns.write(ROUTE_FILE, JSON.stringify({ node: info.lastNodeReset, route: commit.route }), "w");
	postBladeburner(ns, {
		eta: { stamp, samples },
		plan: { route: commit.route, prior: priorHacking || undefined, hold, daemonLevel: required, time: now },
	});
	return lines;
}

/**
 * The route to recommend from the two routes' scores (hours, or the income increase each needs; Infinity = no estimate). One route
 * at a time: flipping wastes the gym time, rank and faction rep already put into the committed one, so the other route must be
 * 25 % better. `guess` (Bladeburner from the first guess, no live readings): it is no measurement, so it moves to hacking only by
 * the same clear margin (PRIOR_MARGIN), else stays on Bladeburner, which then trains and measures. Pure, for the tests.
 * @param {number} scoreHack
 * @param {number} scoreBlade
 * @param {{ hasHack: boolean, previous?: string, guess?: boolean }} options
 * @returns {"hacking" | "combat"}
 */
export function pickRoute(scoreHack, scoreBlade, { hasHack, previous, guess = false }) {
	const best = scoreHack === Infinity && scoreBlade === Infinity ? (hasHack ? "hacking" : "combat") : scoreHack <= scoreBlade ? "hacking" : "combat";
	/** @type {"hacking" | "combat"} */
	let route = best;
	if (guess && previous !== "hacking" && !(scoreHack < PRIOR_MARGIN * scoreBlade)) route = "combat";
	if ((previous === "hacking" || previous === "combat") && previous !== best) {
		const keep = previous === "hacking" ? scoreHack : scoreBlade;
		const other = previous === "hacking" ? scoreBlade : scoreHack;
		if (Number.isFinite(keep) && !(other < 0.75 * keep)) route = previous;
		if (!Number.isFinite(keep) && !Number.isFinite(other)) route = previous;
	}
	return route;
}

/**
 * What goes into plan.route for bb-manage.js: the route once Bladeburner has live readings; before them only hacking from the
 * first guess (training to measure a route that loses anyway is the waste it avoids), otherwise nothing, so the config route
 * applies and Bladeburner trains, joins and measures. Pure, for the tests.
 * @param {string} route  the recommendation ("" when every Black Op is done)
 * @param {boolean} live  Bladeburner has live readings
 * @param {boolean} guessed  a first guess was made (bladeburner.priorRoute on, multipliers allow rank)
 */
export function committedRoute(route, live, guessed) {
	const prior = !live && guessed && route === "hacking";
	return { route: live || prior ? route || undefined : undefined, prior };
}
