// Design: docs/api-advice.md
// @ts-check
/**
 * What to tell the player when a script runs without an API or item that a BitNode or Source-File unlocks: what is
 * missing, what the scripts do meanwhile, and what to do about it (which BitNode to destroy, or what to buy). The advice
 * is computed from the run: the Source-Files owned, the BitNode you are in and `bitnodePlan` in the config, so it changes as
 * the player progresses. Each piece is printed once per BitNode run (not once per script start), and
 * `missingApiAdvice.enabled: false` in the config turns it all off.
 *
 * Costs 0GB on purpose: it never calls getResetInfo itself. Pass in the result of ns.getResetInfo() (every script that has
 * a capability check already paid for it), so a Singularity script's RAM does not change by importing this.
 *
 *   adviseMissing(ns, "gang", ns.getResetInfo())          // prints once, records it for `status`
 *   missingApiAdvice("singularity", info, { plan })       // just the text (pure, for tests)
 */

/** Where the last pass left the list (read by tools/status.js); the "shown" part is what was already printed this run. */
export const ADVICE_FILE = "data/api-advice.json";

/** The BitNodes' names, for the recommendation text. */
export const BITNODE_NAMES = {
	1: "Source Genesis", 2: "Rise of the Underworld", 3: "Corporatocracy", 4: "The Singularity", 5: "Artificial Intelligence",
	6: "Bladeburners", 7: "Bladeburners 2079", 8: "Ghost of Wall Street", 9: "Hacktocracy", 10: "Digital Carbon",
	11: "The Big Crash", 12: "The Recursion", 13: "They're lunatics", 14: "IPvGO Subnet Takeover", 15: "Operation Darknet",
};

/**
 * Everything the scripts can do without, and how each is unlocked.
 *   sources:  the BitNodes whose Source-File gives it (destroying one is the way to get it)
 *   item:     no Source-File needed: bought in the game instead (`buy` says where and what for)
 *   lacks:    what the scripts cannot do without it
 *   fallback: what they do instead
 *   gain:     what each Source-File level adds (shown with the recommendation)
 * @type {Record<string, { label: string, sources?: number[], buy?: string, lacks: string, fallback: string, gain?: string }>}
 */
export const FEATURES = {
	singularity: {
		label: "Singularity API (SF4)", sources: [4],
		lacks: "no automatic backdoors, program or home upgrades, faction and company work, augmentation buying or resets",
		fallback: "The hacking core (batcher, servers, hacknet, stocks, contracts) still runs, and reminders.js tells you when to backdoor and buy; install augmentations yourself",
		gain: "level 1 unlocks it (its RAM costs 16x), level 2 cuts that to 4x, level 3 to 1x",
	},
	multipliers: {
		label: "BitNode multipliers (SF5)", sources: [5],
		lacks: "the scripts can't read what this BitNode does to hacking, hacknet, gangs or Bladeburner, and the route suggestion can't rank BitNodes",
		fallback: "Every multiplier counts as 1, so nothing is skipped as worthless and the plan's listed order decides the next BitNode",
		gain: "level 1 unlocks it and also gives Formulas.exe and the Intelligence stat for good",
	},
	formulas: {
		label: "Formulas.exe", sources: [5],
		buy: "buy it from the darkweb ($5b, needs the TOR router) with `buy Formulas.exe`",
		lacks: "exact batch sizes, timings and costs",
		fallback: "The batcher, hacknet and gang planning estimate from measured numbers with a safety margin, and switch to exact planning by themselves the moment it is on home",
	},
	gang: {
		label: "Gang API (SF2)", sources: [2],
		lacks: "no gang to manage (its income, respect and equipment)",
		fallback: "Crime and the hacking core carry the run",
		gain: "level 1 unlocks it, later levels raise gang multipliers",
	},
	sleeves: {
		label: "Sleeve API (SF10)", sources: [10],
		lacks: "no sleeves to manage (duplicate bodies that train, commit crimes, work for factions and companies and play Bladeburner while you do something else)",
		fallback: "The player does all the work alone",
		gain: "each level adds a sleeve; BitNode 10 itself also sells more sleeves, memory upgrades and sleeve augmentations",
	},
	bladeburner: {
		label: "Bladeburner API (SF6/7)", sources: [6, 7],
		lacks: "no Bladeburner division (ranks, skills, Black Ops as a way to end the BitNode)",
		fallback: "The route stays hacking: Daedalus, The Red Pill, w0r1d_d43m0n",
		gain: "level 1 unlocks it, SF7 level 3 also gives The Blade's Simulacrum",
	},
};

