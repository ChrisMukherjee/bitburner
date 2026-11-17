// Design: docs/sleeves.md
// @ts-check
/**
 * Holding BitNode 10 for the Covenant's sleeves. The game sells extra sleeves only inside BitNode 10 (up to 5, for $10t, $100t,
 * $1q, $10q and $100q) and they stay for good, so destroying the BitNode before buying the ones worth waiting for forfeits them
 * until another BitNode 10 run. sleeves/sleeve-shop.js works out whether waiting for the next one is worth it and posts the answer
 * on port 45; singularity/auto-destroy.js, singularity/auto-reset.js and utils/spending.js read it. Everything here is pure or
 * a port read or write, so it costs 0GB. Settings: `sleeves.hold` in the config (`enabled: false` is the kill switch).
 *
 * Worth waiting: the sleeve can be afforded within `runShare` of the time this BitNode run has already taken (live price, cash
 * and measured income). The alternative to waiting is another whole BitNode 10 run, which costs about as long as this one has
 * and meets the same price again, so a wait shorter than that wins.
 */

/** Port the shop posts its decision on (see docs/NETSCRIPT.md). */
export const SLEEVE_HOLD_PORT = 45;
/** A decision older than this is ignored (the shop posts once a minute). */
export const SLEEVE_HOLD_MAX_AGE_MS = 10 * 60_000;
/** The game's limit on sleeves bought from the Covenant, and the price of the first (10 times more for each one after). */
export const MAX_COVENANT_SLEEVES = 5;
const BASE_COST = 10e12;
/** The Covenant's invite asks for this much of every combat skill and of hacking (money and 20 installed augmentations too). */
export const COVENANT_SKILL = 850;

/** The game's price of the next Covenant sleeve after `bought` of them (Infinity once all are bought). Pure. @param {number} bought */
export function covenantSleeveCost(bought) {
	return Number.isInteger(bought) && bought >= 0 && bought < MAX_COVENANT_SLEEVES ? BASE_COST * 10 ** bought : Infinity;
}

/**
 * Whether the player is in The Covenant ("member"), could be invited once the money and augmentations are there ("reachable": hacking and
 * every combat skill at least 850), or not close ("no"). From getPlayer(); a missing field counts as "no". Pure.
 * @param {{ factions?: string[], skills?: any }} player
 * @returns {"member" | "reachable" | "no"}
 */
export function covenantAccess(player) {
	if ((player.factions ?? []).includes("The Covenant")) return "member";
	const skills = player.skills ?? {};
	const reached = ["hacking", "strength", "defense", "dexterity", "agility"].every((name) => (skills[name] ?? 0) >= COVENANT_SKILL);
	return reached ? "reachable" : "no";
}

/**
 * Which of hacking and the four combat skills are under the Covenant's 850, as [{ name, have }] (empty when none is, or when the
 * player lists no skills). Pure. @param {{ skills?: any }} player
 * @returns {{ name: string, have: number }[]}
 */
export function covenantGap(player) {
	const skills = player.skills;
	if (!skills) return [];
	return ["hacking", "strength", "defense", "dexterity", "agility"]
		.map((name) => ({ name, have: Math.floor(skills[name] ?? 0) }))
		.filter((entry) => entry.have < COVENANT_SKILL);
}

