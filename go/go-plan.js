// Design: docs/go-bot.md
// @ts-check
// Which Go opponents the current plan wants played first. 0GB (ports only, no NS functions besides peek).
import { readBladeburner } from "/bladeburner/state.js";

const GANG_PORT = 28;  // gang-manager.js summary
const GOALS_PORT = 23; // faction goals (singularity/workers/faction-goals.js)
const FRESH_MS = 30 * 60_000;

// Used when the config has no `go` section: the order the bot always had.
export const DEFAULT_ROTATION = ["The Black Hand", "Daedalus", "Illuminati", "Netburners", "Tetrads", "Slum Snakes"];

/** Which plan conditions hold right now: { gang, bladeburner, repGoals }. Each one is false when its mechanic isn't running. */
/** @param {NS} ns */
export function planSignals(ns) {
	const now = Date.now();
	const gang = ns.peek(GANG_PORT);
	let goals = null;
	try { goals = JSON.parse(ns.peek(GOALS_PORT)); } catch { /* nothing posted */ }
	const bb = readBladeburner(ns);
	return {
		gang: !!gang && typeof gang === "object" && now - (gang.time ?? 0) < FRESH_MS,
		bladeburner: ["boot", "train", "run"].includes(bb.state) && now - (bb.stateTime ?? 0) < FRESH_MS,
		// The plan wants reputation at Daedalus (an aug there, or The Red Pill).
		repGoals: !!goals?.goals && now - (goals.time ?? 0) < FRESH_MS && (goals.goals.Daedalus?.rep ?? 0) > 0,
	};
}

/**
 * The opponents in the order the bot tries them. Plan-aware (`go.planAware`): opponents whose bonus the
 * running plan uses come first (config `go.boosts`: gang -> crime/combat, Bladeburner -> combat stats,
 * open Daedalus rep goal -> Daedalus), then the stage's focus, then `go.rotation`.
 * With no gang, Bladeburner or goals running (or planAware off) this is [focus, ...rotation], as before.
 * Returns { order, boosted } (boosted: [{ opponent, why }] for the log and status).
 */
/** @param {NS} ns */
export function goOrder(ns, config, focus, { noPlan = false, rotation = null } = {}) {
	const go = config?.go ?? {};
	const base = rotation ?? (Array.isArray(go.rotation) && go.rotation.length ? go.rotation : DEFAULT_ROTATION);
	const boosted = [];
	if (!noPlan && !rotation && go.planAware !== false) {
		const signals = planSignals(ns);
		for (const [why, opponents] of Object.entries(go.boosts ?? {})) {
			if (!signals[why] || !Array.isArray(opponents)) continue;
			for (const opponent of opponents) if (!boosted.some((entry) => entry.opponent === opponent)) boosted.push({ opponent, why });
		}
	}
	const order = [...new Set([...boosted.map((entry) => entry.opponent), focus, ...base])];
	return { order, boosted };
}
