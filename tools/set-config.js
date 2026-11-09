// Design: docs/config.md
// @ts-check
import { DEFAULTS, CHALLENGES } from "/config.js";
import { USER_CONFIG_FILE } from "/utils/config.js";

/**
 * Changes your overrides in data/config.json without opening an editor. Keeps everything else in the
 * file, refuses to touch a file that isn't valid JSON, and checks the setting exists in config.js.
 * About 3.6GB. Scripts read the config when they start, so restart them (or `restart`) afterwards.
 *
 *   run /tools/set-config.js                          show this help and your current overrides
 *   run /tools/set-config.js route 4:3 2:1 5:1        BitNode route for auto-destroy.js, as bitNode:level
 *                                                     (a bare 5 means one more level of 5 than you will own);
 *                                                     done in order, owned ones skipped
 *   run /tools/set-config.js route                    show the route
 *   run /tools/set-config.js route clear              empty the route (auto-destroy then waits for you)
 *   run /tools/set-config.js skip darknet/dnet-manager.js   add a script startup.js never starts
 *   run /tools/set-config.js skip clear               start everything again
 *   run /tools/set-config.js challenge bn1            go for a challenge achievement (CHALLENGES in config.js);
 *                                                     set it before that BitNode starts
 *   run /tools/set-config.js challenge                list the challenges and which are on
 *   run /tools/set-config.js challenge clear          stop going for them
 *   run /tools/set-config.js set augments.wantStats hacking,rep    any setting by path; a value is JSON,
 *                                                     a comma list (becomes a list) or plain text
 *   run /tools/set-config.js unset augments.wantStats go back to the default for that setting
 */
/** @param {NS} ns */
export async function main(ns) {
	const [command, ...rest] = ns.args.map(String);
	const text = ns.read(USER_CONFIG_FILE).trim();
	let mine = {};
	if (text) {
		try {
			mine = JSON.parse(text);
		} catch (error) {
			ns.tprint(`ERROR ${USER_CONFIG_FILE} isn't valid JSON (${error.message}); not touching it. Fix it with nano ${USER_CONFIG_FILE}.`);
			return;
		}
	}
	if (!command || command === "help") {
		help(ns, mine);
		return;
	}
	if (command === "route") {
		if (rest.length === 0) {
			ns.tprint(`bitnodeRoute: ${describeRoute(mine.bitnodeRoute ?? DEFAULTS.bitnodeRoute)}`);
			return;
		}
		if (rest[0] === "clear") {
			mine.bitnodeRoute = [];
		} else {
			const steps = [];
			for (const item of rest) {
				const [bitNode, given] = item.split(":").map(Number);
				// A bare number means "one more level of it": the level you will own once this BitNode ends, plus one.
				const level = given ?? nextLevel(ns, bitNode);
				if (!Number.isInteger(bitNode) || bitNode < 1 || bitNode > 15 || !Number.isInteger(level) || level < 1) {
					ns.tprint(`ERROR "${item}" isn't bitNode:level (BitNode 1-15, level 1 or more), e.g. 4:3 or 5. Nothing changed.`);
					return;
				}
				steps.push({ bitNode, level });
			}
			mine.bitnodeRoute = steps;
		}
		save(ns, mine, `bitnodeRoute is now ${describeRoute(mine.bitnodeRoute)}. auto-destroy.js picks it up when it next starts: run /startup.js --restart or restart it.`);
		return;
	}
	if (command === "skip") {
		if (rest[0] === "clear") mine.startupSkip = [];
		else if (rest.length === 0) {
			ns.tprint(`startupSkip: ${JSON.stringify(mine.startupSkip ?? DEFAULTS.startupSkip)}`);
			return;
		} else mine.startupSkip = [...new Set([...(mine.startupSkip ?? DEFAULTS.startupSkip), ...rest])];
		save(ns, mine, `startupSkip is now ${JSON.stringify(mine.startupSkip)}. Takes effect on the next startup.`);
		return;
	}
	if (command === "challenge") {
		const on = [mine.challenges ?? DEFAULTS.challenges].flat();
		if (rest.length === 0) {
			for (const [name, challenge] of Object.entries(CHALLENGES)) {
				ns.tprint(`${on.includes(name) ? "ON " : "off"} ${name}: "${challenge.achievement}", ${challenge.rule}`);
			}
			return;
		}
		if (rest[0] === "clear") {
			mine.challenges = [];
			save(ns, mine, "No challenges any more; the usual settings apply again. Takes effect as scripts restart.");
			return;
		}
		const unknown = rest.filter((name) => !(name in CHALLENGES));
		if (unknown.length) {
			ns.tprint(`ERROR unknown challenge ${unknown.join(", ")}. Known: ${Object.keys(CHALLENGES).join(", ")}. Nothing changed.`);
			return;
		}
		mine.challenges = [...new Set([...on, ...rest])];
		save(ns, mine, `challenges = ${JSON.stringify(mine.challenges)}: ` +
			rest.map((name) => `"${CHALLENGES[name].achievement}" (${CHALLENGES[name].rule})`).join("; ") +
			". Upgrades already bought in that BitNode can't be undone, so set this before it starts. Details: docs/challenges.md");
		return;
	}
	if (command === "set" || command === "unset") {
		const path = (rest[0] ?? "").split(".").filter(Boolean);
		if (path.length === 0 || (command === "set" && rest.length < 2)) {
			ns.tprint(`Usage: set <path> <value>   or   unset <path>, e.g. set augments.wantStats hacking,rep`);
			return;
		}
		if (!(path[0] in DEFAULTS)) {
			ns.tprint(`ERROR no setting "${path[0]}". Known: ${Object.keys(DEFAULTS).join(", ")}. Nothing changed.`);
			return;
		}
		if (command === "unset") {
			let node = mine;
			for (const key of path.slice(0, -1)) node = node?.[key];
			if (!node || !(path.at(-1) in node)) {
				ns.tprint(`${rest[0]} isn't set in ${USER_CONFIG_FILE}; nothing to remove.`);
				return;
			}
			delete node[path.at(-1)];
			save(ns, mine, `Removed ${rest[0]}; the default applies again.`);
			return;
		}
		const value = parseValue(rest.slice(1).join(" "));
		const dflt = path.reduce((node, key) => node?.[key], DEFAULTS);
		if (dflt !== undefined && Array.isArray(dflt) !== Array.isArray(value)) {
			ns.tprint(`ERROR ${rest[0]} is ${Array.isArray(dflt) ? "a list (use a,b,c or [..])" : "not a list"}. Nothing changed.`);
			return;
		}
		let node = mine;
		for (const key of path.slice(0, -1)) {
			if (typeof node[key] !== "object" || node[key] === null) node[key] = {};
			node = node[key];
		}
		node[path.at(-1)] = value;
		save(ns, mine, `${rest[0]} = ${JSON.stringify(value)}`);
		return;
	}
	ns.tprint(`ERROR unknown command "${command}". Run /tools/set-config.js for help.`);
}