/**
 * The decision. `view`: cost (the next sleeve, Infinity when none is for sale), cash, income ($/s, 0 when unknown), runMs (the time
 * this BitNode run has taken), access (covenantAccess), canBuy (BitNode 10). Optional: `missing` (covenantGap: the skills under
 * 850) and `trainingMs` (how long the player has already been asked to train for the Covenant). `rule` is `sleeves.hold`.
 * Returns { hold, train, floor, cost, etaMs, reason }: etaMs is the time to afford it at the current income (0 when already
 * affordable, null when unknown or never). A hold needs: the rule on, a sleeve for sale, a way to the Covenant, and a wait of at
 * most runShare x runMs. `train` asks singularity/player-work.js to train the combat skills to `floor` (the Covenant's 850): set
 * when the invite is out of reach only for want of combat skill (the gym can fix that) and the sleeve is worth the wait. The hold
 * lasts while the training has taken less than the same runShare x runMs, so it cannot stall the route for good, and only when
 * hacking is already there (the gym can't raise it).
 * @param {{ cost: number, cash: number, income: number, runMs: number, access: "member" | "reachable" | "no", canBuy: boolean,
 *   missing?: { name: string, have: number }[], trainingMs?: number }} view
 * @param {{ enabled?: boolean, runShare?: number }} [rule]
 * @returns {{ hold: boolean, train: boolean, floor: number, cost: number | null, etaMs: number | null, reason: string }}
 */
export function sleeveHold(view, rule = {}) {
	const cost = Number.isFinite(view.cost) ? view.cost : null;
	const none = (reason) => ({ hold: false, train: false, floor: COVENANT_SKILL, cost, etaMs: null, reason });
	if (rule.enabled === false) return none("the sleeve hold is switched off (sleeves.hold.enabled)");
	if (!view.canBuy) return none("sleeves are bought only inside BitNode 10");
	if (cost === null) return none("no sleeve left to buy");
	const gap = view.missing ?? [];
	const trainable = gap.filter((entry) => entry.name !== "hacking");
	const lacking = gap.map((entry) => `${entry.name} ${entry.have}`).join(", ");
	if (view.access === "no" && trainable.length === 0) {
		return none(`The Covenant is out of reach${lacking ? ` (${lacking}, it asks for 850)` : ""} (hacking and every combat skill at 850, 20 installed augmentations and $75b get its invite)`);
	}
	const owed = Math.max(0, cost - view.cash);
	const etaMs = owed === 0 ? 0 : view.income > 0 ? (owed / view.income) * 1000 : null;
	if (etaMs === null) return { hold: false, train: false, floor: COVENANT_SKILL, cost, etaMs, reason: "no measured income yet, so the wait can't be estimated" };
	const limit = Math.max(0, view.runMs) * (rule.runShare ?? 1);
	if (etaMs > limit) return { hold: false, train: false, floor: COVENANT_SKILL, cost, etaMs, reason: `the next sleeve (\$${short(cost)}) is ${duration(etaMs)} away, longer than the ${duration(limit)} a new BitNode 10 run would take` };
	if (view.access === "no") {
		const hacking = gap.some((entry) => entry.name === "hacking");
		const trained = Math.max(0, view.trainingMs ?? 0);
		const train = `training ${trainable.map((entry) => `${entry.name} ${entry.have}`).join(", ")} to ${COVENANT_SKILL} for The Covenant's invite (sleeve \$${short(cost)}, ${etaMs === 0 ? "affordable now" : `${duration(etaMs)} of income away`})`;
		if (hacking) return { hold: false, train: true, floor: COVENANT_SKILL, cost, etaMs, reason: `${train}; hacking is under ${COVENANT_SKILL} too, so the BitNode is not held yet` };
		if (trained > limit) return { hold: false, train: true, floor: COVENANT_SKILL, cost, etaMs, reason: `${train}, but that has taken ${duration(trained)}, longer than the ${duration(limit)} a new run would take: not held any longer` };
		return { hold: true, train: true, floor: COVENANT_SKILL, cost, etaMs, reason: train };
	}
	const join = view.access === "member" ? "" : " (joins The Covenant first)";
	return { hold: true, train: false, floor: COVENANT_SKILL, cost, etaMs, reason: etaMs === 0 ? `the next sleeve (\$${short(cost)}) is affordable now${join}` : `the next sleeve (\$${short(cost)}) is ${duration(etaMs)} away at the current income${join}` };
}

