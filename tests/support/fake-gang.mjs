// A small gang simulator for running gang/gang-manager.js's main loop for simulated hours, the way the game runs it:
// ns.gang.nextUpdate resolves once per gang update (2 seconds of game time, 10 cycles; more with bonus time).
//
//   const sim = gangSim({ members: 6, respect: 1e3 });
//   await sim.run(main, 2 * HOUR);
//   sim.recruits, sim.ascensions, sim.purchases, sim.engaged, sim.updates   // what happened, in order
//
// Each update follows the game (v3.0.0 src/Gang/Gang.ts and GangMember.ts) through gang/formulas.js: respect, money
// and wanted per member and task, experience, the recruit threshold (3 free, then 5^n, Infinity at 12), ascension
// (experience banked as points, gear dropped, augmentations kept, the member's respect taken away), the wanted level's
// floor of 1 and the justice discount, power from Territory Warfare members every 100 cycles, and clashes against the
// other gangs (win chance by power, land moved by clashGain's rule) while clashes are engaged.
// other gangs' power gains (half the time +0.5% capped at 0.85, else 0.75 x roll x land x their multiplier), and deaths
// in clashes (only Territory Warfare members, less likely with defense).
// Simplifications: a seeded random number instead of Math.random, a short equipment list with approximate stats, and
// only the combat tasks.
import { fakeWorld } from "./fake-world.mjs";
import { STAT_NAMES, CYCLES_PER_SECOND, skillLevel, ascensionMult, ascensionPoints, expRate, respectRate, moneyRate, wantedRate, memberPower, clashGain } from "/gang/formulas.js";

const START = 1_800_000_000_000;
// v3.0.0 src/Gang/data/power.ts: how fast each gang's power grows on its own
const POWER_MULT = { "Slum Snakes": 1, "Tetrads": 2, "The Syndicate": 2, "The Dark Army": 2, "Speakers for the Dead": 5, "NiteSec": 2, "The Black Hand": 5 };
const MS_PER_CYCLE = 1000 / CYCLES_PER_SECOND;

