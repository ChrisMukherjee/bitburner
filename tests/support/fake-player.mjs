// A small player simulator for running singularity/player-work.js pass after pass on a mocked clock, the way
// startup.js runs it (--once about every minute).
//
//   const sim = playerSim({ goals: { CyberSec: 10_000 }, autoJoin: { CyberSec: (p) => p.hacking >= 60 } });
//   await sim.passes(main, 40);        // 40 passes, one simulated minute apart
//   sim.flights, sim.joins, sim.log    // what happened, in order
//
// The player has a city, cash, hacking and combat levels, factions, jobs and one piece of work at a time. Between
// passes the work pays off (a class raises hacking, faction and company work raise rep, cash comes in at `income`).
// Invites follow the game's rules for Tian Di Hui and the city factions (v3.0.0 FactionInfo.tsx), and joining a city
// faction locks out its rivals; other factions are joined when `autoJoin` says so (join-factions.js's part).
// The helpers player-work.js starts (faction goals, city plan, gang invite, the idle crime) answer at once from `goals`
// and `cityNeeds`. Simplifications: flat rates, no focus penalty, flights don't stop work.
import { fakeWorld } from "./fake-world.mjs";

const START = 1_800_000_000_000;
const CITIES = ["Sector-12", "Aevum", "Chongqing", "New Tokyo", "Ishima", "Volhaven"];
const INVITE_MONEY = { "Sector-12": 15e6, "Aevum": 40e6, "Chongqing": 20e6, "New Tokyo": 20e6, "Ishima": 30e6, "Volhaven": 50e6 };
// Rivals (v3.0.0 FactionInfo.tsx enemies): joining one closes the others' invites
const RIVALS = {
	"Sector-12": ["Chongqing", "New Tokyo", "Ishima", "Volhaven"], "Aevum": ["Chongqing", "New Tokyo", "Ishima", "Volhaven"],
	"Chongqing": ["Sector-12", "Aevum", "Volhaven"], "New Tokyo": ["Sector-12", "Aevum", "Volhaven"], "Ishima": ["Sector-12", "Aevum", "Volhaven"],
	"Volhaven": ["Sector-12", "Aevum", "Chongqing", "New Tokyo", "Ishima"],
};
const CLASS_TYPES = { "Computer Science": "STUDYCOMPUTERSCIENCE", "Algorithms": "ALGORITHMS" };
const UNIVERSITY_CITY = { "Rothman University": "Sector-12" };

/**
 * @param {object} [options]
 * @param {number} [options.hacking]
 * @param {number} [options.money]
 * @param {number} [options.income]          cash per second from scripts
 * @param {string} [options.city]
 * @param {string[]} [options.factions]       joined at the start
 * @param {Record<string, number>} [options.goals]   faction -> rep goal the goals helper reports (augments worth buying there)
 * @param {Record<string, string[]>} [options.cityNeeds] city faction -> wanted augments only it sells (the city plan)
 * @param {Record<string, (player: any) => boolean>} [options.autoJoin] faction -> when join-factions.js would accept its invite
 * @param {object} [options.config]           data/config.json
 * @param {object} [options.rates]            per minute: hacking (class), rep (faction work), companyRep
 * @param {number} [options.node]
 * @param {(script: string) => number} [options.scriptRam] RAM per thread (2GB by default; a big number = no room for it)
 * @param {boolean} [options.focusPenalty]    what the goals helper reports (false once the Neuroreceptor implant is in)
 * @param {(player: any) => object} [options.gang] gang/workers/invite.js's answer ({ applies: false } by default)
 */
