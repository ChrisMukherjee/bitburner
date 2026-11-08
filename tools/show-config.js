// @ts-check
import { loadConfig, USER_CONFIG_FILE } from "/utils/config.js";
import { unknownStatGroups } from "/utils/aug-filter.js";
import { STAT_GROUPS, PRESETS } from "/config.js";

/**
 * Prints the settings the scripts will use: config.js defaults, the chosen profile, and your
 * data/config.json on top. Warns about stat group names it doesn't know. About 1.6GB.
 *
 *   run /tools/show-config.js            everything
 *   run /tools/show-config.js augments   one section
 *   run /tools/show-config.js --example  a starter data/config.json (with your current values)
 *                                        to paste into `nano data/config.json` and edit
 */
/** @param {NS} ns */
export async function main(ns) {
	const flags = ns.flags([["example", false]]);
	const config = loadConfig(ns);
	if (flags.example) {
		printExample(ns, config);
		return;
	}
	const section = flags._[0] === undefined ? null : String(flags._[0]);
	const own = ns.read(USER_CONFIG_FILE).trim() ? USER_CONFIG_FILE : "none (defaults only)";
	const node = config.bitnode === null ? "BitNode unknown (run startup.js once)" : `BitNode ${config.bitnode}`;
	ns.tprint(`profile "${config.profile}", ${node} (its \`bitnodes\` entry applied if any), your overrides: ${own}`);
	if (section && !(section in config)) {
		ns.tprint(`ERROR no section "${section}". Sections: ${Object.keys(config).join(", ")}`);
		return;
	}
	ns.tprint("\n" + JSON.stringify(section ? config[section] : config, null, 2));
	const unknown = unknownStatGroups(config.augments);
	if (unknown.length) {
		ns.tprint(`WARNING augments.wantStats has unknown groups: ${unknown.join(", ")}. Known: ${Object.keys(STAT_GROUPS).join(", ")}`);
	}
}

/** The settings people change most, filled with the current values, ready to paste. */
function printExample(ns, config) {
	const example = {
		profile: config.profile,
		augments: {
			wantStats: config.augments.wantStats,
			never: config.augments.never,
			resetRule: { minRunMinutes: config.augments.resetRule.minRunMinutes, waitMargin: config.augments.resetRule.waitMargin },
		},
		studying: { hackLevel: config.studying.hackLevel },
		startupSkip: config.startupSkip,
		bitnodeRoute: config.bitnodeRoute,
	};
	ns.tprint([
		"",
		`Starter ${USER_CONFIG_FILE}. Copy the JSON below, run \`nano ${USER_CONFIG_FILE}\`, paste, edit, save.`,
		"Leave out anything you don't want to change. Restart the scripts afterwards.",
		`  profile: one of ${Object.keys(PRESETS).join(", ")}`,
		`  augments.wantStats: any of ${Object.keys(STAT_GROUPS).join(", ")}`,
		"  augments.never: augment names never to buy, e.g. [\"CashRoot Starter Kit\"]",
		"  startupSkip: scripts startup.js never starts, e.g. [\"darknet/dnet-manager.js\"]",
		"  bitnodeRoute: [{ bitNode, level }] for auto-destroy.js, done in order",
		"  More (faction order, spending stages, ...): see config.js, or `run /tools/show-config.js` for all current values.",
		"",
		JSON.stringify(example, null, 2),
	].join("\n"));
}