const task = (name, base, weights, extra = {}) => ({
	name, isHacking: false, isCombat: true, baseRespect: 0, baseWanted: 0, baseMoney: 0, difficulty: 1,
	hackWeight: 0, strWeight: 0, defWeight: 0, dexWeight: 0, agiWeight: 0, chaWeight: 0, territory: { money: 1, respect: 1, wanted: 1 }, ...base, ...weights, ...extra,
});
/** The game's combat gang tasks (v3.0.0 src/Gang/data/tasks.ts), with Unassigned first as in the game. */
export const GANG_TASKS = [
	task("Unassigned", {}, { hackWeight: 100 }),
	task("Mug People", { baseRespect: 0.00005, baseWanted: 0.00005, baseMoney: 3.6, difficulty: 1 }, { strWeight: 25, defWeight: 25, dexWeight: 25, agiWeight: 10, chaWeight: 15 }),
	task("Deal Drugs", { baseRespect: 0.00006, baseWanted: 0.002, baseMoney: 15, difficulty: 3.5 }, { agiWeight: 20, dexWeight: 20, chaWeight: 60 }, { territory: { money: 1.2, respect: 1, wanted: 1.15 } }),
	task("Strongarm Civilians", { baseRespect: 0.00004, baseWanted: 0.02, baseMoney: 7.5, difficulty: 5 }, { hackWeight: 10, strWeight: 25, defWeight: 25, dexWeight: 20, agiWeight: 10, chaWeight: 10 }, { territory: { money: 1.6, respect: 1.1, wanted: 1.5 } }),
	task("Run a Con", { baseRespect: 0.00012, baseWanted: 0.05, baseMoney: 45, difficulty: 14 }, { strWeight: 5, defWeight: 5, agiWeight: 25, dexWeight: 25, chaWeight: 40 }),
	task("Armed Robbery", { baseRespect: 0.00014, baseWanted: 0.1, baseMoney: 114, difficulty: 20 }, { hackWeight: 20, strWeight: 15, defWeight: 15, agiWeight: 10, dexWeight: 20, chaWeight: 20 }),
	task("Traffick Illegal Arms", { baseRespect: 0.0002, baseWanted: 0.24, baseMoney: 174, difficulty: 32 }, { hackWeight: 15, strWeight: 20, defWeight: 20, dexWeight: 20, chaWeight: 25 }, { territory: { money: 1.4, respect: 1.3, wanted: 1.25 } }),
	task("Threaten & Blackmail", { baseRespect: 0.0002, baseWanted: 0.125, baseMoney: 72, difficulty: 28 }, { hackWeight: 25, strWeight: 25, dexWeight: 25, chaWeight: 25 }),
	task("Human Trafficking", { baseRespect: 0.004, baseWanted: 1.25, baseMoney: 360, difficulty: 36 }, { hackWeight: 30, strWeight: 5, defWeight: 5, dexWeight: 30, chaWeight: 30 }, { territory: { money: 1.5, respect: 1.5, wanted: 1.6 } }),
	task("Terrorism", { baseRespect: 0.01, baseWanted: 6, baseMoney: 0, difficulty: 36 }, { hackWeight: 20, strWeight: 20, defWeight: 20, dexWeight: 20, chaWeight: 20 }, { territory: { money: 1, respect: 2, wanted: 2 } }),
	task("Vigilante Justice", { baseWanted: -0.001, difficulty: 1 }, { hackWeight: 20, strWeight: 20, defWeight: 20, dexWeight: 20, agiWeight: 20 }, { isHacking: true, territory: { money: 1, respect: 1, wanted: 0.9 } }),
	task("Train Combat", { difficulty: 100 }, { strWeight: 25, defWeight: 25, dexWeight: 25, agiWeight: 25 }, { isHacking: true }),
	task("Train Hacking", { difficulty: 45 }, { hackWeight: 100 }, { isHacking: true }),
	task("Train Charisma", { difficulty: 8 }, { chaWeight: 100 }, { isHacking: true }),
	task("Territory Warfare", { difficulty: 5 }, { hackWeight: 15, strWeight: 20, defWeight: 20, dexWeight: 20, agiWeight: 20, chaWeight: 5 }, { isHacking: true }),
];
const TASKS = Object.fromEntries(GANG_TASKS.map((entry) => [entry.name, entry]));

/** A few items of each kind, costs before the respect/power discount (approximate v3.0.0 values). */
export const GANG_EQUIPMENT = [
	{ name: "Baseball Bat", type: "Weapon", cost: 1e6, stats: { str: 1.04, def: 1.04 } },
	{ name: "Katana", type: "Weapon", cost: 12e6, stats: { str: 1.08, def: 1.08, dex: 1.08 } },
	{ name: "Bulletproof Vest", type: "Armor", cost: 2e6, stats: { def: 1.04 } },
	{ name: "Ford Flex V20", type: "Vehicle", cost: 3e6, stats: { agi: 1.04, cha: 1.04 } },
	{ name: "NUKE Rootkit", type: "Rootkit", cost: 1e6, stats: { hack: 1.05 } },
	{ name: "Bionic Arms", type: "Augmentation", cost: 250e6, stats: { str: 1.3, dex: 1.3 } },
	{ name: "Nanofiber Weave", type: "Augmentation", cost: 125e6, stats: { str: 1.2, def: 1.2 } },
];

class SimEnd extends Error {}

