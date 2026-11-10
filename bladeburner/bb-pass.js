// Design: docs/bladeburner.md
import { postPass } from "/utils/pass-log.js";
import { loadConfig } from "/utils/config.js";
import { pickCity, nextRestShare, scoutTarget, BLACKOP_CHANCE } from "/bladeburner/picks.js";
import { idealRankRate, staminaRegen, measuredRate, hoursToRank, nextShare, keepRankSamples } from "/bladeburner/ideal.js";
import { bladeburnerState, postBladeburner, readBladeburner } from "/bladeburner/state.js";
import { readIncomeRate } from "/utils/income.js";
import { blackOpDecision, chanceGrowth, failureBill, memberValue, nextTrend, recruitSeconds, teamBonus } from "/bladeburner/team.js";

const CONTRACTS = ["Tracking", "Bounty Hunter", "Retirement"];
const OPERATIONS = ["Investigation", "Undercover Operation", "Sting Operation", "Raid", "Stealth Retirement Operation", "Assassination"];
const CITIES = ["Sector-12", "Aevum", "Chongqing", "New Tokyo", "Ishima", "Volhaven"];
const MIN_CHANCE = 0.6;        // Contracts/Operations at or above this (lower estimate) are safe to run
const FALLBACK_CHANCE = 0.4;   // when nothing is that safe, the best one with at least this (middle estimate) beats idling
const SCOUT_SHARE_MAX = 0.2;   // scouting while a safe action waits takes at most this share of the passes (moving share)
const FINAL_RANK = 400_000;    // Operation Daedalus, the last Black Op, needs this rank
const PERF_LOG_MS = 3600_000;  // one line of the efficiency log per hour
const PERF_LOG_MAX = 48;
const REST_BELOW = 0.55;
const REST_UNTIL = 0.9;
const GENERAL = "General";
const RANK_WINDOW_MS = 3600_000;

/**
 * Bladeburner, ONE short pass (startup.js runs it every ~30 s while the state on port 36 is "run"): picks the
 * best action for rank per second and starts it. The game keeps repeating the action between passes, so a pass
 * only changes it when needed.
 * Goal: rank 400000 and every Black Op, which lets singularity/auto-destroy.js end the BitNode (no hacking needed).
 * Logic: stamina first (rest below 55 %, until 90 %), then the next Black Op when it is safe, pays for itself in rank or
 * holds the BitNode back (bladeburner/team.js, `bladeburner.blackOpGate`; false = only at 80 %), then Recruitment when a
 * team member is worth it (`bladeburner.team`: free while every safe action's counts are used up, otherwise only when it
 * saves the Black Op more time than it takes), otherwise the Contract/Operation with the best chance x rank gain / seconds;
 * Field Analysis when the estimates are too fuzzy, Diplomacy only when chaos is above 10, otherwise Training when nothing
 * is safe yet. bb-manage.js puts the team on the Black Op (teamPlan on port 36).
 * Posts its reasoning as the status lines on port 36, plus rank samples and live readings for the route estimate.
 * Ported from the other player's bb-pass.js, which has run in game.
 */