/**
 * The BitNode to destroy to unlock a feature, from the Source-Files owned: among its source BitNodes that you don't own a
 * Source-File of, the one `plan` lists first, else the first listed. null when you own them all.
 * @param {number[]} sources
 * @param {{ currentNode: number, ownedSF: Map<number, number> }} info
 * @param {{ bitNode: number }[]} [plan]
 */
export function pickSource(sources, info, plan = []) {
	const open = sources.filter((node) => !(info.ownedSF.get(node) ?? 0));
	if (!open.length) return null;
	const rank = (node) => {
		const at = plan.findIndex((step) => step.bitNode === node);
		return at < 0 ? 1e6 + sources.indexOf(node) : at;
	};
	return open.reduce((best, node) => (rank(node) < rank(best) ? node : best));
}

/**
 * The advice for one missing feature, or null when it needs none (no such feature). `options.reason` says why the API is
 * unavailable when it isn't just a missing Source-File (a BitNode that disables it): then there is nothing to recommend.
 * `options.plan` is the config's bitnodePlan; `options.have.tor` says whether the TOR router is owned (for things bought in the game).
 * @param {string} id key of FEATURES
 * @param {{ currentNode: number, ownedSF: Map<number, number> }} info
 * @param {{ plan?: { bitNode: number }[], reason?: string, have?: { tor?: boolean } }} [options]
 * @returns {string | null}
 */
export function missingApiAdvice(id, info, options = {}) {
	const feature = FEATURES[id];
	if (!feature) return null;
	const head = `${feature.label} is not available: ${feature.lacks}. ${feature.fallback}.`;
	if (options.reason) return `${head} Why: ${options.reason}.`;
	const source = feature.sources ? pickSource(feature.sources, info, options.plan) : null;
	/** @type {string[]} */
	const actions = [];
	if (feature.buy) actions.push(feature.buy + (options.have?.tor === false ? " (TOR first: Alpha Enterprises in the city)" : ""));
	if (source) {
		const name = BITNODE_NAMES[source] ? ` (${BITNODE_NAMES[source]})` : "";
		const level = (info.ownedSF.get(source) ?? 0) + 1;
		const verb = source === info.currentNode ? "finish this BitNode" : `destroy BitNode ${source}${name}`;
		actions.push(`${feature.buy ? "or " : ""}${verb} for SF${source}.${level}` + (feature.gain ? `; ${feature.gain}` : ""));
	}
	return actions.length ? `${head} Recommendation: ${actions.join(" ")}.` : head;
}

/**
 * Every feature missing in this run, as { id, text } in FEATURES order.
 * @param {{ currentNode: number, ownedSF: Map<number, number> }} info
 * @param {Record<string, boolean | { available: boolean, why?: string }>} have what is available, by id (a feature absent from it is skipped)
 * @param {{ plan?: { bitNode: number }[], tor?: boolean }} [options]
 */
export function missingList(info, have, options = {}) {
	const found = [];
	for (const id of Object.keys(FEATURES)) {
		const state = have[id];
		if (state === undefined) continue;
		const available = typeof state === "boolean" ? state : state.available;
		if (available) continue;
		const reason = typeof state === "boolean" ? undefined : state.why;
		// "needs BitNode 6 or 7..." is the missing Source-File itself; any other reason is the BitNode forbidding it.
		const text = missingApiAdvice(id, info, { plan: options.plan, have: { tor: options.tor }, reason: reason && !/^needs /.test(reason) ? reason : undefined });
		if (text) found.push({ id, text });
	}
	return found;
}