/** One level beyond what you will own of that BitNode after this one ends (the current BitNode is about to give one). */
function nextLevel(ns, bitNode) {
	const info = ns.getResetInfo();
	const owned = new Map(info.ownedSF).get(bitNode) ?? 0;
	return owned + (info.currentNode === bitNode ? 1 : 0) + 1;
}

function save(ns, mine, message) {
	ns.write(USER_CONFIG_FILE, JSON.stringify(mine, null, 2), "w");
	ns.tprint(`${message} (saved to ${USER_CONFIG_FILE}; scripts read it when they start)`);
}

function parseValue(raw) {
	try {
		return JSON.parse(raw);
	} catch {
		return raw.includes(",") ? raw.split(",").map((part) => part.trim()).filter(Boolean) : raw;
	}
}

function describeRoute(route) {
	return route.length ? route.map((step) => `BN${step.bitNode} level ${step.level}`).join(" -> ") : "empty (auto-destroy waits for you)";
}

function help(ns, mine) {
	ns.tprint([
		"set-config: change data/config.json without an editor.",
		"  route 4:3 2:1 5:1      BitNode route (bitNode:level), done in order, owned ones skipped",
		"  route / route clear    show / empty the route",
		"  skip <script...>       scripts startup.js never starts (skip clear to undo)",
		`  challenge <name>       go for a challenge achievement (${Object.keys(CHALLENGES).join(", ")}); challenge clear to stop`,
		"  set <path> <value>     any setting, e.g. set augments.wantStats hacking,rep",
		"  unset <path>           back to the default",
		`Your overrides: ${Object.keys(mine).length ? JSON.stringify(mine) : "none"}`,
	].join("\n"));
}