/**
 * @param {object} [options]
 * @param {boolean} [options.inGang]      already in a gang (else main has to create one)
 * @param {string} [options.faction]      the gang's faction when inGang
 * @param {string[]} [options.factions]   factions the player has joined
 * @param {number} [options.node]
 * @param {Array<[number, number]>} [options.sourceFiles]
 * @param {number} [options.karma]
 * @param {number} [options.members]      members at the start (member-1 ...)
 * @param {number} [options.exp]          each starting member's experience in every combat stat
 * @param {number} [options.respect]
 * @param {number} [options.wanted]
 * @param {number} [options.territory]    our share of the land
 * @param {number} [options.power]
 * @param {boolean} [options.engaged]    territory clashes already on
 * @param {Record<string, {power: number, territory: number}>} [options.others] other gangs (the game's six others, power 1, the rest of the land split evenly when omitted)
 * @param {boolean} [options.npcGrowth]   other gangs gain power on their own, as in the game (false: they stay put)
 * @param {number} [options.money]
 * @param {number} [options.income]       cash per second from scripts
 * @param {number} [options.updateCycles] cycles per gang update: 10 (2 seconds) normally, up to 25 with bonus time
 * @param {object} [options.config]       data/config.json
 * @param {string[]} [options.args]       the manager's flags (--no-buy, --no-war)
 * @param {number} [options.runAge]       seconds since the BitNode started (the growth horizon)
 */
