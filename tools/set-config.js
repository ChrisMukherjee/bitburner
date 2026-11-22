// Design: docs/config.md
// @ts-check
import { DEFAULTS, CHALLENGES, CHALLENGE_GROUPS } from "/config.js";
import { USER_CONFIG_FILE, CHALLENGE_STATE_FILE } from "/utils/config.js";
import { armNow, disarm } from "/utils/challenge.js";

/**
 * Changes your overrides in data/config.json without opening an editor. Keeps everything else in the
 * file, refuses to touch a file that isn't valid JSON, and checks the setting exists in config.js.
 * About 2.6GB. Scripts read the config when they start, so restart them (or `restart`) afterwards.
 *
 *   run /tools/set-config.js                          show this help and your current overrides
 *   run /tools/set-config.js route 4:3 2:1 5:1        BitNode route for auto-destroy.js, as bitNode:level
 *                                                     (a bare 5 means one more level of 5 than you will own);
 *                                                     done in order, owned ones skipped
 *   run /tools/set-config.js route                    show the route
 *   run /tools/set-config.js route plan               list every step of the plan (done / next marks), whether your route
 *                                                     overrides it and whether auto is on
 *   run /tools/set-config.js route clear              empty the route (the plan decides when auto is on, which it is by default;
 *                                                     with auto off auto-destroy waits for you)
 *   run /tools/set-config.js auto on                 let auto-destroy follow the plan's next BitNode by itself
 *                                                     (bitnodeRouteAuto); `auto off` goes back to only suggesting it;
 *                                                     `auto` alone shows which it is. A route you set always wins
 *   run /tools/set-config.js skip darknet/dnet-manager.js   add a script startup.js never starts
 *   run /tools/set-config.js skip clear               start everything again
 *   run /tools/set-config.js challenge bn1            go for a challenge achievement (CHALLENGES in config.js);
 *                                                     it applies from the start of the next run of that BitNode, so it can
 *                                                     be set in the run before; add --now to apply it in this run if it is
 *                                                     still clean (bn6-7 sets the BN6 and BN7 ones)
 *   run /tools/set-config.js challenge                list the challenges and which are on
 *   run /tools/set-config.js challenge clear          stop going for them
 *   run /tools/set-config.js set augments.wantStats hacking,rep    any setting by path; a value is JSON,
 *                                                     a comma list (becomes a list) or plain text
 *   run /tools/set-config.js unset augments.wantStats go back to the default for that setting
 */
