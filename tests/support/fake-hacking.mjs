// A small hacking simulator for running hack/batcher.js's main loop on a mocked clock.
//
//   const sim = hackingSim({ servers: { "joesguns": { maxMoney: 1e9, minSecurity: 5, requiredLevel: 10 } } });
//   await sim.run(5 * 60_000);       // runs batcher main for 5 simulated minutes, then stops it
//   sim.hacks                        // every hack that landed: { time, target, securityAboveMin, moneyShare, earned }
//
// Servers have money, security and RAM; hack/grow/weaken workers the batcher execs finish at max(landTime, start +
// duration), the way hack/workers/*.js wait for their landing time, and change the target with the game's formulas
// (v3.0.0: hack percent, grow multiplier, security per thread, hack/grow/weaken times). Simplifications: every hack
// succeeds (chance 1), the player's multipliers are 1, and hack/workers/target-stats.js is answered at once.
// A script runs on a server other than home only after it was scp'd there.
// The batcher's ns comes from fake-ns.mjs, with ports that keep objects as they were written (like the game).
import { fakeNs } from "./fake-ns.mjs";

const WORKERS = { "hack/workers/hack.js": "hack", "hack/workers/grow.js": "grow", "hack/workers/weaken.js": "weaken" };
const STATS = "hack/workers/target-stats.js";
const RAM = { "hack/workers/hack.js": 1.7, "hack/workers/grow.js": 1.75, "hack/workers/weaken.js": 1.75, [STATS]: 5.7 };
const START = 1_800_000_000_000;

class SimEnd extends Error {}

// --- The game's hacking formulas (src/Hacking.ts, src/Server/formulas/grow.ts), multipliers at 1 ---

/** Hack, grow and weaken times in ms for a server object ({ requiredHackingSkill, hackDifficulty }). */
export function hackTime(server, hacking) {
	const skillFactor = 2.5 * server.requiredHackingSkill * server.hackDifficulty + 500;
	return (1000 * 5 * skillFactor) / (hacking + 50);
}
/** Share of the money one hack thread takes. */
export function hackPercent(server, hacking) {
	const difficultyMult = (100 - server.hackDifficulty) / 100;
	const skillMult = (hacking - (server.requiredHackingSkill - 1)) / hacking;
	return Math.min(1, Math.max(0, (difficultyMult * skillMult) / 240));
}
/** ln of the money multiplier one grow thread gives (cores add 1/16 each past the first). */
export function growLnPerThread(server, cores = 1) {
	const rate = Math.min(1.0035, 1 + 0.03 / server.hackDifficulty);
	return Math.log(rate) * (server.serverGrowth / 100) * (1 + (cores - 1) / 16);
}
/** Money after a grow of `threads` (the game adds $1 per thread first). */
export function grownMoney(server, threads, cores = 1) {
	return Math.min(server.moneyMax, (server.moneyAvailable + threads) * Math.exp(threads * growLnPerThread(server, cores)));
}
/** Fewest threads that grow the server to `target` money. */
export function growThreadsFor(server, target, cores = 1) {
	if (server.moneyAvailable >= target) return 0;
	let low = 0;
	let high = 1;
	while (grownMoney({ ...server, moneyMax: Infinity }, high, cores) < target) high *= 2;
	while (high - low > 1) {
		const mid = Math.floor((low + high) / 2);
		if (grownMoney({ ...server, moneyMax: Infinity }, mid, cores) >= target) high = mid; else low = mid;
	}
	return high;
}

/**
 * @param {object} [options]
 * @param {Record<string, {maxMoney?: number, money?: number, minSecurity?: number, security?: number, requiredLevel?: number,
 *   growth?: number, ram?: number, root?: boolean}>} [options.servers] hackable servers (and bought ones: ram, no money)
 * @param {number} [options.homeRam]
 * @param {number} [options.homeCores]
 * @param {number} [options.hacking]   the player's hacking level
 * @param {boolean} [options.formulas] Formulas.exe on home
 */