export function gangSim({
	inGang = true, faction = "Slum Snakes", factions = [faction], node = 2, sourceFiles = [], karma = 0,
	members = 0, exp = 0, respect = 1, wanted = 1, territory = 1 / 7, power = 1, engaged = false, others, money = 0, income = 0,
	updateCycles = 10, config = {}, args = [], runAge = 3600, npcGrowth = true,
} = {}) {
	let now = START;
	let seed = 12345;
	const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
	const player = { factions: [...factions], money, karma };
	const rivals = others ?? Object.fromEntries(Object.keys(POWER_MULT)
		.filter((name) => name !== faction).slice(0, 6).map((name) => [name, { power: 1, territory: (1 - territory) / 6 }]));
	const gang = inGang ? newGang(faction) : null;
	function newGang(name) {
		return { faction: name, respect, wanted, territory, power, engaged, clashChance: engaged ? 1 : 0, members: [], storedPowerCycles: 0, moneyRate: 0, respectRate: 0 };
	}
	const sim = {
		player, rivals, gang,
		recruits: [],    // { time, name, members }
		ascensions: [],  // { time, name }
		purchases: [],   // { time, member, item, cost }
		warfare: [],     // { time, engaged } each change
		deaths: [],      // { time, name }
		updates: 0,
		history: [],     // after each update: { time, members, penalty, wanted, respect, territory, power, engaged, tasks: { task: count }, others: rivals holding land }
		missedRecruits: 0, // updates that began with a recruit affordable and a free place left
		taskSets: [],    // { time, name, task } every setMemberTask
		get now() { return now; },
		seconds: () => (now - START) / 1000,
		ns: null,
		helperRoom: true, // false: gang/workers/equipment.js doesn't fit anywhere
	};
	const timers = [];
	/** Calls fn(sim) once the simulated clock passes `ms` after the start. */
	sim.at = (ms, fn) => timers.push({ at: START + ms, fn });

	const addMember = (name) => {
		const member = { name, task: "Unassigned", earnedRespect: 0, exp: {}, points: {}, upgrades: [], augmentations: [] };
		for (const stat of STAT_NAMES) { member.exp[stat] = 0; member.points[stat] = 0; }
		sim.gang.members.push(member);
		return member;
	};
	for (let index = 1; index <= members && gang; index++) {
		const member = addMember(`member-${index}`);
		for (const stat of ["str", "def", "dex", "agi"]) member.exp[stat] = exp;
	}
	const item = (name) => GANG_EQUIPMENT.find((entry) => entry.name === name);
	const equipMult = (member, stat) => [...member.upgrades, ...member.augmentations].reduce((product, name) => product * (item(name)?.stats[stat] ?? 1), 1);
	const stats = (member) => Object.fromEntries(STAT_NAMES.map((stat) => [stat, skillLevel(member.exp[stat], equipMult(member, stat) * ascensionMult(member.points[stat]))]));
	const find = (name) => sim.gang?.members.find((member) => member.name === name);
	const nextRecruit = () => {
		const count = sim.gang.members.length;
		if (count < 3) return 0;
		if (count >= 12) return Infinity;
		return Math.pow(5, count - 3 + 1);
	};
	const rates = () => ({ respect: sim.gang.respect, wanted: sim.gang.wanted, territory: sim.gang.territory });
	const discount = () => Math.max(1, Math.pow(sim.gang.respect, 0.01) + sim.gang.respect / 5e6 + Math.pow(sim.gang.power, 0.01) + sim.gang.power / 1e6 - 1);
	const ownGangs = () => ({ [sim.gang.faction]: { power: sim.gang.power, territory: sim.gang.territory }, ...rivals });
	sim.kill = (name) => {
		const member = find(name);
		sim.gang.respect = Math.max(1, sim.gang.respect - (0.05 * sim.gang.respect + member.earnedRespect));
		sim.gang.members.splice(sim.gang.members.indexOf(member), 1);
		sim.deaths.push({ time: sim.seconds(), name });
	};
	/** Our total in the land sums (ours plus every rival), always 1 in the game. */
	sim.landTotal = () => sim.gang.territory + Object.values(rivals).reduce((sum, rival) => sum + rival.territory, 0);

	/** Deaths in a clash: 35% of clashes can kill, only Territory Warfare members, 1% (0.5% after a win) over defense^0.6. */
	const clashDeaths = (won) => {
		if (random() < 0.65) return;
		for (const member of [...sim.gang.members].reverse()) {
			if (member.task !== "Territory Warfare") continue;
			if (random() < (won ? 0.005 : 0.01) / Math.pow(stats(member).def, 0.6)) sim.kill(member.name);
		}
	};

	/** One gang update of `cycles` game cycles. */
	const process = (cycles) => {
		const g = sim.gang;
		const seconds = cycles / CYCLES_PER_SECOND;
		let respectGain = 0;
		let moneyPerSecond = 0;
		let wantedPerSecond = 0;
		let justice = 0;
		const before = rates();
		for (const member of g.members) {
			const job = TASKS[member.task];
			const level = stats(member);
			const earned = respectRate(job, level, before) * seconds;
			member.earnedRespect += earned;
			respectGain += earned;
			moneyPerSecond += moneyRate(job, level, before);
			wantedPerSecond += wantedRate(job, level, before);
			if (job.baseWanted < 0) justice++;
		}
		g.respectRate = respectGain / cycles;
		g.moneyRate = moneyPerSecond / CYCLES_PER_SECOND;
		g.respect += respectGain;
		if (g.wanted !== 1 || wantedPerSecond >= 0) {
			const old = g.wanted;
			g.wanted = (old + wantedPerSecond * seconds) * (1 - justice * 0.001);
			if (g.wanted < 1 || (wantedPerSecond <= 0 && g.wanted > old)) g.wanted = 1;
		}
		player.money += moneyPerSecond * seconds;
		for (const member of g.members) {
			const job = TASKS[member.task];
			for (const stat of STAT_NAMES) member.exp[stat] += expRate(job, stat, equipMult(member, stat), ascensionMult(member.points[stat])) * seconds;
		}
		// Power and clashes every 100 cycles
		g.storedPowerCycles += cycles;
		if (g.storedPowerCycles < 100) return;
		g.storedPowerCycles -= 100;
		const warriors = g.members.filter((member) => member.task === "Territory Warfare");
		g.power += 0.015 * Math.max(0.002, g.territory) * warriors.reduce((sum, member) => sum + memberPower(stats(member)), 0);
		if (npcGrowth) {
			for (const [name, rival] of Object.entries(rivals)) {
				const roll = random();
				rival.power += roll < 0.5 ? Math.min(0.85, rival.power * 0.005) : 0.75 * roll * rival.territory * (POWER_MULT[name] ?? 1);
			}
		}
		g.clashChance = g.engaged ? 1 : Math.max(0, g.clashChance - 0.01);
		const all = ownGangs();
		const names = Object.keys(all).filter((name) => all[name].territory > 0 || name === g.faction);
		const land = (name) => (name === g.faction ? g : rivals[name]);
		for (const name of names) {
			const opponents = names.filter((other) => other !== name);
			if (opponents.length === 0) break;
			const other = opponents[Math.floor(random() * opponents.length)];
			if ((name === g.faction || other === g.faction) && !(random() < g.clashChance)) continue;
			const [winner, loser] = random() < land(name).power / (land(name).power + land(other).power) ? [name, other] : [other, name];
			if (land(loser).territory <= 0) continue;
			const moved = Math.min(land(loser).territory, clashGain(land(winner), land(loser)) * (random() + 0.5));
			land(winner).territory += moved;
			land(loser).territory -= moved;
			if (loser === g.faction) g.power /= 1.008;
			else land(loser).power /= 1.01;
			if (winner === g.faction || loser === g.faction) clashDeaths(winner === g.faction);
		}
	};

	const world = fakeWorld({
		homeRam: 64, node, sourceFiles,
		files: { "data/config.json": JSON.stringify(config) },
		scriptRam: (script) => (script === "gang/workers/equipment.js" && !sim.helperRoom ? 1e9 : 2),
		onExec: (script) => {
			if (script === "gang/workers/equipment.js") {
				world.ns.clearPort(29);
				world.ns.writePort(29, { time: now, items: GANG_EQUIPMENT.map(({ name, type, stats: itemStats }) => ({ name, type, stats: itemStats })) });
			}
			return { exits: true };
		},
		overrides: (() => {
			const ports = {};
			return {
				// Ports hold what was written, as in the game (objects stay objects)
				peek: (port) => (port in ports ? ports[port] : "NULL PORT DATA"),
				writePort: (port, data) => { ports[port] = data; return null; },
				clearPort: (port) => { delete ports[port]; },
				getHostname: () => "home",
				args,
				flags: (schema) => Object.fromEntries(schema.map(([name, fallback]) => [name, args.includes(`--${name}`) ? true : fallback])),
				getPlayer: () => ({ factions: [...player.factions], money: player.money }),
				getTotalScriptIncome: () => [income, 0],
				getResetInfo: () => ({ currentNode: node, ownedSF: new Map(sourceFiles), lastAugReset: START - runAge * 1000, lastNodeReset: START - runAge * 1000 }),
				sleep: async (ms) => { advance(ms); return true; },
				heart: { break: () => player.karma },
				format: { percent: (value) => `${(value * 100).toFixed(1)}%`, number: (value) => String(Math.round(value * 1000) / 1000) },
				gang: {
					inGang: () => sim.gang !== null,
					createGang: (name) => {
						if (sim.gang || !player.factions.includes(name)) return false;
						if (node !== 2 && player.karma > -54_000) return false;
						sim.gang = newGang(name);
						return true;
					},
					getGangInformation: () => {
						const g = sim.gang;
						return {
							faction: g.faction, isHacking: false, respect: g.respect, respectForNextRecruit: nextRecruit(), wantedLevel: g.wanted,
							wantedPenalty: g.respect / (g.respect + g.wanted), territory: g.territory, power: g.power, territoryWarfareEngaged: g.engaged,
							territoryClashChance: g.clashChance, moneyGainRate: g.moneyRate, respectGainRate: g.respectRate,
						};
					},
					getAllGangInformation: () => ownGangs(),
					getMemberNames: () => sim.gang.members.map((member) => member.name),
					recruitMember: (name) => {
						if (sim.gang.members.length >= 12 || sim.gang.respect < nextRecruit() || find(name)) return false;
						addMember(name);
						sim.recruits.push({ time: sim.seconds(), name, members: sim.gang.members.length });
						return true;
					},
					getMemberInformation: (name) => {
						const member = find(name);
						const info = { name, task: member.task, earnedRespect: member.earnedRespect, upgrades: [...member.upgrades], augmentations: [...member.augmentations], ...stats(member) };
						for (const stat of STAT_NAMES) {
							info[`${stat}_exp`] = member.exp[stat];
							info[`${stat}_mult`] = equipMult(member, stat);
							info[`${stat}_asc_mult`] = ascensionMult(member.points[stat]);
							info[`${stat}_asc_points`] = member.points[stat];
						}
						return info;
					},
					getTaskNames: () => GANG_TASKS.slice(1).map((entry) => entry.name),
					getTaskStats: (name) => structuredClone(TASKS[name]),
					setMemberTask: (name, job) => {
						const member = find(name);
						if (!member || !TASKS[job]) return false;
						if (member.task !== job) sim.taskSets.push({ time: sim.seconds(), name, task: job });
						member.task = job;
						return true;
					},
					getAscensionResult: (name) => {
						const member = find(name);
						const gain = {};
						let any = false;
						for (const stat of STAT_NAMES) {
							const points = ascensionPoints(member.exp[stat]);
							if (points > 0) any = true;
							gain[stat] = ascensionMult(member.points[stat] + points) / ascensionMult(member.points[stat]);
						}
						return any ? { respect: member.earnedRespect, ...gain } : undefined;
					},
					ascendMember: (name) => {
						const member = find(name);
						for (const stat of STAT_NAMES) { member.points[stat] += ascensionPoints(member.exp[stat]); member.exp[stat] = 0; }
						sim.gang.respect = Math.max(1, sim.gang.respect - member.earnedRespect);
						member.earnedRespect = 0;
						member.upgrades = [];
						sim.ascensions.push({ time: sim.seconds(), name });
						return true;
					},
					getEquipmentCost: (name) => item(name).cost / discount(),
					purchaseEquipment: (name, itemName) => {
						const member = find(name);
						const entry = item(itemName);
						const cost = entry.cost / discount();
						if (!member || player.money < cost || member.upgrades.includes(itemName) || member.augmentations.includes(itemName)) return false;
						player.money -= cost;
						(entry.type === "Augmentation" ? member.augmentations : member.upgrades).push(itemName);
						sim.purchases.push({ time: sim.seconds(), member: name, item: itemName, cost });
						return true;
					},
					setTerritoryWarfare: (engage) => {
						if (sim.gang.engaged !== engage) sim.warfare.push({ time: sim.seconds(), engaged: engage });
						sim.gang.engaged = engage;
					},
					nextUpdate: async () => {
						const g = sim.gang;
						if (g.members.length < 12 && g.respect >= nextRecruit()) sim.missedRecruits++;
						advance(updateCycles * MS_PER_CYCLE);
						process(updateCycles);
						sim.updates++;
						const tasks = {};
						for (const member of g.members) tasks[member.task] = (tasks[member.task] ?? 0) + 1;
						sim.history.push({
							time: sim.seconds(), members: g.members.length, penalty: g.wanted / (g.respect + g.wanted), wanted: g.wanted, respect: g.respect,
							territory: g.territory, power: g.power, engaged: g.engaged, tasks, others: Object.values(rivals).filter((rival) => rival.territory > 0).map((rival) => ({ ...rival })),
						});
						return updateCycles * MS_PER_CYCLE;
					},
				},
			};
		})(),
	});
	sim.ns = world.ns;
	sim.world = world;

	let end = Infinity;
	function advance(ms) {
		now += ms;
		player.money += income * (ms / 1000);
		for (const timer of timers.filter((entry) => !entry.done && entry.at <= now)) { timer.done = true; timer.fn(sim); }
		if (now >= end) throw new SimEnd();
	}

	/** Runs `main` for `ms` of simulated time (Date.now follows the simulated clock). */
	sim.run = async (main, ms) => {
		end = now + ms;
		const realNow = Date.now;
		Date.now = () => now;
		try {
			await main(world.ns);
		} catch (error) {
			if (!(error instanceof SimEnd)) throw error;
		} finally {
			Date.now = realNow;
		}
	};
	/** The summary posted on port 28 (status.js). */
	sim.summary = () => { const data = world.ns.peek(28); return data === "NULL PORT DATA" ? null : data; };
	sim.stats = (name) => stats(find(name));
	return sim;
}