/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	if (bladeburnerState(ns) !== "run") return;
	const bb = ns.bladeburner;
	if (!bb.inBladeburner()) return;
	const settings = loadConfig(ns).bladeburner;
	const [stamina, maxStamina] = bb.getStamina();
	const ratio = maxStamina > 0 ? stamina / maxStamina : 1;
	const current = bb.getCurrentAction(); // { type, name } or null
	const rank = bb.getRank();
	const notes = [];
	const before = readBladeburner(ns);
	// An action the game stopped (its count ran out, or stamina hit 0) leaves the player idle until this pass: idle time to measure
	const idle = current === null;
	let blackOp = null; // the next Black Op's reading, for bb-manage.js's skill choice
	let banked = NaN;   // counts waiting on the safe actions: many = the clock is the limit, none = the supply of counts is

	const start = (type, name, why) => {
		if (current && current.type === type && current.name === name) {
			notes.push(`keeping ${name}: ${why}`);
			return true;
		}
		if (bb.startAction(type, name)) {
			notes.push(`started ${name}: ${why}`);
			return true;
		}
		return false;
	};

	// Rank per hour, measured over this run (the samples survive on port 36 and are dropped when the rank falls: a new run,
	// or after a gap: time held or training is not play)
	const now = Date.now();
	const samples = keepRankSamples(before.rank, rank, now, RANK_WINDOW_MS);
	samples.push({ t: now, rank });
	const perHour = measuredRate(samples);

	let done = false;
	let scouting = false; // Field Analysis chosen this pass to settle a better action's range (step 5), for the scouting share
	// 1. Stamina: low stamina makes every action fail more, so rest first
	const resting = current && current.name === "Hyperbolic Regeneration Chamber";
	if (ratio < REST_BELOW || (resting && ratio < REST_UNTIL)) {
		done = start(GENERAL, "Hyperbolic Regeneration Chamber", `stamina ${Math.round(ratio * 100)}%`);
	}

	// 2. Read the Contracts and Operations (the Black Op gate prices its time in their rank per second)
	let actions = null;
	let rows = [];
	let next = null;
	let progress;     // Black Ops done / total, the next one and rank, for tools/status.js (undefined when not read this pass)
	let blackOpsDone; // true only when the game says no Black Op is left; undefined when not checked this pass
	let free = false; // the safe actions' counts are used up: the player's time earns little rank this pass
	let teamPlan;     // the team the next Black Op should have, for bb-manage.js (bladeburner.team)
	let trend = before.blackOpTrend;
	if (!done) {
		rows = readRows(bb, notes);
		next = bb.getNextBlackOp();
		blackOpsDone = next === null;
		progress = blackOpProgress(bb, next, rank, now);
		if (next) blackOp = blackOpReading(bb, next);
		actions = readings(ns, bb, rows, [stamina, maxStamina], rank, blackOp);
		free = rows.some((row) => row.low >= MIN_CHANCE && row.count < 1) && !rows.some((row) => row.low >= MIN_CHANCE && row.count >= 1);
		banked = rows.filter((row) => row.count >= 1 && row.low >= MIN_CHANCE).reduce((sum, row) => sum + Math.floor(row.count), 0);
	}
	const freeShare = done ? before.freeShare : nextShare(before.freeShare, free);

	// 3. The next Black Op, once rank allows: when it is safe, pays for itself or holds the BitNode back (bladeburner/team.js)
	let recruit = null; // { secs, value } when a member is worth recruiting this pass
	if (!done && next) {
		const team = Number(before.team?.size) || 0;
		const assigned = before.team?.name === next.name ? Math.min(Number(before.team?.assigned) || 0, team) : 0;
		const odds = recruitOdds(bb);
		const player = ns.getPlayer();
		const income = readIncomeRate(ns).perSecond;
		const bestRate = Math.max(0, ...rows.filter((row) => row.count >= 1 && row.low >= MIN_CHANCE).map((row) => row.score));
		const rankRate = Number.isFinite(perHour) && perHour > 0 ? perHour / 3600 : bestRate;
		const reading = blackOp ?? { chance: 0, high: 0, gain: 0, secs: 1 };
		trend = nextTrend(trend, next.name, reading.chance / teamBonus(assigned), now);
		const decision = blackOpDecision({
			name: next.name, chance: reading.chance, assigned, size: team, gain: reading.gain, secs: reading.secs, rank, rankRate,
			recruitSecs: odds.secs, timeValue: 1 - (Number.isFinite(freeShare) ? freeShare : 0),
			bill: failureBill(next.name, player.hp, player.money), income, growth: chanceGrowth(trend), safeChance: BLACKOP_CHANCE,
		});
		if (settings.team) {
			teamPlan = { name: next.name, members: decision.team, all: decision.all, time: now };
			recruit = { secs: odds.secs, value: memberValue(decision.pricing, team) };
		}
		if (current && current.type === "Black Operations" && current.name === next.name) {
			done = start(current.type, current.name, "a Black Op under way is never abandoned (the time spent on it would be lost)");
		} else if (rank >= next.rank) {
			const { chance: low, high } = reading;
			const attempt = settings.blackOpGate ? decision.attempt : low >= BLACKOP_CHANCE;
			if (high - low > 0.1) {
				done = start(GENERAL, "Field Analysis", `Black Op estimate too fuzzy (${Math.round(low * 100)}-${Math.round(high * 100)}%)`);
			} else if (attempt) {
				done = start("Black Operations", next.name, settings.blackOpGate ? `${decision.reason}: ${decision.why}` : `${Math.round(low * 100)}% chance, rank ${Math.floor(rank)} >= ${next.rank}`);
			} else {
				notes.push(settings.blackOpGate ? `${next.name} waits (${decision.reason}): ${decision.why}` : `${next.name} waits: only ${Math.round(low * 100)}% chance (need ${BLACKOP_CHANCE * 100}%)`);
			}
		}
	}

	// 4. Recruit a team member: free while the counts are used up, otherwise only when a member saves the Black Op more
	// time than recruiting takes
	if (!done && recruit && Number.isFinite(recruit.secs) && recruit.value > 0 && (free || (next && rank >= next.rank && recruit.value > recruit.secs))) {
		done = start(GENERAL, "Recruitment", `${free ? "no safe counts left" : "the Black Op needs a bigger team"}: a member saves the next Black Op about ${Math.round(recruit.value)} s (${Math.round(recruit.secs)} s to recruit)`);
	}

	// The best few actions, after what the Black Op and recruiting steps said (the status shows the first lines)
	for (const row of rows.slice(0, 4)) {
		notes.push(`  ${row.name}: ${Math.round(row.low * 100)}-${Math.round(row.high * 100)}% chance, ${row.gain.toFixed(2)} rank in ${row.seconds.toFixed(0)} s => ${row.score.toFixed(3)} rank/s`);
	}

	// 5. Contracts and Operations by expected rank per second
	if (!done) {
		const live = rows.filter((row) => row.count >= 1); // an action with no count left can't be started: don't plan on it
		const safe = live.filter((row) => row.low >= MIN_CHANCE); // safe by the pessimistic estimate
		const okay = live.filter((row) => row.middle >= FALLBACK_CHANCE); // acceptable by the middle estimate
		const pool = safe.length > 0 ? safe : okay;
		const spread = Math.max(0, ...live.map((row) => row.high - row.low));
		let chaos = 0;
		try { chaos = bb.getCityChaos(bb.getCity()); } catch { /* no city yet */ }

		// A safe action is being played but a better one is too uncertain to call: scout (Field Analysis) until the ranges settle
		// At most SCOUT_SHARE_MAX of the time: Field Analysis narrows the range only a little each time (more slowly with low stats), and
		// without a cap it could take all the time while the safe counts pile up unplayed (a real BitNode 6 start: 8 % efficiency)
		const scout = settings.fieldAnalysis && !((before.scoutShare ?? 0) >= SCOUT_SHARE_MAX) ? scoutTarget(rows, MIN_CHANCE) : null;
		scouting = !!scout;
		if (scout) {
			done = start(GENERAL, "Field Analysis", `${scout.name} (${Math.round(scout.low * 100)}-${Math.round(scout.high * 100)}% chance) could beat the safe action; the population estimate is too rough to tell`);
		}

		if (done) {
			// scouting this pass
		} else if (pool.length > 0 && spread > 0.15 && safe.length === 0) {
			done = start(GENERAL, "Field Analysis", `estimates too fuzzy to trust (up to ${Math.round(spread * 100)} points wide) and nothing is clearly safe yet`);
		} else if (pool.length > 0) {
			const best = pool[0];
			const running = current && pool.find((row) => row.type === current.type && row.name === current.name);
			if (running && running.score >= best.score * 0.75) {
				notes.push(`keeping ${running.name}: still within 25% of the best (${best.name})`);
				done = true;
			} else {
				for (const row of pool) {
					if (start(row.type, row.name, `${Math.round(row.low * 100)}-${Math.round(row.high * 100)}% chance, ${row.score.toFixed(3)} rank/s`)) {
						done = true;
						break;
					}
					notes.push(`${row.name}: startAction refused (none left?)`);
				}
			}
		}
		if (!done && chaos > 10) done = start(GENERAL, "Diplomacy", `no action is safe and city chaos is ${chaos.toFixed(1)}`);
		if (!done && spread > 0.15) done = start(GENERAL, "Field Analysis", `no action is safe and estimates are fuzzy (${Math.round(spread * 100)} points)`);
		if (!done) {
			done = start(GENERAL, "Training", `no Contract or Operation is safe yet (best ${rows[0] ? Math.round(rows[0].middle * 100) + "%" : "n/a"}, chaos ${chaos.toFixed(1)}): training raises the stats and so the chances`);
		}
	}

	// 6. The city: population and chaos change every chance (bladeburner/picks.js), so play where they are best. Done last, because
	// the readings above belong to the city they were taken in; the next pass reads the new one.
	if (actions && settings.switchCity) {
		const move = pickCity(actions);
		if (move && bb.switchCity(move.city)) notes.unshift(`moved to ${move.city}: about ${Math.round(move.gain * 100)}% more rank per second (needs ${Math.round(move.needed * 100)}% to beat the estimate noise)`);
	}

	const idleShare = nextShare(before.idleShare, idle);
	const scoutShare = nextShare(before.scoutShare, scouting);
	const penaltyShare = nextShare(before.penaltyShare, ratio < 0.5);
	const summary = `rank ${Math.floor(rank)}${Number.isFinite(perHour) ? ` (${Math.round(perHour)}/h)` : ""}; stamina ${Math.round(ratio * 100)}%; ` +
		`next Black Op: ${next ? `${next.name} at rank ${next.rank}` : "all done"}`;
	// Measured against the most the game's formulas allow (bladeburner/ideal.js), so a slow run says why
	const perf = actions ? efficiencyReport(ns, before, actions, { maxStamina, perHour, rank, banked, idleShare, penaltyShare, now }) : null;
	const fresh = before.perf && now - before.perf.t < 600_000 ? before.perf : null; // keep the last figures through a rest or Black Op pass
	const lines = [summary, ...((perf ?? fresh)?.line ? [(perf ?? fresh).line] : []), ...notes.slice(0, 3)];
	postPass(ns, ns.getScriptName(), lines);
	const now2 = bb.getCurrentAction(); // what is running after this pass, for the "Doing:" line of tools/status.js
	// Share of passes spent resting for stamina: tells bb-manage.js whether Cyber's Edge or Overclock is worth the points
	const restShare = nextRestShare(before.restShare, !!now2 && now2.name === "Hyperbolic Regeneration Chamber");
	const log = perf ? perfLog(before.perfLog, perf, rank, now) : undefined;
	postBladeburner(ns, {
		restShare, idleShare, penaltyShare, scoutShare, script: ns.getScriptName(), action: now2 ? { type: now2.type, name: now2.name, time: now } : null, lines, rank: samples,
		...(perf ? { perf, perfLog: log } : {}),
		...(blackOpsDone === undefined ? {} : { blackOps: { done: blackOpsDone, time: now } }), ...(progress ? { progress } : {}), ...(actions ? { actions } : {}),
		freeShare, ...(next ? { blackOpTrend: trend } : {}), ...(teamPlan ? { teamPlan } : {}),
	});
}