export function hackingSim({ servers = {}, homeRam = 64, homeCores = 1, hacking = 1000, formulas = true } = {}) {
	const hosts = { home: { ram: homeRam, used: 0, root: true, maxMoney: 0, money: 0, minSecurity: 1, security: 1, requiredLevel: 1, growth: 0 } };
	for (const [name, server] of Object.entries(servers)) {
		const minSecurity = server.minSecurity ?? 5;
		hosts[name] = {
			ram: server.ram ?? 0, used: 0, root: server.root ?? true, maxMoney: server.maxMoney ?? 0, money: server.money ?? server.maxMoney ?? 0,
			minSecurity, security: server.security ?? minSecurity, requiredLevel: server.requiredLevel ?? 1, growth: server.growth ?? 50,
		};
	}
	const homeFiles = new Set(formulas ? ["Formulas.exe"] : []);
	const copied = new Map(Object.keys(hosts).map((name) => [name, new Set()])); // scripts scp'd to each server
	const procs = new Map(); // pid -> { pid, filename, host, args, threads, finish }
	let nextPid = 1;
	let now = START;
	const queues = {};
	const timed = []; // { at, fn } changes during a run
	const sim = {
		hosts, procs, hacks: [], grows: [], execFailures: 0, hacking,
		prepOverlaps: [], // prep ops (batch id 0) started while an older worker still ran on the same target
		get now() { return now; },
		start: START,
		/** Changes the world `ms` into the next run. */
		at(ms, fn) { timed.push({ at: START + ms, fn }); },
		buyFormulas() { homeFiles.add("Formulas.exe"); },
		/** Money hacked so far (port 22, kept by hack.js). */
		hacked: () => Number(queues[22]?.[0]) || 0,
		port: (port) => queues[port]?.[0],
		ns: null,
		run: null,
	};

	/** The game's server object for the formulas. */
	const serverOf = (name) => {
		const host = hosts[name];
		return {
			hostname: name, requiredHackingSkill: host.requiredLevel, hackDifficulty: host.security, minDifficulty: host.minSecurity,
			serverGrowth: host.growth, moneyMax: host.maxMoney, moneyAvailable: host.money,
		};
	};
	const times = (name) => {
		const hack = hackTime(serverOf(name), sim.hacking);
		return { hack, grow: hack * 3.2, weaken: hack * 4 };
	};
	const write = (port, data) => { (queues[port] ??= []).push(data); return null; };

	const finish = (proc) => {
		procs.delete(proc.pid);
		hosts[proc.host].used -= RAM[proc.filename] * proc.threads;
		const type = WORKERS[proc.filename];
		const target = hosts[proc.args[0]];
		const cores = proc.host === "home" ? homeCores : 1;
		if (type === "hack") {
			const share = target.money / target.maxMoney;
			const earned = target.money * Math.min(1, proc.threads * hackPercent(serverOf(proc.args[0]), sim.hacking));
			sim.hacks.push({ time: now - START, target: proc.args[0], securityAboveMin: target.security - target.minSecurity, moneyShare: share, earned });
			target.money -= earned;
			target.security += 0.002 * proc.threads;
			const total = (Number(queues[22]?.[0]) || 0) + earned;
			queues[22] = [total];
		} else if (type === "grow") {
			target.money = grownMoney(serverOf(proc.args[0]), proc.threads, cores);
			target.security += 0.004 * proc.threads;
			sim.grows.push({ time: now - START, target: proc.args[0], moneyShare: target.money / target.maxMoney });
		} else if (type === "weaken") {
			target.security = Math.max(target.minSecurity, target.security - 0.05 * proc.threads * (1 + (cores - 1) / 16));
		}
	};

	const exec = (script, host, threadsOrOptions = 1, ...args) => {
		const filename = String(script).replace(/^\//, "");
		const threads = typeof threadsOrOptions === "number" ? threadsOrOptions : threadsOrOptions?.threads ?? 1;
		const server = hosts[host];
		const ram = RAM[filename] * threads;
		const present = host === "home" || copied.get(host)?.has(filename);
		if (!server?.root || !present || !(filename in RAM) || !(threads >= 1) || server.used + ram > server.ram + 1e-9) {
			sim.execFailures++;
			return 0;
		}
		const pid = nextPid++;
		if (filename === STATS) {
			const targets = {};
			for (const name of args) {
				const info = serverOf(name);
				targets[name] = {
					security: info.hackDifficulty, hackPerThread: hackPercent(info, sim.hacking), chance: 1, growPerLn: 1 / growLnPerThread(info),
				};
			}
			queues[27] = [{ time: now, weakenPerThread: 0.05, homeCores, targets }];
			return pid; // exits at once
		}
		server.used += ram;
		const type = WORKERS[filename];
		if (Number(args[2]) === 0 && [...procs.values()].some((proc) => proc.args[0] === args[0] && proc.started < now)) {
			sim.prepOverlaps.push({ time: now - START, target: args[0] });
		}
		const landTime = Number(args[1]) || 0;
		// hack/workers/*.js: duration measured at the start, then wait so it lands at landTime
		procs.set(pid, { pid, filename, host, args, threads, started: now, finish: Math.max(landTime, now + times(args[0])[type]) });
		return pid;
	};

	const sleep = async (ms) => {
		const until = now + ms;
		for (;;) {
			let next = null;
			for (const proc of procs.values()) if (proc.finish <= until && (!next || proc.finish < next.finish)) next = proc;
			const change = timed.filter((entry) => entry.at <= until).sort((a, b) => a.at - b.at)[0];
			if (change && (!next || change.at <= next.finish)) {
				now = Math.max(now, change.at);
				timed.splice(timed.indexOf(change), 1);
				change.fn(sim);
				continue;
			}
			if (!next) break;
			now = Math.max(now, next.finish);
			finish(next);
		}
		now = until;
		if (now >= sim.endAt) throw new SimEnd();
		return true;
	};

	const neighbours = (host) => (host === "home" ? Object.keys(hosts).filter((name) => name !== "home") : ["home"]);

	sim.ns = fakeNs({
		overrides: {
			peek: (port) => queues[port]?.[0] ?? "NULL PORT DATA",
			writePort: write,
			clearPort: (port) => { queues[port] = []; },
			scan: neighbours,
			hasRootAccess: (host) => hosts[host].root,
			getServerMaxRam: (host) => hosts[host].ram,
			getServerUsedRam: (host) => hosts[host].used,
			getServerNumPortsRequired: () => 0,
			nuke: (host) => { hosts[host].root = true; return true; },
			fileExists: (file, host = "home") => host === "home" && homeFiles.has(file),
			getScriptRam: (script) => RAM[String(script).replace(/^\//, "")] ?? 0,
			scp: (files, host) => {
				for (const file of [files].flat()) copied.get(host)?.add(String(file).replace(/^\//, ""));
				return true;
			},
			exec,
			ps: (host) => [...procs.values()].filter((proc) => proc.host === host).map(({ finish: _, started: __, ...proc }) => proc),
			sleep,
			getHackingLevel: () => sim.hacking,
			getPlayer: () => ({ skills: { hacking: sim.hacking }, mults: {} }),
			getServerMaxMoney: (host) => hosts[host].maxMoney,
			getServerMoneyAvailable: (host) => hosts[host].money,
			getServerSecurityLevel: (host) => hosts[host].security,
			getServerMinSecurityLevel: (host) => hosts[host].minSecurity,
			getServerRequiredHackingLevel: (host) => hosts[host].requiredLevel,
			getServerGrowth: (host) => hosts[host].growth,
			getHackTime: (host) => times(host).hack,
			getGrowTime: (host) => times(host).grow,
			getWeakenTime: (host) => times(host).weaken,
			dnet: { isDarknetServer: () => false },
			format: { ram: (gb) => `${Math.round(gb * 100) / 100}GB` },
			formulas: {
				mockServer: () => ({}),
				hacking: {
					hackTime: (server) => hackTime(server, sim.hacking),
					growTime: (server) => hackTime(server, sim.hacking) * 3.2,
					weakenTime: (server) => hackTime(server, sim.hacking) * 4,
					hackPercent: (server) => hackPercent(server, sim.hacking),
					hackChance: () => 1,
					growThreads: (server, _player, target, cores = 1) => growThreadsFor(server, target, cores),
					weakenEffect: (threads, cores = 1) => 0.05 * threads * (1 + (cores - 1) / 16),
				},
			},
		},
	});

	/** Runs `main(ns)` for `ms` of simulated time (Date.now follows the simulated clock), then stops it. */
	sim.run = async (main, ms) => {
		sim.endAt = now + ms;
		const realNow = Date.now;
		Date.now = () => now;
		try {
			await main(sim.ns);
		} catch (error) {
			if (!(error instanceof SimEnd)) throw error;
		} finally {
			Date.now = realNow;
		}
	};
	return sim;
}