/** What the last pass wrote. */
function readState(ns) {
	try {
		const state = JSON.parse(ns.read(ADVICE_FILE));
		if (state && typeof state === "object") return state;
	} catch { /* no file yet */ }
	return {};
}

/**
 * Prints the advice for `entries` ({ id, text }) once per BitNode run (to the terminal, tagged), remembers what was shown in
 * ADVICE_FILE on this server, and keeps `items` (everything currently missing) for status. Does nothing when
 * `config.missingApiAdvice.enabled` is false. Returns the entries printed now.
 * @param {NS} ns
 * @param {{ id: string, text: string }[]} entries
 * @param {{ lastNodeReset: number }} info
 * @param {any} config loadConfig(ns)
 * @param {{ replace?: boolean }} [options] replace: `entries` is the complete missing list (the tool's pass), else they are added to it
 */
export function adviseOnce(ns, entries, info, config, options = {}) {
	if (config?.missingApiAdvice?.enabled === false) return [];
	const state = readState(ns);
	const sameRun = state.nodeReset === info.lastNodeReset;
	const shown = new Set(sameRun ? state.shown ?? [] : []);
	const items = new Map((sameRun && !options.replace ? state.items ?? [] : []).map((item) => [item.id, item.text]));
	const fresh = [];
	for (const entry of entries) {
		items.set(entry.id, entry.text);
		if (shown.has(entry.id)) continue;
		shown.add(entry.id);
		fresh.push(entry);
		ns.tprint(`WARNING advice: ${entry.text}`);
	}
	ns.write(ADVICE_FILE, JSON.stringify({ nodeReset: info.lastNodeReset, shown: [...shown], items: [...items].map(([id, text]) => ({ id, text })) }), "w");
	return fresh;
}

/**
 * For a manager that is about to exit because its API is missing: one call that builds the advice for `id` and prints it
 * once. 0GB itself; `info` is ns.getResetInfo() and `config` is loadConfig(ns) (both of which the caller normally has).
 * @param {NS} ns
 * @param {string} id key of FEATURES
 * @param {{ currentNode: number, ownedSF: Map<number, number>, lastNodeReset: number }} info
 * @param {any} config
 * @param {string} [reason] why, when it is not just a missing Source-File
 */
export function adviseMissing(ns, id, info, config, reason) {
	if (config?.missingApiAdvice?.enabled === false) return [];
	const text = missingApiAdvice(id, info, { plan: config?.bitnodePlan, reason });
	return text ? adviseOnce(ns, [{ id, text }], info, config) : [];
}

/** One status line for an advice text: "<label>: <recommendation>" (or the whole text when it has no recommendation). */
export function adviceSummary(text) {
	const label = text.split(" is not available")[0];
	const at = text.indexOf("Recommendation: ");
	return `${label}: ${at < 0 ? text.slice(label.length + " is not available: ".length) : text.slice(at + "Recommendation: ".length)}`;
}

/**
 * The guard at the top of a script that cannot do anything without `id`'s API: true when `available`, else it prints why and
 * what to do (every time: you ran this script, so it always answers) and returns false for the caller to return.
 * With `missingApiAdvice.enabled: false` it still says the API is missing but leaves out the recommendation.
 * @param {NS} ns
 * @param {string} id key of FEATURES
 * @param {boolean} available
 * @param {{ currentNode: number, ownedSF: Map<number, number> }} info ns.getResetInfo()
 * @param {any} config loadConfig(ns)
 */
export function requireApi(ns, id, available, info, config) {
	if (available) return true;
	const feature = FEATURES[id];
	const text = config?.missingApiAdvice?.enabled === false ? `${feature?.label ?? id} is not available.` : missingApiAdvice(id, info, { plan: config?.bitnodePlan });
	ns.tprint(`ERROR ${ns.getScriptName()}: ${text} Exiting.`);
	return false;
}