/** Every Contract and Operation's chance range, rank gain, seconds, level and count, best expected rank per second first. */
function readRows(bb, notes) {
	const rows = [];
	for (const [type, names] of [["Contracts", CONTRACTS], ["Operations", OPERATIONS]]) {
		for (const name of names) {
			try {
				const [low, high] = bb.getActionEstimatedSuccessChance(type, name);
				const gain = bb.getActionRankGain(type, name);
				const seconds = bb.getActionTime(type, name) / 1000;
				const middle = (low + high) / 2;
				let level = 1;
				let maxLevel = 1;
				let count = 1; // the game's own refusal (startAction) covers a failed read
				try {
					level = bb.getActionCurrentLevel(type, name);
					maxLevel = bb.getActionMaxLevel(type, name);
					count = bb.getActionCountRemaining(type, name);
				} catch { /* not every action has levels */ }
				rows.push({ type, name, low, high, middle, gain, seconds, level, maxLevel, count, score: (middle * gain) / Math.max(1, seconds) });
			} catch (error) {
				notes.push(`${name}: not available (${String(error).slice(0, 60)})`);
			}
		}
	}
	return rows.sort((first, second) => second.score - first.score);
}

/** Recruitment's seconds per member (its time over its chance; the chance falls as the team grows), Infinity when it can't succeed. */
function recruitOdds(bb) {
	try {
		const [chance] = bb.getActionEstimatedSuccessChance(GENERAL, "Recruitment");
		return { chance, secs: recruitSeconds(bb.getActionTime(GENERAL, "Recruitment") / 1000, chance) };
	} catch {
		return { chance: 0, secs: Infinity };
	}
}