export function playerSim({
	hacking = 1, money = 0, income = 20_000, city = "Sector-12", factions = [], goals = {}, cityNeeds = {}, autoJoin = {},
	config = {}, rates = {}, node = 1, scriptRam = () => 2, focusPenalty = true, gang = () => ({ applies: false }),
} = {}) {
	const perMinute = { hacking: 2, rep: 2000, companyRep: 50_000, karma: 100, ...rates };
	let now = START;
	const player = {
		city, money, factions: [...factions], jobs: {}, karma: 0, numPeopleKilled: 0,
		skills: { hacking, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1 },
	};
	const rep = {};
	const companyRep = {};
	const sim = {
		player, rep, companyRep, work: null,
		flights: [],   // { time, from, to, money } (money before paying)
		joins: [],     // { time, faction }
		started: [],   // { time, kind, name, hacking, focus } each work started
		helpers: [],   // { time, script } each helper run
		gateAt: null,  // minute the done gate (port 33) first appeared
		lines: [],     // each pass's log lines
		passCount: 0,
		resetAt: 0,    // getResetInfo().lastAugReset: change it for a new run (an install)
		get now() { return now; },
		minutes: () => (now - START) / 60_000,
		ns: null,
	};
	const rivalJoined = (faction) => (RIVALS[faction] ?? []).some((rival) => player.factions.includes(rival));
	const invited = (faction) => {
		if (player.factions.includes(faction) || rivalJoined(faction)) return false;
		if (faction === "Tian Di Hui") return player.skills.hacking >= 50 && player.money >= 1e6 && ["Chongqing", "New Tokyo", "Ishima"].includes(player.city);
		if (CITIES.includes(faction)) return player.city === faction && player.money >= INVITE_MONEY[faction];
		return false;
	};
	const join = (faction) => {
		player.factions.push(faction);
		sim.joins.push({ time: sim.minutes(), faction });
	};
	const startWork = (work, kind, name, focus) => {
		sim.work = work;
		sim.started.push({ time: sim.minutes(), kind, name, hacking: player.skills.hacking, focus });
	};

	const post = (port, data) => {
		world.ns.clearPort(port);
		world.ns.writePort(port, JSON.stringify({ time: now, ...data }));
	};
	const onExec = (script, args) => {
		const arg = (() => { try { return JSON.parse(args[0]); } catch { return {}; } })();
		sim.helpers.push({ time: sim.minutes(), script });
		if (script === "singularity/workers/faction-goals.js") {
			const out = {};
			for (const faction of arg.factions ?? []) if (goals[faction]) out[faction] = { rep: goals[faction], aug: `${faction} augment`, count: 1, skipped: 0 };
			post(23, { goals: out, focusPenalty });
		} else if (script === "singularity/workers/city-plan.js") {
			post(25, { groups: (arg.groups ?? []).map((group) => ({ factions: group, needs: Object.fromEntries(group.map((faction) => [faction, cityNeeds[faction] ?? []])) })) });
		} else if (script === "gang/workers/invite.js") {
			post(30, gang({ ...player, hacking: player.skills.hacking }));
		} else if (script === "singularity/workers/start-crime.js") {
			startWork({ type: "CRIME", crimeType: "Rob Store" }, "crime", "Rob Store");
		}
		return { exits: true };
	};

	const world = fakeWorld({
		homeRam: 256, node, scriptRam: (script) => scriptRam(script),
		files: { "data/config.json": JSON.stringify(config) },
		onExec,
		overrides: {
			getHostname: () => "home",
			getServer: () => ({ cpuCores: 1 }),
			getPlayer: () => structuredClone(player),
			getResetInfo: () => ({ currentNode: node, ownedSF: new Map([[4, 3]]), ownedAugs: new Map(), lastAugReset: sim.resetAt }),
			flags: () => ({ "focus": false, "no-focus": false, "study": 0, "no-company": false, "plan": false, "once": true }),
			sleep: async (ms) => { now += ms; return true; },
			singularity: {
				getCurrentWork: () => (sim.work ? { ...sim.work } : null),
				joinFaction: (faction) => {
					if (!invited(faction)) return false;
					join(faction);
					return true;
				},
				travelToCity: (to) => {
					if (player.money < 200e3 || to === player.city) return false;
					sim.flights.push({ time: sim.minutes(), from: player.city, to, money: player.money });
					player.money -= 200e3;
					player.city = to;
					return true;
				},
				universityCourse: (university, course, focus) => {
					if (UNIVERSITY_CITY[university] !== player.city) return false;
					startWork({ type: "CLASS", classType: CLASS_TYPES[course] ?? course, location: university }, "class", course, focus);
					return true;
				},
				gymWorkout: () => false,
				workForFaction: (faction, _type, focus) => {
					if (!player.factions.includes(faction)) return false;
					startWork({ type: "FACTION", factionName: faction, factionWorkType: "hacking" }, "faction", faction, focus);
					return true;
				},
				getFactionRep: (faction) => rep[faction] ?? 0,
				getCompanyRep: (company) => companyRep[company] ?? 0,
				applyToCompany: (company) => {
					if (company in player.jobs || player.skills.hacking < 100) return "";
					player.jobs[company] = "Software Engineering Intern";
					return player.jobs[company];
				},
				workForCompany: (company, focus) => {
					if (!(company in player.jobs)) return false;
					startWork({ type: "COMPANY", companyName: company }, "company", company, focus);
					return true;
				},
				commitCrime: (crime, focus) => {
					startWork({ type: "CRIME", crimeType: crime }, "crime", crime, focus);
					return 3000;
				},
				stopAction: () => {
					sim.work = null;
					return true;
				},
				setFocus: (focus) => { if (sim.work) sim.work.focused = focus; return true; },
			},
		},
	});
	sim.ns = world.ns;
	sim.world = world;

	/** One minute of the game: the work pays off, cash comes in, join-factions.js accepts what it would. */
	sim.advance = (ms = 60_000) => {
		const minutes = ms / 60_000;
		now += ms;
		player.money += income * (ms / 1000);
		const work = sim.work;
		if (work?.type === "CLASS" && String(work.classType).startsWith("STUDY")) player.skills.hacking += perMinute.hacking * minutes;
		if (work?.type === "CLASS" && work.classType === "ALGORITHMS") player.skills.hacking += 4 * perMinute.hacking * minutes;
		if (work?.type === "FACTION") rep[work.factionName] = (rep[work.factionName] ?? 0) + perMinute.rep * minutes;
		if (work?.type === "COMPANY") companyRep[work.companyName] = (companyRep[work.companyName] ?? 0) + perMinute.companyRep * minutes;
		if (work?.type === "CRIME") player.karma -= perMinute.karma * minutes;
		player.skills.hacking = Math.floor(player.skills.hacking * 100) / 100;
		for (const [faction, ready] of Object.entries(autoJoin)) {
			if (!player.factions.includes(faction) && ready({ ...player, hacking: player.skills.hacking, companyRep })) join(faction);
		}
	};

	/** `count` passes of `main` (--once), each followed by a simulated minute. Date.now follows the simulated clock. */
	sim.passes = async (main, count, between = 60_000) => {
		const realNow = Date.now;
		Date.now = () => now;
		try {
			for (let pass = 0; pass < count; pass++) {
				const before = world.ns.logs.length;
				await main(world.ns);
				sim.lines.push(world.ns.logs.slice(before));
				if (sim.gateAt === null && /"player-work"/.test(String(world.ns.peek(33)))) sim.gateAt = sim.minutes();
				sim.passCount++;
				sim.advance(between);
			}
		} finally {
			Date.now = realNow;
		}
	};
	return sim;
}