/**
 * Cash to keep for the sleeve: its whole price once the cash on hand has reached `progress` of it (more than half-way by default,
 * so what a reset or another purchase would throw away outweighs what it could earn back), else 0: until then investing in income
 * shortens the wait. Pure. @param {{ hold: boolean, cost: number | null, progress?: number } | null} decision
 * @param {number} cash @param {{ progress?: number }} [rule]
 */
export function sleeveSaving(decision, cash, rule = {}) {
	if (!decision?.hold || !decision.cost) return 0;
	return cash >= decision.cost * (rule.progress ?? decision.progress ?? 0.5) ? decision.cost : 0;
}

/** Posts the decision (JSON, so Infinity-free). */
export function postSleeveHold(ns, decision) {
	ns.clearPort(SLEEVE_HOLD_PORT);
	ns.writePort(SLEEVE_HOLD_PORT, JSON.stringify({ time: Date.now(), ...decision }));
}

/** The shop's last decision, or null when none is recent enough (or none was posted). */
export function readSleeveHold(ns, now = Date.now(), maxAgeMs = SLEEVE_HOLD_MAX_AGE_MS) {
	try {
		const posted = JSON.parse(ns.peek(SLEEVE_HOLD_PORT));
		if (!posted || typeof posted.time !== "number" || now - posted.time > maxAgeMs) return null;
		return posted;
	} catch {
		return null; // "NULL PORT DATA"
	}
}

function short(value) {
	/** @type {[number, string][]} */
	const units = [[1e18, "qt"], [1e15, "q"], [1e12, "t"], [1e9, "b"], [1e6, "m"]];
	for (const [size, unit] of units) if (value >= size) return `${+(value / size).toFixed(2)}${unit}`;
	return String(Math.round(value));
}

function duration(ms) {
	const minutes = ms / 60_000;
	if (minutes < 90) return `${Math.max(1, Math.round(minutes))} min`;
	const hours = minutes / 60;
	return hours < 48 ? `${hours.toFixed(1)} h` : `${(hours / 24).toFixed(1)} days`;
}

/**
 * Why the BitNode should stay open for a sleeve, or "" when it needn't: the shop's recent decision says hold and the kill switch
 * (`sleeves.hold.enabled`) is not off. For singularity/auto-destroy.js. @param {{ enabled?: boolean } | undefined} rule
 */
export function sleeveHoldReason(ns, rule, now = Date.now()) {
	if (rule?.enabled === false) return "";
	const decision = readSleeveHold(ns, now);
	return decision?.hold ? `holding BitNode 10 for a Covenant sleeve: ${decision.reason}` : "";
}

/**
 * Why a reset should wait, or "" when it needn't: the shop says the next sleeve is worth holding for and the cash on hand has
 * reached `progress` of its price, which an install would wipe (singularity/install-augs.js spends the cash on the sleeve first
 * when it is affordable, so only a reset short of the price loses it). For singularity/auto-reset.js, which never asks for the
 * reset that installs The Red Pill: without it the BitNode can't end. @param {{ enabled?: boolean, progress?: number } | undefined} rule
 */
export function sleeveHoldsReset(ns, rule, cash, now = Date.now()) {
	if (rule?.enabled === false) return "";
	const decision = readSleeveHold(ns, now);
	if (!decision || sleeveSaving(decision, cash, rule) === 0) return "";
	if (cash >= (decision.cost ?? Infinity)) return ""; // affordable: the install buys it first
	return `saving for a Covenant sleeve ($${short(cash)} of $${short(decision.cost ?? 0)}): ${decision.reason}`;
}

/**
 * The combat level the player should train to now for The Covenant's invite, or 0: the shop's recent decision says train and the
 * kill switch (`sleeves.hold.enabled`) is not off. For singularity/player-work.js. @param {{ enabled?: boolean } | undefined} rule
 */
export function sleeveTrainFloor(ns, rule, now = Date.now()) {
	if (rule?.enabled === false) return 0;
	const decision = readSleeveHold(ns, now);
	return decision?.train ? Number(decision.floor) || COVENANT_SKILL : 0;
}