/**
 * How far along the Black Ops are: how many are done of the total (they run in order, so the next one's position says it), the
 * next one's rank requirement and chance, and the rank Operation Daedalus (the last) needs. null when the game won't say.
 */
function blackOpProgress(bb, next, rank, now) {
	try {
		const names = bb.getBlackOpNames();
		const position = next ? names.indexOf(next.name) : names.length;
		const reading = next ? blackOpReading(bb, next) : null;
		return {
			done: position < 0 ? 0 : position, total: names.length, rank, finalRank: FINAL_RANK, time: now,
			next: next ? { name: next.name, rank: next.rank, chance: reading?.chance ?? 0, high: reading?.high ?? 0 } : null,
		};
	} catch { return null; }
}

/** The next Black Op's chance (low estimate) and reward, or null when the game won't say. */
function blackOpReading(bb, next) {
	try {
		const [low, high] = bb.getActionEstimatedSuccessChance("Black Operations", next.name);
		return {
			name: next.name, rank: next.rank, chance: low, high,
			gain: bb.getActionRankGain("Black Operations", next.name), secs: bb.getActionTime("Black Operations", next.name) / 1000,
		};
	} catch { return null; }
}

/**
 * The efficiency report: measured rank per hour against the ceiling of bladeburner/ideal.js, what limits the ceiling, and the
 * signs of waste (idle passes, passes under 50 % stamina where every chance is cut, counts banked while the clock is the limit).
 */
