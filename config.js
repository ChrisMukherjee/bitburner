/**
 * Choices that depend on where you are in the game: which augments are worth buying, which
 * factions to work for, when to reset, how freely to spend, where to go after this BitNode.
 * The defaults suit a hacking run (for example BitNode 4 with no gang yet). Plain data, 0GB.
 *
 * Change them without editing this file: create data/config.json in the game
 * (`nano data/config.json`) with only what you want different. It lives in the game alone
 * (git and bitburner-filesync never touch it), so each player keeps their own. Objects are
 * merged key by key; lists and single values replace the default. For example:
 *
 *   {
 *     "augments": { "wantStats": ["hacking", "rep", "hacknet", "darknet", "combat", "crime"] },
 *     "bitnodeRoute": [{ "bitNode": 4, "level": 3 }, { "bitNode": 5, "level": 1 }]
 *   }
 *
 * "profile" picks one of PRESETS below first; data/config.json is applied on top of it.
 * Scripts read the settings when they start, so restart a script after changing them.
 * utils/config.js does the loading; `run /tools/show-config.js` prints the result.
 */

// Augment stats in groups, for augments.wantStats. The labels show up in `augs` (buy-augs --dry).
// A stat counts when the augment raises it (multiplier above 1), or lowers it for LOWER_IS_BETTER.
export const STAT_GROUPS = {
	"hacking": {
		hacking: "hack", hacking_exp: "hack exp", hacking_chance: "hack chance", hacking_speed: "hack speed",
		hacking_money: "hack money", hacking_grow: "grow",
	},
	"rep": { faction_rep: "faction rep", company_rep: "company rep" },
	"hacknet": {
		hacknet_node_money: "hacknet money", hacknet_node_purchase_cost: "hacknet node cost",
		hacknet_node_ram_cost: "hacknet RAM cost", hacknet_node_core_cost: "hacknet core cost",
		hacknet_node_level_cost: "hacknet level cost",
	},
	"darknet": { dnet_money: "darknet money" },
	"combat": {
		strength: "str", strength_exp: "str exp", defense: "def", defense_exp: "def exp",
		dexterity: "dex", dexterity_exp: "dex exp", agility: "agi", agility_exp: "agi exp",
	},
	"charisma": { charisma: "cha", charisma_exp: "cha exp" },
	"work": { work_money: "work money" },
	"crime": { crime_money: "crime money", crime_success: "crime success" },
	"bladeburner": {
		bladeburner_max_stamina: "bb max stamina", bladeburner_stamina_gain: "bb stamina gain",
		bladeburner_analysis: "bb analysis", bladeburner_success_chance: "bb success",
	},
};
export const LOWER_IS_BETTER = [
	"hacknet_node_purchase_cost", "hacknet_node_ram_cost", "hacknet_node_core_cost", "hacknet_node_level_cost",
];

