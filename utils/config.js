// Design: docs/config.md
import { DEFAULTS, PRESETS } from "/config.js";
import { notify } from "/utils/notify.js";

// Each player's own overrides, written in the game (see config.js). Never synced from disk.
export const USER_CONFIG_FILE = "data/config.json";
// The current BitNode number, written by startup.js (getResetInfo costs 1GB, so loadConfig doesn't call it).
export const BITNODE_FILE = "data/bitnode.txt";

/**
 * The settings for this player: DEFAULTS from config.js, then the chosen preset, then
 * data/config.json. Objects merge key by key; lists and single values replace. 0GB.
 * Each layer may have a `bitnodes` section ({ "2": {...} }); the entry for the current BitNode
 * (from data/bitnode.txt) is laid over that layer right after it.
 *
 * The files are read from the server the script runs on; startup.js and utils/start-helper.js
 * copy them along when they place a script off home.
 */
/** @param {NS} ns */
export function loadConfig(ns) {
	let custom = {};
	const text = ns.read(USER_CONFIG_FILE);
	if (text.trim()) {
		try {
			custom = JSON.parse(text);
		} catch (error) {
			notify(ns, "[config]", `${USER_CONFIG_FILE} isn't valid JSON (${error.message}); using the defaults.`, "error", true);
			custom = {};
		}
	}
	const profile = custom.profile ?? DEFAULTS.profile;
	let preset = PRESETS[profile];
	if (!preset) {
		notify(ns, "[config]", `unknown profile "${profile}" in ${USER_CONFIG_FILE} (known: ${Object.keys(PRESETS).join(", ")}).`, "error", true);
		preset = {};
	}
	const node = currentBitNode(ns);
	const layers = [DEFAULTS, preset, custom].flatMap((layer) => [layer, layer?.bitnodes?.[node]]);
	const config = layers.reduce((merged, layer) => mergeOver(merged, layer), {});
	config.bitnode = node; // null until startup.js has run once
	incomeAdjust(ns, config);
	routeAdjust(ns, config);
	return config;
}

// Port 36 is the Bladeburner state (bladeburner/state.js); read raw here so this file imports nothing from that folder
// (every script that loads the config would otherwise need it copied along).
const BLADEBURNER_PORT = 36;
const BLADEBURNER_STATE_MAX_AGE_MS = 15 * 60_000; // as in bladeburner/state.js: an older state counts as off

/**
 * Logic, not config: while Bladeburner is the route (the state on port 36 is boot, train or run, or hold while the route estimate
 * still says combat), what makes an augment worth buying changes. Rank comes from Contracts and Operations whose success chance
 * depends on the combat stats, so combat and Bladeburner augments count (strongly) and hacking augments do not (they would
 * only reset the combat stats for nothing). `profile: "bladeburner"` in data/config.json is no longer needed for this. 0GB.
 * Ported from the other player's utils/config.js.
 */
/** @param {NS} ns */
function routeAdjust(ns, config) {
	let shared = null;
	try { shared = JSON.parse(ns.peek(BLADEBURNER_PORT)); } catch { /* nothing posted */ }
	if (!shared || typeof shared !== "object") return;
	const state = Date.now() - (shared.stateTime ?? 0) < BLADEBURNER_STATE_MAX_AGE_MS ? shared.state : "off";
	const aug = config.augments;
	if (!aug || !(["boot", "train", "run"].includes(state) || (state === "hold" && shared.plan?.route === "combat"))) return;
	const want = new Set((aug.wantStats ?? []).filter((group) => group !== "hacking"));
	for (const group of ["combat", "bladeburner"]) want.add(group);
	aug.wantStats = [...want];
	const weights = aug.resetRule?.weights;
	if (weights) {
		for (const stat of ["strength", "defense", "dexterity", "agility"]) weights[stat] ??= 1;
		for (const stat of ["strength_exp", "defense_exp", "dexterity_exp", "agility_exp"]) weights[stat] ??= 0.5;
		for (const stat of ["bladeburner_success_chance", "bladeburner_max_stamina", "bladeburner_stamina_gain", "bladeburner_analysis"]) weights[stat] ??= 1;
	}
}

// Port 38 is the income mix (utils/income-mix.js, posted by buy-augs.js); read raw here so loading the config stays 0GB.
const INCOME_MIX_PORT = 38;

/**
 * Logic, not config: money stats count by where this run's money comes from. Sets augments.incomeFactors, one number per
 * stat listed in augments.incomeMix.stats (the summed portion of money its sources earned); aug-filter.js multiplies that
 * stat's weight by it, and drops the stat from "worth buying" below incomeMix.minPortion. Portions come from this run's
 * earnings, or the whole BitNode's while this run has earned less than minEarned, or unknownPortions without a fresh post.
 * Sets augments.incomeMixSource too ("this run", "this BitNode" or "default"), for display. 0GB.
 */
/** @param {NS} ns */
function incomeAdjust(ns, config) {
	const aug = config.augments;
	const mix = aug?.incomeMix;
	if (!mix?.enabled) return;
	let post = null;
	try { post = JSON.parse(ns.peek(INCOME_MIX_PORT)); } catch { /* nothing posted */ }
	const fresh = post && typeof post === "object" && Date.now() - (post.time ?? 0) < (mix.maxAgeMinutes ?? 30) * 60_000;
	const total = (earned) => Object.values(earned ?? {}).reduce((sum, amount) => sum + amount, 0);
	let earned = null;
	aug.incomeMixSource = "default";
	if (fresh && total(post.sinceInstall) >= mix.minEarned) [earned, aug.incomeMixSource] = [post.sinceInstall, "this run"];
	else if (fresh && total(post.sinceStart) >= mix.minEarned) [earned, aug.incomeMixSource] = [post.sinceStart, "this BitNode"];
	const sum = earned ? total(earned) : 1;
	const portions = {};
	for (const [source, amount] of Object.entries(earned ?? mix.unknownPortions ?? {})) portions[source] = amount / sum;
	aug.incomePortions = portions;
	const factors = {};
	for (const [source, stats] of Object.entries(mix.stats ?? {})) {
		for (const stat of stats) factors[stat] = (factors[stat] ?? 0) + (portions[source] ?? 0);
	}
	aug.incomeFactors = factors;
}

/** The BitNode startup.js last saw, or null. */
function currentBitNode(ns) {
	const node = parseInt(ns.read(BITNODE_FILE), 10);
	return Number.isFinite(node) ? node : null;
}

/** base with every key of extra laid over it: plain objects merge, anything else replaces. */
function mergeOver(base, extra) {
	for (const [key, value] of Object.entries(extra ?? {})) {
		base[key] = isPlainObject(value) && isPlainObject(base[key]) ? mergeOver(base[key], value) : copyOf(value);
	}
	return base;
}

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function copyOf(value) {
	return value === undefined ? value : JSON.parse(JSON.stringify(value));
}