/** @param {NS} ns */
export async function main(ns) {
	let [command, ...rest] = ns.args.map(String);
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
		if (rest[0] === "plan") {
			ns.tprint(describePlan(mine, ns.getResetInfo()).join("\n"));
			return;
		}
		if (rest.length === 0) {
			ns.tprint(`bitnodeRoute: ${describeRoute(mine.bitnodeRoute ?? DEFAULTS.bitnodeRoute, autoOn(mine))}`);
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
		save(ns, mine, `bitnodeRoute is now ${describeRoute(mine.bitnodeRoute, autoOn(mine))}.${mine.bitnodeRoute.length ? "" : " " + routeClearedText(mine)} auto-destroy.js picks it up when it next starts: run /startup.js --restart or restart it.`);
		return;
	}
	if (command === "auto") {
		const state = describeAuto(mine, rest[0]);
		if (state.error) {
			ns.tprint(`ERROR ${state.error} Nothing changed.`);
			return;
		}
		if (state.change !== undefined) {
			mine.bitnodeRouteAuto = state.change;
			save(ns, mine, state.text);
		} else ns.tprint(state.text);
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
			for (const [name, challenge] of sortedChallenges()) {
				ns.tprint(`${on.includes(name) ? "ON " : "off"} ${name}: "${challenge.achievement}", ${challenge.rule}`);
			}
			for (const [name, members] of Object.entries(CHALLENGE_GROUPS)) ns.tprint(`    ${name}: sets ${members.join(" and ")}`);
			return;
		}
		const now = rest.includes("--now");
		rest = rest.filter((name) => name !== "--now");
		const state = readState(ns);
		if (rest[0] === "clear") {
			mine.challenges = [];
			saveState(ns, disarm(state, on)); // clearing applies at once
			save(ns, mine, "No challenges any more; the usual settings apply again. Takes effect as scripts restart.");
			return;
		}
		const names = rest.flatMap((name) => CHALLENGE_GROUPS[name] ?? [name]);
		const unknown = names.filter((name) => !(name in CHALLENGES));
		if (unknown.length) {
			ns.tprint(`ERROR unknown challenge ${unknown.join(", ")}. Known: ${[...sortedChallenges().map(([name]) => name), ...Object.keys(CHALLENGE_GROUPS)].join(", ")}. Nothing changed.`);
			return;
		}
		mine.challenges = [...new Set([...on, ...names])];
		// A challenge applies from the start of the next BitNode run (utils/challenge.js), unless --now: this run may already have broken it.
		saveState(ns, now ? armNow(state, names) : disarm(state, names.filter((name) => !on.includes(name)))); // one already on keeps applying
		save(ns, mine, `challenges = ${JSON.stringify(mine.challenges)}${now ? " (applies NOW, in this run)" : " (applies from the start of the next run of its BitNode; add --now to apply it in this run if it is still clean)"}: ` +
			names.map((name) => `"${CHALLENGES[name].achievement}" (${CHALLENGES[name].rule})`).join("; ") +
			". Anything already done in that BitNode run (a division joined, a gang formed, home upgraded) can't be undone, so use --now only on a run that is still clean. Details: docs/challenges.md");
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

/** The challenges as [name, challenge] in BitNode order (bn1, bn2, bn6, bn7, bn10), whatever order config.js lists them in. */
export function sortedChallenges() {
	const number = (name) => parseInt(name.replace(/\D+/, ""), 10) || 0;
	return Object.entries(CHALLENGES).sort(([first], [second]) => number(first) - number(second));
}

function readState(ns) {
	try { return JSON.parse(ns.read(CHALLENGE_STATE_FILE)); } catch { return null; }
}

/** Writes the run state back (no state file yet = nothing to change: every challenge applies). */
function saveState(ns, state) {
	if (state) ns.write(CHALLENGE_STATE_FILE, JSON.stringify(state), "w");
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

/**
 * What `auto [on|off]` does: { text, change } where change is the new bitnodeRouteAuto value (undefined = just show),
 * or { error }. Pure, so a test can run it without the game.
 */
export function describeAuto(mine, word) {
	const route = mine.bitnodeRoute ?? DEFAULTS.bitnodeRoute;
	const willBeOn = word === undefined ? (mine.bitnodeRouteAuto ?? DEFAULTS.bitnodeRouteAuto) : word === "on";
	const note = route.length
		? ` You have your own route (${describeRoute(route, willBeOn)}); it is followed first${willBeOn ? ", then the plan carries on once it is done" : ", then you pick"}.`
		: " Your route is empty, so the plan decides.";
	if (word === undefined) {
		const on = willBeOn;
		return { text: `Auto route is ${on ? "ON: auto-destroy enters the plan's next BitNode by itself" : "OFF: the plan's next BitNode is only suggested"}.${note} autoroute on / autoroute off changes it; afk-route <bitNode:level ...> sets your own route.` };
	}
	if (word === "on" || word === "off") {
		const on = word === "on";
		return { change: on, text: `Auto route ${on ? "ON: auto-destroy follows the plan's next BitNode by itself" : "OFF: the plan's next BitNode is only suggested"}.${note} Takes effect when auto-destroy.js next starts (run /startup.js --restart).` };
	}
	return { error: `"${word}" isn't on or off, e.g. autoroute on.` };
}

/** Whether the plan is followed by itself: your override, else the default. */
function autoOn(mine) {
	return mine.bitnodeRouteAuto ?? DEFAULTS.bitnodeRouteAuto;
}

/** What auto-destroy does with an empty route, given the player's overrides. Pure, so a test can run it without the game. */
export function routeClearedText(mine) {
	const skipped = (mine.startupSkip ?? DEFAULTS.startupSkip).includes("singularity/auto-destroy.js");
	const note = skipped ? " Note: singularity/auto-destroy.js is in startupSkip, so startup.js won't start it (skip clear to undo)." : "";
	return (autoOn(mine)
		? "Auto route is ON, so auto-destroy follows the plan's next BitNode by itself: nothing else to switch on (autoroute off to only get suggestions)."
		: "Auto route is OFF, so auto-destroy waits for you: run autoroute on to let it follow the plan, or next-bitnode <n> to choose.") + note;
}

function describeRoute(route, auto = autoOn({})) {
	return route.length ? route.map((step) => `BN${step.bitNode} level ${step.level}`).join(" -> ") : auto ? "empty (the plan decides; afk-route plan lists it)" : "empty (auto-destroy waits for you; afk-route plan lists the plan)";
}

/**
 * The `route plan` listing: every step of the plan with done / current / next marks, then who decides (your route or the plan,
 * auto on or off). Pure (info is ns.getResetInfo(): { currentNode, ownedSF }), so a test can run it without the game.
 * "current" is the BitNode you are in while its level isn't owned yet; "next" is the first open step of the lowest open tier
 * (counting the level this BitNode gives when destroyed), and when that tier has several open steps they are all marked "next"
 * because the easiest one goes first (known with Source-File 5).
 */
export function describePlan(mine, info) {
	const plan = mine.bitnodePlan ?? DEFAULTS.bitnodePlan;
	const route = mine.bitnodeRoute ?? DEFAULTS.bitnodeRoute;
	const auto = autoOn(mine);
	const owned = new Map(info.ownedSF);
	const after = new Map(owned);
	after.set(info.currentNode, (after.get(info.currentNode) ?? 0) + 1);
	const open = plan.filter((step) => (after.get(step.bitNode) ?? 0) < step.level);
	const tier = open.length ? Math.min(...open.map((step) => step.tier ?? 1)) : null;
	const lines = [`bitnodePlan (${plan.length} steps; you are in BitNode ${info.currentNode}):`];
	const reached = new Map(); // highest level earlier plan steps already take each BitNode to, so a step shows the levels it adds
	for (const step of plan) {
		const from = (reached.get(step.bitNode) ?? 0) + 1;
		reached.set(step.bitNode, Math.max(step.level, reached.get(step.bitNode) ?? 0));
		const levels = from >= step.level ? `SF${step.bitNode}.${step.level}` : `SF${step.bitNode}.${from}-${step.level}`;
		const have = owned.get(step.bitNode) ?? 0;
		let mark = "    ";
		let note = have ? `you own SF${step.bitNode}.${have}` : `you own none of SF${step.bitNode}`;
		if (have >= step.level) mark = "done";
		else if (open.includes(step) && (step.tier ?? 1) === tier) mark = ">>  ";
		if (step.bitNode === info.currentNode && have < step.level) note += ", you are in it now";
		lines.push(`  ${mark}  step ${String(step.tier ?? 1).padStart(2)}  BN${String(step.bitNode).padEnd(2)} ${levels.padEnd(10)} (${note})`);
	}
	lines.push(open.length ? ">> is the step you are on or up next. Steps are done in number order. Rows with the same step number can be done in any order; the scripts pick the easiest (needs SF5), otherwise top to bottom." : "Every step of the plan is reached.");
	if (route.length) lines.push(`Your bitnodeRoute (${describeRoute(route, auto)}) overrides the plan: it is followed first${auto ? ", then the plan carries on" : ", then you pick"}.`);
	else lines.push("No bitnodeRoute of your own: the plan decides.");
	lines.push(auto ? "Auto route is ON: auto-destroy enters the next BitNode by itself (autoroute off to only get suggestions)." : "Auto route is OFF: the next BitNode is only suggested (autoroute on to follow it by itself).");
	return lines;
}

function help(ns, mine) {
	ns.tprint([
		"set-config: change data/config.json without an editor.",
		"  route 4:3 2:1 5:1      BitNode route (bitNode:level), done in order, owned ones skipped",
		"  route / route clear    show / empty the route",
		"  route plan             list the whole plan with done / next marks (alias: afk-route plan)",
		"  auto on / auto off     let auto-destroy follow the plan's next BitNode by itself / only suggest it (auto shows which; alias autoroute)",
		"                         your own route (afk-route) is followed first; with auto on the plan carries on after it",
		"  skip <script...>       scripts startup.js never starts (skip clear to undo)",
		`  challenge <name>       go for a challenge achievement (${[...sortedChallenges().map(([name]) => name), ...Object.keys(CHALLENGE_GROUPS)].join(", ")}); challenge clear to stop`,
		"  set <path> <value>     any setting, e.g. set augments.wantStats hacking,rep",
		"  unset <path>           back to the default",
		`Your overrides: ${Object.keys(mine).length ? JSON.stringify(mine) : "none"}`,
	].join("\n"));
}
