// Design: docs/bladeburner.md
import { readIncomeRate } from "/utils/income.js";
import { hasSingularity } from "/utils/singularity.js";
import { bladeburnerAccess } from "/utils/bladeburner.js";
import { postPass } from "/utils/pass-log.js";
import { readBladeburner, postBladeburner } from "/bladeburner/state.js";
import * as RM from "/bladeburner/route-model.js";

// Every faction that sells augmentations (names from the game), to build the pool of augs the simulation can buy
const ALL_FACTIONS = ["CyberSec", "NiteSec", "The Black Hand", "BitRunners", "Daedalus", "The Covenant", "Illuminati", "ECorp", "MegaCorp",
	"Bachman & Associates", "Blade Industries", "NWO", "Clarke Incorporated", "OmniTek Incorporated", "Four Sigma", "KuaiGong International",
	"Fulcrum Secret Technologies", "Tian Di Hui", "Netburners", "Sector-12", "Aevum", "Chongqing", "New Tokyo", "Ishima", "Volhaven",
	"Slum Snakes", "Tetrads", "Silhouette", "Speakers for the Dead", "The Dark Army", "The Syndicate"];
// WorldDaemonDifficulty per BitNode from bitburner-src v3.0.1 (BN12 grows with its level and is not listed)
const WORLD_DAEMON_DIFFICULTY = { 1: 1, 2: 5, 3: 2, 4: 3, 5: 1.5, 6: 2, 7: 2, 8: 1, 9: 2, 10: 2, 11: 1.5, 13: 3, 14: 5, 15: 2 };
// Faction reputation multiplier of the BitNode (game source)
const BN_FACTION_REP = { 2: 0.5, 4: 0.75, 13: 0.6, 14: 0.2 };
const COMBAT_STATS = ["strength", "defense", "dexterity", "agility"];
const RED_PILL = "The Red Pill";
const DAEDALUS = "Daedalus";
const WORLD = "w0r1d_d43m0n";
const RUN_HOURS = 4;             // modelled length of a run
const GYM_CHOICES = [1, 2, 3];   // gym hours per run the combat model tries
const HISTORY_FILE = "data/node-eta-history.json";   // income vs multiplier across runs; survives resets, so it is a file
const REPORT_FILE = "data/node-eta.txt";
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
 * Writes the verdict on port 36 as `plan` ({ route, hold, time }), which bb-manage.js follows:
 *   route  "hacking" or "combat"; kept between passes and changed only for a 25 % better route. Left out until bb-pass.js has posted
 *          live action readings, so Bladeburner can measure itself before the first verdict (the config route applies meanwhile)
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
	if (!home && ns.fileExists(HISTORY_FILE, "home")) ns.scp(HISTORY_FILE, ns.getHostname(), "home");
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
	if (!home) ns.scp([REPORT_FILE, HISTORY_FILE].filter((file) => ns.fileExists(file)), "home");
}

