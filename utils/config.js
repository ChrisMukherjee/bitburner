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
	return config;
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