function efficiencyReport(ns, before, actions, measured) {
	const levels = before.skillLevels ?? {};
	const player = ns.getPlayer();
	const agility = (player.skills?.agility ?? 1) * (1 + 0.02 * (levels["Reaper"] ?? 0)) * (1 + 0.04 * (levels["Evasive System"] ?? 0));
	const regen = staminaRegen(measured.maxStamina, agility, (1 + 0.02 * (levels["Cyber's Edge"] ?? 0)) * (player.mults?.bladeburner_stamina_gain ?? 1));
	const ideal = idealRankRate(actions.rows.map((row) => ({ name: row.name, chance: row.chance, gain: row.gain, secs: row.secs, level: row.level, count: row.count })), measured.maxStamina, regen, RANK_WINDOW_MS / 1000);
	if (!(ideal.perHour > 0)) return null;
	const efficiency = measured.perHour / ideal.perHour;
	const eta = hoursToRank(measured.rank, FINAL_RANK, measured.perHour);
	const pct = (value) => `${Math.round(value * 100)}%`;
	const line = `efficiency: ${Number.isFinite(measured.perHour) ? `${Math.round(measured.perHour)} rank/h of at most ${Math.round(ideal.perHour)} (${pct(efficiency)})` : `at most ${Math.round(ideal.perHour)} rank/h`}, ` +
		`limited by ${ideal.limiter}; idle ${pct(measured.idleShare)}, stamina under 50% ${pct(measured.penaltyShare)}; ${Number.isFinite(measured.banked) ? measured.banked : "?"} safe counts banked` +
		(Number.isFinite(eta) && measured.rank < FINAL_RANK ? `; rank ${FINAL_RANK / 1000}k in ~${eta < 10 ? eta.toFixed(1) : Math.round(eta)} h if this rate held (eta models the growth)` : "");
	return {
		t: measured.now, perHour: Number.isFinite(measured.perHour) ? measured.perHour : null, ceiling: ideal.perHour, efficiency: Number.isFinite(efficiency) ? efficiency : null,
		limiter: ideal.limiter, idle: measured.idleShare, penalty: measured.penaltyShare, banked: Number.isFinite(measured.banked) ? measured.banked : null,
		etaHours: Number.isFinite(eta) ? eta : null, regen, best: ideal.byAction.slice(0, 3), line,
	};
}

/** The hourly efficiency log kept on port 36 (`perfLog`): one entry per hour, the last PERF_LOG_MAX of them. */
function perfLog(previous, perf, rank, now) {
	const log = Array.isArray(previous) ? previous.slice() : [];
	if (log.length === 0 || now - log[log.length - 1].t >= PERF_LOG_MS) {
		log.push({ t: now, rank: Math.floor(rank), perHour: perf.perHour, ceiling: perf.ceiling, limiter: perf.limiter, idle: perf.idle, banked: perf.banked });
	}
	return log.slice(-PERF_LOG_MAX);
}

/** Live readings the route estimate scales to other skill levels with the game's formulas. */
function readings(ns, bb, rows, stamina, rank, blackOp) {
	const cities = [];
	for (const city of CITIES) {
		try { cities.push({ name: city, pop: bb.getCityEstimatedPopulation(city), chaos: bb.getCityChaos(city) }); } catch { /* not unlocked */ }
	}
	return {
		t: Date.now(), lv: { ...ns.getPlayer().skills }, city: bb.getCity(), stamina, cities, rank, ...(blackOp ? { blackOp } : {}),
		rows: rows.map((row) => ({
			type: row.type, name: row.name, chance: row.middle, lo: row.low, hi: row.high,
			gain: row.gain, secs: row.seconds, level: row.level, maxLevel: row.maxLevel, count: row.count,
		})),
	};
}
