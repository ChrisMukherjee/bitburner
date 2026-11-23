// Design: docs/player-work.md
// @ts-check
// Which kind of faction work (hacking, field or security) earns the most reputation, among the kinds a faction offers.
// Pure and 0GB. The game's rules (bitburner-src v3.0.1): which factions offer which work is Faction/FactionInfo.tsx
// (offerHackingWork, offerFieldWork, offerSecurityWork); the rep per cycle is PersonObjects/formulas/reputation.ts.

export const WORK_TYPES = /** @type {const} */ (["hacking", "field", "security"]);

/** Work each faction offers (FactionInfo.tsx). Factions missing here (none offer work) can't be worked for. */
export const FACTION_WORK = {
	"Illuminati": ["hacking", "field"],
	"Daedalus": ["hacking", "field"],
	"The Covenant": ["hacking", "field"],
	"ECorp": ["hacking", "field", "security"],
	"MegaCorp": ["hacking", "field", "security"],
	"Bachman & Associates": ["hacking", "field", "security"],
	"Blade Industries": ["hacking", "field", "security"],
	"NWO": ["hacking", "field", "security"],
	"Clarke Incorporated": ["hacking", "field", "security"],
	"OmniTek Incorporated": ["hacking", "field", "security"],
	"Four Sigma": ["hacking", "field", "security"],
	"KuaiGong International": ["hacking", "field", "security"],
	"Fulcrum Secret Technologies": ["hacking", "security"],
	"BitRunners": ["hacking"],
	"The Black Hand": ["hacking", "field"],
	"NiteSec": ["hacking"],
	"CyberSec": ["hacking"],
	"Aevum": ["hacking", "field", "security"],
	"Chongqing": ["hacking", "field", "security"],
	"Ishima": ["hacking", "field", "security"],
	"New Tokyo": ["hacking", "field", "security"],
	"Sector-12": ["hacking", "field", "security"],
	"Volhaven": ["hacking", "field", "security"],
	"Speakers for the Dead": ["hacking", "field", "security"],
	"The Dark Army": ["hacking", "field"],
	"The Syndicate": ["hacking", "field", "security"],
	"Silhouette": ["hacking", "field"],
	"Tetrads": ["field", "security"],
	"Slum Snakes": ["field", "security"],
	"Netburners": ["hacking"],
	"Tian Di Hui": ["hacking", "security"],
	"Bladeburners": [],
	"Church of the Machine God": [],
	"Shadows of Anarchy": [],
};

/**
 * Reputation per cycle of each work type, leaving out the factors all three share (the faction's favor, the rep
 * multiplier, the BitNode's work multiplier, the Intelligence bonus), so only the ratios mean anything.
 * reputation.ts: hacking (hack + int/3) x share; security 0.9 (str+def+dex+agi + (hack+int) x share) / 4.5;
 * field 0.9 (str+def+dex+agi+cha + (hack+int) x share) / 5.5; with Source-File 15 at level 3 charisma adds a little to each.
 * @param {{ skills: { hacking: number, strength: number, defense: number, dexterity: number, agility: number, charisma: number, intelligence?: number } }} person
 * @param {{ sharePower?: number, sf15?: number }} [options] sharePower: the share power (ns.getSharePower(), 1 when unknown); sf15: Source-File 15 level
 * @returns {Record<"hacking"|"field"|"security", number>}
 */
export function workTypeRates(person, options = {}) {
	const { sharePower = 1, sf15 = 0 } = options;
	const s = person.skills;
	const int = s.intelligence ?? 0;
	const cha = sf15 >= 3 ? s.charisma : 0;
	const combat = s.strength + s.defense + s.dexterity + s.agility;
	return {
		hacking: (s.hacking + int / 3 + cha * 0.1) * sharePower,
		security: (0.9 * (combat + cha * 0.3 + (s.hacking + int) * sharePower)) / 4.5,
		field: (0.9 * (combat + s.charisma + (s.hacking + int + cha * 0.3) * sharePower)) / 5.5,
	};
}

/**
 * The work types to try for a faction, best first: only the ones it offers (all three for a faction this table doesn't
 * know), ordered by reputation rate when `setting` is "auto" (or anything that isn't a work type), or the configured type
 * first when it is one the faction offers. Without a person the order is hacking, field, security.
 * @param {string} faction
 * @param {string} [setting] factionWork.workType: "auto", "hacking", "field" or "security"
 * @param {Parameters<typeof workTypeRates>[0]} [person]
 * @param {Parameters<typeof workTypeRates>[1]} [options]
 * @returns {string[]}
 */
export function factionWorkOrder(faction, setting = "auto", person, options) {
	const offered = FACTION_WORK[faction] ?? [...WORK_TYPES];
	let order = [...offered];
	if (person) {
		const rates = workTypeRates(person, options);
		order.sort((a, b) => rates[b] - rates[a]);
	}
	if (offered.includes(setting)) order = [setting, ...order.filter((type) => type !== setting)];
	return order;
}

/**
 * The factions to set rep goals for, in priority order: the configured order, then every other joined faction that offers
 * work (crime factions joined for their augments, Silhouette, The Covenant, Illuminati, megacorps not listed), in the order
 * joined. Those extra ones are only there while joined, so nothing ever waits for their invites.
 * @param {string[]} order factionWork.order
 * @param {string[]} joined the player's factions
 * @returns {string[]}
 */
export function goalFactions(order, joined) {
	const extra = joined.filter((faction) => !order.includes(faction) && (FACTION_WORK[faction]?.length ?? WORK_TYPES.length) > 0);
	return [...order, ...extra];
}