/** The whole estimate; returns the report lines and posts the plan. */
function estimate(ns) {
	const sing = ns.singularity;
	const info = ns.getResetInfo();
	const node = info.currentNode;
	const player = ns.getPlayer();
	const level = player.skills.hacking;
	const mult = player.mults.hacking || 1;
	const exp = player.exp.hacking;
	const now = Date.now();
	const shared = readBladeburner(ns);
	const lines = [`${new Date().toLocaleTimeString()}  BitNode ${node}`];

	// Daemon requirement: the server once it exists, otherwise 3000 x the BitNode's difficulty
	let required = 3000 * (WORLD_DAEMON_DIFFICULTY[node] ?? 1);
	try { required = ns.getServer(WORLD).requiredHackingSkill; } catch { /* hidden until The Red Pill is installed */ }

	// Measured hacking exp rate: samples of this run, kept on port 36 (trimmed to 30 minutes)
	const stamp = String(info.lastAugReset);
	const old = shared.eta && shared.eta.stamp === stamp ? shared.eta : { stamp, samples: [] };
	const samples = old.samples.filter((sample) => now - sample.t < 30 * 60_000 && sample.exp <= exp);
	samples.push({ t: now, exp });
	const rate = now - samples[0].t >= 2 * 60_000 ? (exp - samples[0].exp) / ((now - samples[0].t) / 1000) : NaN; // exp per second
	const income = readIncomeRate(ns).perSecond;
	const money = ns.getServerMoneyAvailable("home");

	// The Red Pill and Daedalus
	const installed = sing.getOwnedAugmentations(false).includes(RED_PILL);
	const joined = player.factions.includes(DAEDALUS);
	const rpRep = sing.getAugmentationRepReq(RED_PILL);
	const rpPrice = sing.getAugmentationPrice(RED_PILL);
	const haveRep = joined ? sing.getFactionRep(DAEDALUS) : 0;
	lines.push(`Hacking ${level}/${required}; multiplier ${mult.toFixed(2)}; exp rate ${Number.isFinite(rate) ? rate.toFixed(1) + "/s" : "still measuring"}`);
	lines.push(`Red Pill: ${installed ? "installed" : joined ? `rep ${Math.round(haveRep)}/${Math.round(rpRep)}, price $${ns.format.number(rpPrice)}` : "Daedalus has not invited you"}`);

	// The pool of augs the simulation can buy: every hacking or combat aug of every faction (prices scaled back to "none queued")
	const installedNow = new Set(sing.getOwnedAugmentations(false));
	const queued = Math.max(0, sing.getOwnedAugmentations(true).length - installedNow.size);
	const pool = new Map();
	for (const faction of new Set([...player.factions, ...ALL_FACTIONS])) {
		let list = [];
		try { list = sing.getAugmentationsFromFaction(faction); } catch { continue; }
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
			pool.set(name, { name, price: sing.getAugmentationPrice(name) / RM.AUG_STEP ** queued, rep, f: [faction], h: hackMult, e: hackExp, cs: combat });
		}
	}
	const augList = [...pool.values()];
	let neuroFlux = null;
	try {
		const stats = sing.getAugmentationStats("NeuroFlux Governor");
		neuroFlux = {
			price: sing.getAugmentationPrice("NeuroFlux Governor") / RM.AUG_STEP ** queued, rep: sing.getAugmentationRepReq("NeuroFlux Governor"),
			h: stats.hacking ?? 1, e: stats.hacking_exp ?? 1, cs: COMBAT_STATS.map((key) => stats[key] ?? 1),
		};
	} catch { /* not offered */ }

	// Income growth with the multiplier: measured over earlier runs when there are enough, otherwise three scenarios
	let history = [];
	try { history = JSON.parse(ns.read(HISTORY_FILE)); } catch { /* none yet */ }
	if (!Array.isArray(history)) history = [];
	if (income > 0 && level >= 10) {
		const current = history.find((entry) => entry.stamp === stamp);
		if (current) { if (income > current.income) { current.income = income; current.t = now; } current.mult = mult; }
		else history.push({ stamp, t: now, mult, income });
		history = history.slice(-30);
		ns.write(HISTORY_FILE, JSON.stringify(history), "w");
	}
	let incomeExponent = NaN;
	const points = history.filter((entry) => entry.income > 0 && entry.mult > 0);
	if (points.length >= 3 && Math.max(...points.map((entry) => entry.mult)) / Math.min(...points.map((entry) => entry.mult)) > 1.3) {
		const xs = points.map((entry) => Math.log(entry.mult));
		const ys = points.map((entry) => Math.log(entry.income));
		const meanX = xs.reduce((sum, x) => sum + x, 0) / xs.length;
		const meanY = ys.reduce((sum, y) => sum + y, 0) / ys.length;
		const sxx = xs.reduce((sum, x) => sum + (x - meanX) ** 2, 0);
		const sxy = xs.reduce((sum, x, index) => sum + (x - meanX) * (ys[index] - meanY), 0);
		if (sxx > 0) incomeExponent = Math.min(3, Math.max(0, sxy / sxx));
	}
	const scenarios = Number.isFinite(incomeExponent)
		? [{ name: "low", income: incomeExponent * 0.7, exp: incomeExponent * 0.35 }, { name: "measured", income: incomeExponent, exp: incomeExponent * 0.5 }, { name: "high", income: incomeExponent * 1.3, exp: incomeExponent * 0.65 }]
		: [{ name: "low (income flat)", income: 0, exp: 0 }, { name: "middle (income ~ multiplier)", income: 1, exp: 0.5 }, { name: "high (income ~ multiplier^2)", income: 2, exp: 1 }];
	lines.push(Number.isFinite(incomeExponent)
		? `Confidence: medium, income growth measured over ${points.length} runs (income ~ multiplier^${incomeExponent.toFixed(2)})`
		: "Confidence: low, income growth with the multiplier is not measured yet (needs 3 runs with different multipliers), so three scenarios are shown");
	const fmtHours = (result) => !result ? "unknown" : result.reached && result.hours <= 400 ? `${result.hours.toFixed(0)} h (${result.runs} runs)`
		: result.reached ? `over 400 h (${result.hours.toFixed(0)} h modelled: too uncertain to call an estimate)` : "not reached within 60 runs";
	const repConfig = { facMult: player.mults.faction_rep || 1, bn: BN_FACTION_REP[node] ?? 1, timeShare: 0.7 };
	const combatNow = COMBAT_STATS.map((key) => player.mults[key] || 1);
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
					augs: augList, nf: neuroFlux, mult: { hacking: mult, hackExp: player.mults.hacking_exp || 1, combat: combatNow, combatExp: 1 }, income, expRate: rate,
					installed: installedNow.size, runHours: RUN_HOURS, rep: repConfig, scenario, maxRuns: 60, hackRoute,
				}),
			}));
		}
	}

	// Bladeburner route, from the live readings bb-pass.js posts
	const actData = shared.actions;
	const skillsNow = { ...player.skills };
	const rankSamples = Array.isArray(shared.rank) ? shared.rank : [];
	let acts = null;
	let bladeSim = null;
	let chanceNow = null;
	let duty = 0.5;
	let predicted = NaN;
	let measured = NaN;
	let calibrated = false;
	let rankNow = 0;
	if (!blackOpsDone) {
		if (rankSamples.length > 0) {
			const first = rankSamples[0];
			const last = rankSamples[rankSamples.length - 1];
			rankNow = last.rank;
			if (last.t - first.t > 120_000) measured = (last.rank - first.rank) / ((last.t - first.t) / 3600_000);
			calibrated = last.t - first.t > 30 * 60_000;
		}
		if (actData && Array.isArray(actData.rows) && actData.rows.length) {
			acts = RM.makeBladeburner(actData.rows.map((row) => ({ ...row, lv: actData.lv })));
			chanceNow = RM.bestChanceNow(acts, skillsNow);
			const bestThen = RM.bestChanceNow(acts, actData.lv).chance;
			predicted = RM.predictRankPerHour(acts, actData.lv, 1, Math.min(0.4, bestThen * 0.9));
			if (predicted > 0 && Number.isFinite(measured)) duty = Math.min(1, Math.max(0.05, measured / predicted));
		}
		if (acts && income > 0) {
			bladeSim = scenarios.map((scenario) => {
				let best = null;
				for (const gym of GYM_CHOICES) {
					const result = RM.projectRoute("combat", {
						augs: augList, nf: neuroFlux, mult: { hacking: mult, hackExp: 1, combat: combatNow, combatExp: player.mults.strength_exp || 1 }, income, expRate: rate || 1,
						installed: installedNow.size, runHours: RUN_HOURS, rep: repConfig, scenario, maxRuns: 60, bb: { acts, rank: rankNow, lv: skillsNow, duty, gymHours: gym },
					});
					result.gym = gym;
					if (!best || (result.reached && !best.reached) || (result.reached === best.reached && result.hours < best.hours)) best = result;
				}
				return { scenario, result: best };
			});
		}
	}

	// "Income that would make a route take about 100 h" (flat-income model): the robust comparison when no scenario finishes
	let needHack = NaN;
	let needBlade = NaN;
	if (hackSim) {
		needHack = RM.incomeNeeded("hacking", { augs: augList, nf: neuroFlux, mult: { hacking: mult, hackExp: player.mults.hacking_exp || 1, combat: combatNow, combatExp: 1 }, income, expRate: rate, installed: installedNow.size, runHours: RUN_HOURS, rep: repConfig, maxRuns: 60, hackRoute });
	}
	if (bladeSim) {
		needBlade = Math.min(...GYM_CHOICES.map((gym) => RM.incomeNeeded("combat", { augs: augList, nf: neuroFlux, mult: { hacking: mult, hackExp: 1, combat: combatNow, combatExp: player.mults.strength_exp || 1 }, income, expRate: rate || 1, installed: installedNow.size, runHours: RUN_HOURS, rep: repConfig, maxRuns: 60, bb: { acts, rank: rankNow, lv: skillsNow, duty, gymHours: gym } })));
	}

	lines.push(`--- Assumptions: aug multipliers multiply and stay installed through every reset; skill level = mult x (32 ln(exp+534.5) - 200) with exp restarting at each install; ${RUN_HOURS} h per run + 0.25 h reset overhead; about half of income x run is spendable; each aug bought in a run costs x${RM.AUG_STEP} more; pool of ${augList.length} hacking/combat augs`);
	lines.push("--- Route simulation (reset by reset)");
	if (hackSim) {
		for (const { scenario, result } of hackSim) {
			const last = result.log[result.log.length - 1];
			lines.push(`Hacking, ${scenario.name}: ${fmtHours(result)}${result.reached ? "" : `; after ${result.runs} runs hacking x${last.hackMult.toFixed(1)}`}`);
		}
	} else if (!installed || level < required) lines.push("Hacking: needs a measured exp rate and income first");
	if (bladeSim) {
		for (const { scenario, result } of bladeSim) {
			const last = result.log[result.log.length - 1];
			lines.push(`Bladeburner, ${scenario.name}: ${fmtHours(result)}${result.reached ? "" : `; after ${result.runs} runs combat x${last.combat.map((value) => value.toFixed(0)).join("/")}, rank ${Math.round(last.rank || 0)}`} (gym ${result.gym} h per run)`);
		}
		lines.push(`Bladeburner calibration: the model predicts ${Number.isFinite(predicted) ? predicted.toFixed(1) : "?"} rank/h at full duty; measured ${Number.isFinite(measured) ? measured.toFixed(1) : "?"} rank/h${calibrated ? "" : " (window under 30 min: not yet reliable)"} => duty ${Math.round(duty * 100)}% applied`);
		lines.push(`Best action chance now ${Math.round((chanceNow?.chance ?? 0) * 100)}% (${chanceNow?.name ?? "n/a"}); rank ${Math.floor(rankNow)}/400000. Not modelled: skill points (help), Black Op chances and rank gates (hurt), city population`);
	} else if (blackOpsDone) lines.push("Bladeburner: every Black Op is done");
	else lines.push(`Bladeburner: ${acts ? "needs measured income" : "no live readings yet (they appear after bb-pass.js has run once)"}`);
	if (hackSim || bladeSim) {
		const income100 = (need) => Number.isFinite(need) ? `$${ns.format.number(income * need)}/s (x${need})` : "more than x4096";
		lines.push(`Income that would make a route take about 100 h (flat-income model, today's $${ns.format.number(income)}/s): hacking ${income100(needHack)}; Bladeburner ${income100(needBlade)}`);
	}

	// Verdict: only calibrated numbers count (over 400 h is "no estimate")
	const middle = (sim) => sim && sim[1] ? sim[1].result : null;
	const finishes = (result) => result && result.reached && result.hours <= 400 ? result.hours : Infinity;
	const hackHours = finishes(middle(hackSim));
	const bladeHours = finishes(middle(bladeSim));
	const previous = shared.plan?.route;
	let route = "";
	if (!blackOpsDone) {
		// One route at a time: flipping wastes the gym time, rank and faction rep already put into the committed one, so the other
		// route must be 25 % better by its own measure (hours when a scenario finishes, else the income it would need).
		const anyHours = Number.isFinite(hackHours) || Number.isFinite(bladeHours);
		const scoreHack = anyHours ? hackHours : (Number.isFinite(needHack) ? needHack : Infinity);
		const scoreBlade = anyHours ? bladeHours : (Number.isFinite(needBlade) ? needBlade : Infinity);
		const best = scoreHack === Infinity && scoreBlade === Infinity ? (hackSim ? "hacking" : "combat") : scoreHack <= scoreBlade ? "hacking" : "combat";
		route = best;
		if ((previous === "hacking" || previous === "combat") && previous !== best) {
			const keep = previous === "hacking" ? scoreHack : scoreBlade;
			const other = previous === "hacking" ? scoreBlade : scoreHack;
			if (Number.isFinite(keep) && !(other < 0.75 * keep)) route = previous;
			if (!Number.isFinite(keep) && !Number.isFinite(other)) route = previous;
		}
		const anyNumber = Number.isFinite(hackHours) || Number.isFinite(bladeHours);
		lines.push(`RECOMMENDED ROUTE: ${route === "hacking" ? "hacking over several resets" : "Bladeburner (combat augs first)"}${anyNumber ? `, about ${Math.min(hackHours, bladeHours).toFixed(0)} h in the middle scenario` : ": ETA unknown (no scenario finishes within 400 h at today's income); the route that needs the smaller income increase to become a 100 h route"}`);
	}
	// Is Bladeburner worth the player's time right now? From the live chance rescaled to the current skills (hysteresis).
	const wasHold = shared.plan?.hold === true;
	const hold = !!(acts && chanceNow && chanceNow.chance < (wasHold ? RESUME_ABOVE : HOLD_BELOW));
	lines.push(`Bladeburner "run" now: ${!acts ? "no data yet, it runs once to read the real chances" : hold ? `HOLD: best chance ${Math.round(chanceNow.chance * 100)}% is too low to earn rank; the player's time goes to faction rep and earning instead (resumes above ${RESUME_ABOVE * 100}%)` : `run: best chance ${Math.round(chanceNow.chance * 100)}%`}`);

	// Commit a route only once both sides have been measured: with no readings yet, "hacking" would make bb-manage.js hold Bladeburner,
	// so bb-pass.js would never read the chances and the combat route could never be evaluated. No route = the config route applies.
	if (!acts && route) lines.push("Route not committed yet: Bladeburner has no live readings, so it trains, joins and measures first");
	postBladeburner(ns, {
		eta: { stamp, samples },
		plan: { route: acts ? route || undefined : undefined, hold, time: now },
	});
	return lines;
}
