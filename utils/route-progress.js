// Design: docs/bladeburner.md
// @ts-check
// How far along each way out of the BitNode is, as text for tools/status.js. Pure functions on plain data (0GB), so the
// wording can be tested without the game. The two ways out:
//   hacking      Daedalus' invite (installed augs, cash, hacking level or combat stats), The Red Pill (Daedalus rep, then
//                installed), then the hacking level of w0r1d_d43m0n
//   Bladeburner  every Black Op, the last one (Operation Daedalus) needing rank 400000
// Which one is "active" is the verdict of bladeburner/node-eta.js (`plan.route` on port 36); without a verdict, or without
// the Bladeburner API, the hacking route is shown on its own.

/**
 * @typedef {{ number: (n: number) => string, time: (ms: number) => string, money: (n: number) => string }} Fmt
 * @typedef {{ money: number, installed: number, skills: Record<string, number> }} Have what the player has now
 */

/**
 * Daedalus' invite requirements (getFactionInviteRequirements) as text, each one with what the player has and "ok" once met.
 * Only the kinds Daedalus uses are spelled out.
 * @param {any[]} needs
 * @param {Have} have
 * @param {Fmt} fmt
 */
export function describeNeeds(needs, have, fmt) {
	const tick = (/** @type {boolean} */ ok) => (ok ? " ok" : "");
	const one = (/** @type {any} */ need) => {
		switch (need.type) {
			case "money": return `cash ${fmt.money(have.money)}/${fmt.money(need.money)}${tick(have.money >= need.money)}`;
			case "numAugmentations": return `augs installed ${have.installed}/${need.numAugmentations}${tick(have.installed >= need.numAugmentations)}`;
			case "skills": {
				const entries = Object.entries(need.skills);
				const parts = entries.map(([skill, level]) => `${skill} ${fmt.number(have.skills[skill] ?? 0)}/${fmt.number(Number(level))}`);
				return parts.join(" + ") + tick(entries.every(([skill, level]) => (have.skills[skill] ?? 0) >= Number(level)));
			}
			case "someCondition": return "(" + need.conditions.map(one).join(" or ") + ")";
			case "everyCondition": return need.conditions.map(one).join(" and ");
			default: return String(need.type);
		}
	};
	return needs.map(one).join(", ");
}

/** The number of installed augs the invite asks for, or null when the requirements aren't known. */
export function inviteAugs(needs) {
	const find = (/** @type {any} */ need) => need.type === "numAugmentations" ? need.numAugmentations
		: Array.isArray(need.conditions) ? need.conditions.map(find).find((value) => value !== undefined) : undefined;
	return (Array.isArray(needs) ? needs.map(find).find((value) => value !== undefined) : undefined) ?? null;
}

/**
 * The hacking route as { short, long } segments: Daedalus, The Red Pill, w0r1d_d43m0n. `long` is the full line, `short` the few words
 * the "other route" summary uses.
 * @param {{
 *   hacking: number, installed: number, have: Have, daedalusJoined: boolean, daedalusRep: number, repPerSecond: number,
 *   invite: any[] | null, redPill: { rep: number, price: number } | null, redPillInstalled: boolean, redPillBought: boolean,
 *   daemon: { exists: boolean, level: number | null, root: boolean }
 * }} d
 * @param {Fmt} fmt
 */
export function hackingSegments(d, fmt) {
	const segments = [];
	// 1. Daedalus
	if (d.daedalusJoined || d.redPillInstalled) {
		segments.push({ short: "Daedalus joined", long: `Daedalus joined${d.daedalusJoined ? `, ${fmt.number(d.daedalusRep)} rep` : ""}` });
	} else {
		const augs = inviteAugs(d.invite);
		segments.push({
			short: augs === null ? "Daedalus not joined" : `Daedalus not joined (augs ${d.installed}/${augs})`,
			long: "Daedalus not joined" + (d.invite
				? `: invite needs ${describeNeeds(d.invite, d.have, fmt)}`
				: " (its invite needs aren't known yet; buy-augs.js --plan posts them)"),
		});
	}
	// 2. The Red Pill
	if (d.redPillInstalled) {
		segments.push({ short: "The Red Pill installed", long: "The Red Pill installed" });
	} else if (d.redPillBought) {
		segments.push({ short: "The Red Pill bought", long: "The Red Pill bought, not installed: install augments to make w0r1d_d43m0n appear" });
	} else if (!d.redPill) {
		segments.push({ short: "The Red Pill not owned", long: "The Red Pill not owned" + (d.daedalusJoined ? " (its rep and price aren't known yet; buy-augs.js --plan posts them)" : "") });
	} else if (d.daedalusJoined) {
		const missing = d.redPill.rep - d.daedalusRep;
		const eta = missing <= 0 ? "enough rep, buy it" : d.repPerSecond > 0 ? `ETA ~${fmt.time((missing / d.repPerSecond) * 1000)}` : "no rate yet";
		segments.push({
			short: `The Red Pill rep ${fmt.number(d.daedalusRep)}/${fmt.number(d.redPill.rep)}`,
			long: `The Red Pill not owned: Daedalus rep ${fmt.number(d.daedalusRep)} / ${fmt.number(d.redPill.rep)} (${fmt.money(d.redPill.price)}) | ${eta}`,
		});
	} else {
		segments.push({
			short: "The Red Pill not owned",
			long: `The Red Pill not owned: needs ${fmt.number(d.redPill.rep)} Daedalus rep and ${fmt.money(d.redPill.price)}`,
		});
	}
	// 3. w0r1d_d43m0n
	const level = d.daemon.level;
	if (level === null) {
		segments.push({ short: "w0r1d_d43m0n appears with The Red Pill", long: "w0r1d_d43m0n: its hacking level shows once The Red Pill is installed" });
	} else {
		const gap = level - d.hacking;
		const verdict = gap <= 0 ? "ready" : `${fmt.number(gap)} to go`;
		const root = d.daemon.exists ? ` | root ${d.daemon.root ? "yes" : "no (needs all 5 port openers)"}` : " (it appears once The Red Pill is installed)";
		segments.push({ short: `w0r1d_d43m0n hacking ${fmt.number(d.hacking)}/${fmt.number(level)}`, long: `w0r1d_d43m0n: hacking ${fmt.number(d.hacking)} / ${fmt.number(level)} (${verdict})${root}` });
	}
	return segments;
}

