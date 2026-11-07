// Design: docs/config.md
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
		// and through it by player-work.js (rep goals via singularity/workers/faction-goals.js, cities via singularity/workers/city-plan.js).
		wantStats: ["hacking", "rep", "hacknet", "darknet"],
		// Always worth buying, whatever they boost, with the reason shown in `augs`.
		special: {
			"The Red Pill": "lets you destroy the BitNode",
			"Neuroreceptor Management Implant": "no penalty for unfocused work",
			"CashRoot Starter Kit": "$1m and BruteSSH.exe after every reset",
		},
		// Never worth buying, even if they boost a wanted stat.
		never: [],
		// Money stats count by where this run's money comes from (docs/aug-reset.md, "Income mix"). Each stat listed
		// under a source below has its resetRule weight multiplied by that source's portion of the money earned
		// (game's getMoneySources, posted by buy-augs.js on port 38), and stops being worth buying below minPortion.
		// Keys are getMoneySources names. A gang, stocks and the rest raise no augment stat (gang members don't
		// use your augments), so the more they earn, the less every money augment counts. Stats not listed
		// (hacking level, exp, speed, rep, combat) keep their full weight: they help whatever pays.
		incomeMix: {
			enabled: true,
			stats: {
				"hacking": ["hacking_money", "hacking_grow"],
				"hacknet": ["hacknet_node_money", "hacknet_node_purchase_cost", "hacknet_node_ram_cost", "hacknet_node_core_cost", "hacknet_node_level_cost"],
				"darknet": ["dnet_money"],
				"crime": ["crime_money", "crime_success"], // only if "crime" is in wantStats
				"work": ["work_money"],                    // only if "work" is in wantStats
			},
			minPortion: 0.05,          // a money stat whose sources earn less than 5% doesn't make an augment worth buying
			minEarned: 1e8,            // below this much earned this run, the whole BitNode's mix is used
			unknownPortions: { "hacking": 1 }, // before anything is posted: a hacking run
			maxAgeMinutes: 30,         // an older post counts as missing (auto-reset.js reposts every 10 minutes)
		},
		// Spend what's left on NeuroFlux Governor after the rest (buy-augs --no-neuroflux turns it off once).
		neuroflux: true,
		// When to reset (buy-augs --dry / --plan, auto-reset.js, install-augs.js). The rule: reset at
		// the moment that gives the most augment value per hour of the run (docs/aug-reset.md).
		resetRule: {
			keyAugs: ["The Red Pill"], // reset as soon as one of these is ready
			// Value of an augment = sum of weight x ln(multiplier) over its wanted stats. For the money stats in
			// incomeMix.stats this is the weight when that source earns all the money; it is multiplied by the
			// source's real portion (so hacknet counts in full only when hacknet pays for everything).
			weights: {
				hacking: 1, hacking_money: 1, hacking_speed: 1, faction_rep: 1,
				hacking_exp: 0.5, hacking_chance: 0.5, hacking_grow: 0.5,
				company_rep: 0.25,
				hacknet_node_money: 1, dnet_money: 1,
				hacknet_node_purchase_cost: 0.5, hacknet_node_ram_cost: 0.5, hacknet_node_core_cost: 0.5, hacknet_node_level_cost: 0.5,
				crime_money: 1, crime_success: 0.5, work_money: 1,
			},
			defaultWeight: 0.2,   // stats not listed above (e.g. combat, if added to wantStats)
			// Favor counts as a rep multiplier at that faction, times this (it only speeds up the
			// rep-limited part of the next run).
			favorWeight: 0.5,
			// Value of augments without useful stats (The Red Pill is in keyAugs instead).
			specialValue: { "Neuroreceptor Management Implant": 0.25, "CashRoot Starter Kit": 0.05 },
			overheadMinutes: 5,   // fixed cost of one reset, added to the run age
			minRunMinutes: 30,    // never reset a run younger than this
			waitMargin: 0.05,     // wait only if a later moment beats now by more than 5% per hour
			horizonHours: 6,      // how far ahead the forecast looks
			// Only moments this close count as a better "later", so a forecast that keeps promising a
			// little more a bit further on can't postpone the reset for ever (null: the whole horizon).
			// 180, not 60: in the offline simulation a 60 min window and the 4h guarantee cut runs short
			// and cost 5-25% of the time to The Red Pill (docs/aug-reset.md).
			maxWaitMinutes: 180,
			// Guarantee: a run this old resets once the batch is worth at least x guaranteeSpeed,
			// whatever the forecast says (null turns it off).
			maxRunHours: null,
			guaranteeSpeed: 1.5,
			daedalusFavor: true,  // Daedalus rule: reset for 150 favor (donations) when that beats working for The Red Pill
			// Daedalus push: once the invite only lacks installed augments (hack level and money met), buy the
			// cheapest augments, useful or not, and reset as soon as they cover the count. NeuroFlux levels
			// count as one augment, so leftover cash on NeuroFlux doesn't help. daedalusPushSpare: extra ones
			// in case a purchase fails (prerequisites).
			daedalusPush: true,
			daedalusPushSpare: 2,
			// After The Red Pill is installed, reset only if the batch gets hacking to w0r1d_d43m0n's level
			// sooner than keeping on. rebuildFactor: a new run's exp rate as a share of today's (it starts slower).
			afterRedPill: { rebuildFactor: 0.5 },
			// Income curve (utils/income-curve.js): forecast cash with income that keeps growing
			// the way it has this run, instead of flat. Also used by faction-goals' money budget.
			incomeCurve: {
				enabled: true,
				sampleMinutes: 5,      // one income sample per this many minutes of run
				fitHours: 2,           // fit growth on this much recent history
				minSamples: 3,         // samples needed before this run's own fit is used
				minSpanMinutes: 20,    // ...spread over at least this long
				dampHours: 1.5,        // growth halves every this many hours ahead
				maxGrowthPerHour: 1.4, // ln per hour (about 4x/h): ignore anything steeper
				maxMult: 4,            // forecast income never above this many times today's
			},
			minRateGapMs: 120_000, // rep rates need two snapshots at least 2 minutes apart
			maxRateGapMs: 3 * 3600_000,
		},
	},

	// Focus for the player's work (player-work.js): "auto" = focused until the Neuroreceptor
	// Management Implant is installed, then unfocused; true = always focused; false = never.
	// The --focus / --no-focus flags win over this.
	playerFocus: "auto",

	// Studying (player-work.js). Below hackLevel, the player studies and nothing else takes over.
	studying: {
		hackLevel: 75,
		city: "Sector-12",
		university: "Rothman University",
		course: "Computer Science", // the free course
	},

	// Start stage only (player-work-start.js): create a port opener yourself when your hacking level allows it
	// and it would take no more than maxMinutes (the darkweb price needs cash the batcher hasn't made yet).
	createPrograms: { maxMinutes: 30 },

	// Factions player-work.js works for, in order. Each one's rep goal comes from the augments
	// still worth buying there. An augment sold by several counts for the first joined one.
	factionWork: {
		order: [
			"Daedalus",            // The Red Pill: needed to finish the BitNode
			"CyberSec",
			"Netburners",
			"Tian Di Hui",         // Neuroreceptor Management Implant (no unfocused penalty)
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

	// Spending stages for hacknet-manager.js, pserv-manager.js, stock-trader.js and the home
	// upgrades (singularity/upgrade-home-ram.js, upgrade-home-cores.js). A stage
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
	// Home RAM and core upgrades (singularity/upgrade-home-ram.js, upgrade-home-cores.js): buy while the
	// cash left afterwards still covers reserveSeconds of income, so the batcher, servers and augments
	// aren't starved. RAM is the best early buy (every other manager runs on it) and keeps 2 minutes;
	// cores only speed up grow/weaken on home and pay back slower, so they keep 5. Until there is an
	// income reading (the start of a run) at most fallbackFraction of the cash is spent per upgrade.
	homeUpgrades: {
		ram: { reserveSeconds: 120, fallbackFraction: 0.5 },
		cores: { reserveSeconds: 300, fallbackFraction: 0.25 },
	},

	// startup.js: home RAM (GB) at which "auto" picks each stage, and scripts it never starts
	// (paths as in its list, e.g. "darknet/dnet-manager.js").
	startupStages: { start: 0, early: 64, mid: 128, late: 256 },
	startupSkip: [],

	// Gang (gang/gang-manager.js; BitNode 2, or anywhere with Source-File 2). Untested in game so far.
	gang: {
		// Factions to create the gang with, in order: the first one you're a member of is used, and
		// that decides the gang type for good. Slum Snakes and the others here make a COMBAT gang
		// (best money, Human Trafficking, and the strongest territory power); the invite needs combat
		// 30, karma -9 and $1m, which player-work.js gets in BitNode 2 (gang.factions[0]): Homicide for
		// the karma, then the gym for the stats.
		// For a HACKING gang use ["NiteSec", "The Black Hand"]: no crimes needed (your hacking already
		// gets the NiteSec invite), but less money and weaker in territory clashes.
		factions: ["Slum Snakes", "Tetrads", "The Syndicate", "Speakers for the Dead", "The Dark Army"],
		// Crimes player-work.js may commit for the gang (invite needs, and karma -54,000 outside BitNode 2):
		// the one with the most expected karma per minute at your success chance (a failure still gives a
		// quarter), re-picked every 2 minutes. That is Homicide at any chance. null = every crime in the game,
		// or a list of names, e.g. ["Mug", "Homicide"].
		inviteCrimes: null,
		inviteGym: true,            // once karma is met, missing combat stats go to the gym (much faster); false = crimes
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

	// Bladeburner (bladeburner/). route: "combat" plays Bladeburner (gym, then actions) and leaves the player to it;
	// "hacking" holds it so faction and company work get all the player's time. A route estimate posted on
	// port 36 (plan.route) wins over this. Black Ops done = the BitNode can end without w0r1d_d43m0n.
	bladeburner: { route: "combat" },

	// XP farm (hack/xp-farm.js): weakens a cheap target with RAM the batcher leaves free, for hacking XP.
	// target: any rooted server you can hack; headroom: share of the network's RAM always left free for the batcher.
	xpFarm: { target: "joesguns", headroom: 0.15 },

	// Where auto-destroy.js goes after w0r1d_d43m0n: the first entry whose Source-File level
	// isn't reached yet (counting the level this destroy gives). When all are done it waits for you.
	bitnodeRoute: [
		{ bitNode: 4, level: 3 },
		{ bitNode: 2, level: 1 }, // gangs (gang/gang-manager.js)
		{ bitNode: 5, level: 1 }, // Intelligence, plus a hacking boost
	],

	// Per-BitNode overrides, keyed by BitNode number: laid over the settings above only while
	// in that BitNode (startup.js records which one). Same merge rules as data/config.json, which
	// (like a preset) can have its own `bitnodes` section. This is where BitNode tuning goes,
	// never `if (bitNode === N)` in a script. For example:
	//   "2": { augments: { wantStats: ["hacking", "rep", "combat", "crime"] } },
	bitnodes: {},
};

// Named sets of overrides, applied over DEFAULTS (and its `bitnodes` entry) before data/config.json. Pick one with
// "profile" in data/config.json. Add your own; only list what differs from DEFAULTS.
export const PRESETS = {
	"hacking": {},
	// Bladeburner as the way out of a BitNode: rank comes from Contracts/Operations, whose success
	// depends on combat stats, so combat and Bladeburner augments count and hacking ones don't
	// (they'd be lost at the next reset for nothing). Pick with "profile": "bladeburner".
	"bladeburner": {
		augments: {
			wantStats: ["rep", "hacknet", "darknet", "combat", "bladeburner"],
			resetRule: {
				weights: {
					strength: 1, defense: 1, dexterity: 1, agility: 1,
					strength_exp: 0.5, defense_exp: 0.5, dexterity_exp: 0.5, agility_exp: 0.5,
					bladeburner_success_chance: 1, bladeburner_max_stamina: 1, bladeburner_stamina_gain: 1, bladeburner_analysis: 1,
				},
			},
		},
	},
};
