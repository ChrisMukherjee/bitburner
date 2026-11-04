// Design: docs/bladeburner.md
import { bladeburnerState, postBladeburner, readBladeburner } from "/bladeburner/state.js";

const CONTRACTS = ["Tracking", "Bounty Hunter", "Retirement"];
const OPERATIONS = ["Investigation", "Undercover Operation", "Sting Operation", "Raid", "Stealth Retirement Operation", "Assassination"];
const CITIES = ["Sector-12", "Aevum", "Chongqing", "New Tokyo", "Ishima", "Volhaven"];
const MIN_CHANCE = 0.6;        // Contracts/Operations at or above this (lower estimate) are safe to run
const FALLBACK_CHANCE = 0.4;   // when nothing is that safe, the best one with at least this (middle estimate) beats idling
const BLACKOP_CHANCE = 0.8;    // a failed Black Op costs rank and health: wait for a safe chance
const REST_BELOW = 0.55;
const REST_UNTIL = 0.9;
const GENERAL = "General";
const RANK_WINDOW_MS = 3600_000;

/**
 * Bladeburner, ONE short pass (startup.js runs it every ~30 s while the state on port 36 is "run"): picks the
 * best action for rank per second and starts it. The game keeps repeating the action between passes, so a pass
 * only changes it when needed.
 * Goal: rank 400000 and every Black Op, which lets singularity/auto-destroy.js end the BitNode (no hacking needed).
 * Logic (no config): stamina first (rest below 55 %, until 90 %), then the next Black Op when its chance is safe,
 * otherwise the Contract/Operation with the best chance x rank gain / seconds; Field Analysis when the estimates
 * are too fuzzy, Diplomacy only when chaos is above 10, otherwise Training when nothing is safe yet.
 * Posts its reasoning as the status lines on port 36, plus rank samples and live readings for the route estimate.
 * Ported from the other player's bb-pass.js, which has run in game.
 */
/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	if (bladeburnerState(ns) !== "run") return;
	const bb = ns.bladeburner;
	if (!bb.inBladeburner()) return;
	const [stamina, maxStamina] = bb.getStamina();
	const ratio = maxStamina > 0 ? stamina / maxStamina : 1;
	const current = bb.getCurrentAction(); // { type, name } or null
	const rank = bb.getRank();
	const notes = [];

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

	let done = false;
	// 1. Stamina: low stamina makes every action fail more, so rest first
	const resting = current && current.name === "Hyperbolic Regeneration Chamber";
	if (ratio < REST_BELOW || (resting && ratio < REST_UNTIL)) {
		done = start(GENERAL, "Hyperbolic Regeneration Chamber", `stamina ${Math.round(ratio * 100)}%`);
	}

	// 2. The next Black Op, when rank allows and it is safe
	let next = null;
	let blackOpsDone; // true only when the game says no Black Op is left; undefined when not checked this pass
	if (!done) {
		next = bb.getNextBlackOp();
		blackOpsDone = next === null;
		if (next && rank >= next.rank) {
			const [low, high] = bb.getActionEstimatedSuccessChance("Black Operations", next.name);
			if (high - low > 0.1) done = start(GENERAL, "Field Analysis", `Black Op estimate too fuzzy (${Math.round(low * 100)}-${Math.round(high * 100)}%)`);
			else if (low >= BLACKOP_CHANCE) done = start("Black Operations", next.name, `${Math.round(low * 100)}% chance, rank ${Math.floor(rank)} >= ${next.rank}`);
			else notes.push(`${next.name} waits: only ${Math.round(low * 100)}% chance (need ${BLACKOP_CHANCE * 100}%)`);
		}
	}

	// 3. Contracts and Operations by expected rank per second
	let actions = null;
	if (!done) {
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
					let count = 0;
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
		rows.sort((first, second) => second.score - first.score);
		actions = readings(ns, bb, rows, [stamina, maxStamina]);
		for (const row of rows.slice(0, 4)) {
			notes.push(`  ${row.name}: ${Math.round(row.low * 100)}-${Math.round(row.high * 100)}% chance, ${row.gain.toFixed(2)} rank in ${row.seconds.toFixed(0)} s => ${row.score.toFixed(3)} rank/s`);
		}
		const safe = rows.filter((row) => row.low >= MIN_CHANCE); // safe by the pessimistic estimate
		const okay = rows.filter((row) => row.middle >= FALLBACK_CHANCE); // acceptable by the middle estimate
		const pool = safe.length > 0 ? safe : okay;
		const spread = Math.max(0, ...rows.map((row) => row.high - row.low));
		let chaos = 0;
		try { chaos = bb.getCityChaos(bb.getCity()); } catch { /* no city yet */ }

		if (pool.length > 0 && spread > 0.15 && safe.length === 0) {
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

	// Rank per hour, measured over this run (the samples survive on port 36 and are dropped when the rank falls: a new run)
	const now = Date.now();
	const samples = (readBladeburner(ns).rank ?? []).filter((sample) => now - sample.t < RANK_WINDOW_MS && sample.rank <= rank);
	samples.push({ t: now, rank });
	const span = now - samples[0].t;
	const perHour = span > 120_000 ? (rank - samples[0].rank) / (span / 3600_000) : NaN;
	const summary = `rank ${Math.floor(rank)}${Number.isFinite(perHour) ? ` (${Math.round(perHour)}/h)` : ""}; stamina ${Math.round(ratio * 100)}%; ` +
		`next Black Op: ${next ? `${next.name} at rank ${next.rank}` : "all done"}`;
	postBladeburner(ns, { script: ns.getScriptName(), lines: [summary, ...notes.slice(0, 3)], rank: samples, ...(blackOpsDone === undefined ? {} : { blackOps: { done: blackOpsDone, time: now } }), ...(actions ? { actions } : {}) });
}

/** Live readings the route estimate scales to other skill levels with the game's formulas. */
function readings(ns, bb, rows, stamina) {
	const cities = [];
	for (const city of CITIES) {
		try { cities.push({ name: city, pop: bb.getCityEstimatedPopulation(city), chaos: bb.getCityChaos(city) }); } catch { /* not unlocked */ }
	}
	return {
		t: Date.now(), lv: { ...ns.getPlayer().skills }, city: bb.getCity(), stamina, cities,
		rows: rows.map((row) => ({
			type: row.type, name: row.name, chance: row.middle, lo: row.low, hi: row.high,
			gain: row.gain, secs: row.seconds, level: row.level, maxLevel: row.maxLevel, count: row.count,
		})),
	};
}