/**
 * The Bladeburner route as { short, long } lines from what bb-pass.js posts (`progress`) and the manager state.
 * @param {{ state: string, progress: any, hold: boolean, ago: (time: number) => string }} d
 * @param {Fmt} fmt
 */
export function bladeburnerSegments(d, fmt) {
	const progress = d.progress;
	if (!progress) {
		const reason = d.state === "off" || !d.state ? "not running yet (bb-manage.js joins once the combat stats are trained)" : `state ${d.state}, no Black Op reading yet`;
		return [{ short: "Bladeburner: no progress yet", long: `Bladeburner: ${reason}` }];
	}
	const note = d.hold ? " | on hold: the best chance is too low to earn rank" : "";
	const age = Date.now() - (progress.time ?? 0) > 15 * 60_000 ? ` (last reading ${d.ago(progress.time)})` : "";
	const next = progress.next;
	const rank = `rank ${fmt.number(Math.floor(progress.rank))}/${fmt.number(progress.finalRank)}`;
	if (!next) {
		return [{ short: `Black Ops ${progress.done}/${progress.total} done`, long: `Black Ops ${progress.done}/${progress.total} done${age}: every one is done, the BitNode can end` }];
	}
	const chance = next.high > next.chance + 0.005
		? `${Math.round(next.chance * 100)}-${Math.round(next.high * 100)}%` : `${Math.round(next.chance * 100)}%`;
	const reach = progress.rank >= next.rank ? "rank ok" : `rank ${fmt.number(Math.floor(progress.rank))}/${fmt.number(next.rank)}`;
	return [
		{
			short: `Black Ops ${progress.done}/${progress.total}, ${rank}`,
			long: `Black Ops ${progress.done}/${progress.total} done${age} | ${rank} for Operation Daedalus (not done)${note}`,
		},
		{ short: "", long: `next: ${next.name} (${reach}, chance ${chance})` },
	];
}

/**
 * The route block under the BitNode line. The active route is spelled out; the other is one line. With no verdict yet both are
 * spelled out. Without Bladeburner (`bladeburner` null) only the hacking route is shown, with no labels.
 * @param {{
 *   route: "hacking" | "combat" | null, routeAgo: string,
 *   hacking: ReturnType<typeof hackingSegments>,
 *   bladeburner: ReturnType<typeof bladeburnerSegments> | null
 * }} d
 * @returns {string[]}
 */
export function routeLines(d) {
	const full = (/** @type {string} */ title, /** @type {{ short: string, long: string }[]} */ segments) => [
		`  ${title}:`, ...segments.map((segment) => `    ${segment.long}`),
	];
	const brief = (/** @type {string} */ title, /** @type {{ short: string, long: string }[]} */ segments) =>
		`  Other route, ${title}: ${segments.map((segment) => segment.short).filter(Boolean).join(" | ")}`;
	if (!d.bladeburner) return d.hacking.map((segment) => `  ${segment.long}`);
	const hackTitle = "Hacking route (Daedalus, The Red Pill, w0r1d_d43m0n)";
	const bladeTitle = "Bladeburner route (every Black Op)";
	if (d.route === "hacking") {
		return [`  Route: hacking${d.routeAgo}`, ...full(hackTitle, d.hacking), brief("Bladeburner", d.bladeburner)];
	}
	if (d.route === "combat") {
		return [`  Route: Bladeburner${d.routeAgo}`, ...full(bladeTitle, d.bladeburner), brief("hacking", d.hacking)];
	}
	return ["  Route: not chosen yet (node-eta.js commits one once Bladeburner has live readings)", ...full(hackTitle, d.hacking), ...full(bladeTitle, d.bladeburner)];
}
