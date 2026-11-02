import { DEFAULTS, PRESETS } from "/config.js";
import { notify } from "/utils/notify.js";

// Each player's own overrides, written in the game (see config.js). Never synced from disk.
export const USER_CONFIG_FILE = "data/config.json";

/**
 * The settings for this player: DEFAULTS from config.js, then the chosen preset, then
 * data/config.json. Objects merge key by key; lists and single values replace. 0GB.
 *
 * The file is read from the server the script runs on; startup.js copies it along when it
 * places a script off home.
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
	return mergeOver(mergeOver(copyOf(DEFAULTS), preset), custom);
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