export const DEFAULTS = {
	profile: "hacking",

	augments: {
		// Stat groups (STAT_GROUPS above) that make an augment worth buying. Used by buy-augs.js,
		// and through it by player-work.js (rep goals via workers/faction-goals.js, cities via workers/city-plan.js).
		wantStats: ["hacking", "rep", "hacknet", "darknet"],
		// Always worth buying, whatever they boost, with the reason shown in `augs`.
		special: {
			"The Red Pill": "lets you destroy the BitNode",
			"Neuroreceptor Manager": "no penalty for unfocused work",
			"CashRoot Starter Kit": "$1m and BruteSSH.exe after every reset",
		},
		// Never worth buying, even if they boost a wanted stat.
		never: [],
		// Spend what's left on NeuroFlux Governor after the rest (buy-augs --no-neuroflux turns it off once).
		neuroflux: true,
		// When to reset (buy-augs --dry / --plan, auto-reset.js, install-augs.js).
		resetRule: {
			keyAugs: ["The Red Pill", "Neuroreceptor Manager"], // reset as soon as one of these is ready
			minAugs: 5,           // a normal reset: at least this many useful augments ready...
			soonMinutes: 30,      // ...unless another one you could afford unlocks within this long (then wait for it)
			maxWaitMinutes: 60,   // ...but once a batch is ready, wait at most this long IN TOTAL for more
			plentyAugs: 10,       // ...and with this many ready, don't wait for anything
			stallMinAugs: 2,      // a smaller reset is fine when progress has stalled: this many ready,
			minRunHours: 3,       //   the run is at least this old,
			stallHours: 4,        //   and either nothing you could afford unlocks within this long
			maxSmallWaitHours: 3, //   or you've already waited this long for the batch to grow
			minRateGapMs: 120_000, // rep rates need two snapshots at least 2 minutes apart
			maxRateGapMs: 3 * 3600_000,
		},
	},

	// Studying (player-work.js). Below hackLevel, the player studies and nothing else takes over.
	studying: {
		hackLevel: 75,
		city: "Sector-12",
		university: "Rothman University",
		course: "Computer Science", // the free course
	},

	// Factions player-work.js works for, in order. Each one's rep goal comes from the augments
	// still worth buying there. An augment sold by several counts for the first joined one.
	factionWork: {
		order: [
			"Daedalus",            // The Red Pill: needed to finish the BitNode
			"CyberSec",
			"Netburners",
			"Tian Di Hui",         // Neuroreceptor Manager (no unfocused penalty)
			"NiteSec",
			"The Black Hand",
			"BitRunners",
			// Megacorps: invites need company rep from a job there (companyWork below).
			"Bachman & Associates",
			"Clarke Incorporated",
			"Blade Industries",
			"OmniTek Incorporated",
			"NWO",
			"ECorp",
			"Fulcrum Secret Technologies",
			// City factions last, and only once joined (player-work.js decides which, see `cities`).
			"Sector-12", "Aevum", "Chongqing", "New Tokyo", "Ishima", "Volhaven",
		],
		workType: "hacking", // "hacking", "field" or "security"
	},

	// Megacorp jobs (player-work.js, when no faction needs rep) that lead to faction invites, in order.
	companyWork: {
		companies: [
			{ company: "Bachman & Associates", faction: "Bachman & Associates" },
			{ company: "Clarke Incorporated", faction: "Clarke Incorporated" },
			{ company: "Blade Industries", faction: "Blade Industries" },
			{ company: "OmniTek Incorporated", faction: "OmniTek Incorporated" },
			{ company: "NWO", faction: "NWO" },
			{ company: "ECorp", faction: "ECorp" },
			{ company: "Fulcrum Technologies", faction: "Fulcrum Secret Technologies" },
		],
		field: "Software", // promotions here depend on hacking (and charisma)
		repNeeded: 400_000,
	},

	// City factions (player-work.js): rival groups, tried in this order, one group per run.
	// A group is only joined if one of its factions sells a wanted augment that no faction in
	// otherSources sells (those are joined anyway).
	cities: {
		groups: [
			["Sector-12", "Aevum"],
			["Chongqing", "New Tokyo", "Ishima"],
			["Volhaven"],
		],
		otherSources: ["CyberSec", "Tian Di Hui", "NiteSec", "The Black Hand", "BitRunners", "Netburners", "Daedalus"],
	},

	// Spending stages for hacknet-manager.js, pserv-manager.js and stock-trader.js. A stage
	// applies once script income reaches minIncome ($/s) and never loosens until restart.
	//   reserve           - cash the manager never touches
	//   maxFraction       - largest share of current cash spent in one pass (hacknet, stocks)
	//                       or on one purchase (servers)
	//   maxPaybackSeconds - hacknet only: buy if cost / extra $ per second is below this; 0 = off.
	//                       Short by default, since home RAM, servers and augs pay off better
	//                       in most BitNodes. Raise it where hacknet is strong.
	//   minShareOfIncome  - hacknet only: stop once hacknet makes less than this share of income; 0 = off
	hacknetBuying: [
		{ name: "early", minIncome: 0, reserve: 1e6, maxFraction: 0.50, maxPaybackSeconds: 30 * 60, minShareOfIncome: 0 },
		{ name: "growing", minIncome: 1e5, reserve: 30e6, maxFraction: 0.25, maxPaybackSeconds: 15 * 60, minShareOfIncome: 0.01 },
		{ name: "established", minIncome: 1e7, reserve: 300e6, maxFraction: 0.10, maxPaybackSeconds: 5 * 60, minShareOfIncome: 0.01 },
		{ name: "late", minIncome: 1e8, reserve: 1e9, maxFraction: 0.02, maxPaybackSeconds: 0, minShareOfIncome: 0.01 },
	],
	serverBuying: [
		{ name: "early", minIncome: 0, reserve: 1e6, maxFraction: 0.75 },
		{ name: "growing", minIncome: 1e5, reserve: 30e6, maxFraction: 0.50 },
		{ name: "established", minIncome: 1e7, reserve: 300e6, maxFraction: 0.40 },
		{ name: "late", minIncome: 1e8, reserve: 1e9, maxFraction: 0.25 },
	],
	stockTrading: [
		{ name: "early", minIncome: 0, reserve: 5e6, maxFraction: 0.9 },
		{ name: "growing", minIncome: 1e5, reserve: 50e6, maxFraction: 0.9 },
		{ name: "established", minIncome: 1e7, reserve: 500e6, maxFraction: 0.9 },
		{ name: "late", minIncome: 1e8, reserve: 2e9, maxFraction: 0.9 },
	],

	// startup.js: home RAM (GB) at which "auto" picks each stage, and scripts it never starts
	// (paths as in its list, e.g. "darknet/dnet-manager.js").
	startupStages: { start: 0, early: 64, mid: 128, late: 256 },
	startupSkip: [],

	// Gang (gang/gang-manager.js; BitNode 2, or anywhere with Source-File 2). Untested in game so far.
	gang: {
		// Factions to create the gang with, in order: the first one you're a member of is used, and
		// that decides the gang type for good. Slum Snakes and the others here make a COMBAT gang
		// (best money, Human Trafficking, and the strongest territory power); the invite needs combat
		// 30 and karma -9, which player-work.js gets with crimes in BitNode 2 (gang.factions[0]).
		// For a HACKING gang use ["NiteSec", "The Black Hand"]: no crimes needed (your hacking already
		// gets the NiteSec invite), but less money and weaker in territory clashes.
		factions: ["Slum Snakes", "Tetrads", "The Syndicate", "Speakers for the Dead", "The Dark Army"],
		inviteCrimes: ["Mug", "Homicide"], // player-work.js picks the one losing karma fastest
		trainLevel: 200,            // members train until their main stat (combat average, or hacking) reaches this
		trainTasks: { combat: "Train Combat", hacking: "Train Hacking" },
		focus: "auto",              // "respect", "money", or "auto": respect until the gang is full (12), then money
		ascendAt: 1.5,              // ascend once the main-stat multiplier would grow this much
		ascendMaxRespectShare: 0.25, // ...unless that member holds more than this share of the gang's respect
		maxWantedPenalty: 0.05,     // above this wanted penalty, weakest earners switch to a cool task...
		okWantedPenalty: 0.01,      // ...until it is back below this
		coolTasks: ["Vigilante Justice", "Ethical Hacking"],
		warfareTask: "Territory Warfare",
		warfareShare: 0.5,          // with a full gang and territory left: this share of trained members builds power
		engageAt: 0.55,             // clashes on once the win chance against every gang holding territory is this high
		disengageAt: 0.5,           // ...and off again below this
		buyAugmentations: true,     // gang member augments (permanent through ascension) first, then equipment
		planMs: 20_000,             // re-plan tasks and ascensions this often
		buyMs: 60_000,              // equipment pass this often
		// Spending stages for equipment, as for hacknetBuying (reserve, maxFraction of cash per pass).
		buying: [
			{ name: "early", minIncome: 0, reserve: 5e6, maxFraction: 0.10 },
			{ name: "growing", minIncome: 1e5, reserve: 50e6, maxFraction: 0.10 },
			{ name: "established", minIncome: 1e7, reserve: 500e6, maxFraction: 0.10 },
			{ name: "late", minIncome: 1e8, reserve: 2e9, maxFraction: 0.05 },
		],
	},

	// Where auto-destroy.js goes after w0r1d_d43m0n: the first entry whose Source-File level
	// isn't reached yet (counting the level this destroy gives). When all are done it waits for you.
	bitnodeRoute: [
		{ bitNode: 4, level: 3 },
	],
};

// Named sets of overrides, applied over DEFAULTS before data/config.json. Pick one with
// "profile" in data/config.json. Add your own; only list what differs from DEFAULTS.
export const PRESETS = {
	"hacking": {},
};
