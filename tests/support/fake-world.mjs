// A small game world on top of fake-ns.mjs, for scripts that start, stop and place other scripts
// (startup.js, auto-reset.js, install-augs.js): servers with RAM and root, a process table, files
// on each server, and the BitNode / Source-Files the run has.
//
//   const world = fakeWorld({ homeRam: 64, servers: { "n00dles": { ram: 4 } } });
//   world.ns.exec("hack/batcher.js", "home", 1);
//   world.running()          // [{ pid, filename, host, args, threads }]
//   world.exit("hack/batcher.js")   // the script ends by itself
//
// Script files on home are the real ones in the repo (read from disk), so startup.js copies a
// script's real imports when it places it on another server. Other files (programs, data/) go in
// `homeFiles`. A started script keeps running until world.exit(), unless onExec says it exits at
// once (return { exits: true }); onExec(script, args, world) can also play what the script does.
import fs from "node:fs";
import path from "node:path";
import { fakeNs } from "./fake-ns.mjs";
import { ROOT } from "./game-path.mjs";

/**
 * @param {object} [options]
 * @param {number} [options.homeRam]
 * @param {Record<string, {ram?: number, root?: boolean, ports?: number, links?: string[]}>} [options.servers] linked to home unless `links` says otherwise
 * @param {number} [options.node]                 current BitNode
 * @param {Array<[number, number]>} [options.sourceFiles] owned Source-File levels
 * @param {string[]} [options.homeFiles]          extra files on home (programs, data files)
 * @param {Record<string, string>} [options.files] file contents (data/...)
 * @param {Record<number, any>} [options.ports]
 * @param {number} [options.money]
 * @param {(script: string) => number} [options.scriptRam] RAM per thread; 2GB by default
 * @param {(script: string, args: any[], world: any) => (void | {exits?: boolean})} [options.onExec]
 * @param {Record<string, any>} [options.overrides] extra ns members
 */
export function fakeWorld({
	homeRam = 64, servers = {}, node = 1, sourceFiles = [], homeFiles = [], files = {}, ports = {}, money = 0,
	scriptRam = () => 2, onExec = () => undefined, overrides = {},
} = {}) {
	const hosts = { home: { ram: homeRam, root: true, ports: 0, links: Object.keys(servers).filter((name) => !servers[name].links) } };
	for (const [name, server] of Object.entries(servers)) {
		hosts[name] = { ram: server.ram ?? 0, root: server.root ?? true, ports: server.ports ?? 0, links: server.links ?? ["home"] };
	}
	const copied = new Map(Object.keys(hosts).map((host) => [host, new Set()])); // files scp'd to each server
	const extraHomeFiles = new Set(homeFiles);
	const procs = [];
	let nextPid = 100;
	const clean = (file) => String(file).replace(/^\//, "");
	const onDisk = (file) => file.endsWith(".js") && fs.existsSync(path.join(ROOT, file));
	const usedRam = (host) => procs.filter((proc) => proc.host === host).reduce((sum, proc) => sum + scriptRam(proc.filename) * proc.threads, 0);
	const neighbours = (host) => [
		...hosts[host].links,
		...Object.keys(hosts).filter((other) => hosts[other].links.includes(host)),
	].filter((other, index, all) => other !== host && all.indexOf(other) === index);

	const world = {
		hosts, procs, copied,
		/** Processes running now. */
		running: () => procs.map((proc) => ({ ...proc })),
		/** Filenames running on a host (all hosts when omitted). */
		names: (host) => procs.filter((proc) => !host || proc.host === host).map((proc) => proc.filename),
		/** The script ends by itself (every copy, or only those with these args). */
		exit: (script, args) => {
			for (let index = procs.length - 1; index >= 0; index--) {
				if (procs[index].filename === clean(script) && (!args || JSON.stringify(procs[index].args) === JSON.stringify(args))) procs.splice(index, 1);
			}
		},
		/** A process already running (started before the test). */
		start: (script, host = "home", args = [], threads = 1) => {
			const pid = nextPid++;
			procs.push({ pid, filename: clean(script), host, args, threads });
			return pid;
		},
		ns: null,
	};

	const exec = (script, host, threadsOrOptions = 1, ...args) => {
		const file = clean(script);
		const threads = typeof threadsOrOptions === "number" ? threadsOrOptions : threadsOrOptions?.threads ?? 1;
		if (!hosts[host] || !hosts[host].root) return 0;
		const present = host === "home" ? onDisk(file) || extraHomeFiles.has(file) : copied.get(host).has(file);
		if (!present) return 0;
		if (usedRam(host) + scriptRam(file) * threads > hosts[host].ram) return 0;
		const pid = nextPid++;
		const proc = { pid, filename: file, host, args, threads };
		procs.push(proc);
		const effect = onExec(file, args, world);
		if (effect?.exits) procs.splice(procs.indexOf(proc), 1);
		return pid;
	};

	world.ns = fakeNs({
		files, ports, money,
		overrides: {
			pid: 1,
			scan: (host) => neighbours(host),
			hasRootAccess: (host) => hosts[host].root,
			getServerMaxRam: (host) => hosts[host].ram,
			getServerUsedRam: (host) => usedRam(host),
			getServerNumPortsRequired: (host) => hosts[host].ports,
			nuke: (host) => { hosts[host].root = true; return true; },
			brutessh: () => true, ftpcrack: () => true, relaysmtp: () => true, httpworm: () => true, sqlinject: () => true,
			ps: (host = "home") => procs.filter((proc) => proc.host === host).map((proc) => ({ ...proc })),
			exec,
			kill: (pid) => {
				const index = procs.findIndex((proc) => proc.pid === pid);
				if (index >= 0) procs.splice(index, 1);
				return index >= 0;
			},
			isRunning: (pid) => procs.some((proc) => proc.pid === pid),
			getScriptRam: (script) => scriptRam(clean(script)),
			getScriptName: () => "startup.js",
			getRunningScript: () => ({ parent: 1 }), // started by another script: no status print
			fileExists: (file, host = "home") => {
				const name = clean(file);
				if (host === "home") return onDisk(name) || extraHomeFiles.has(name) || name in world.ns.files;
				return copied.get(host)?.has(name) ?? false;
			},
			read: (file) => {
				const name = clean(file);
				if (name in world.ns.files) return world.ns.files[name];
				return onDisk(name) ? fs.readFileSync(path.join(ROOT, name), "utf8") : "";
			},
			scp: (list, host) => {
				for (const file of [list].flat()) copied.get(host).add(clean(file));
				return true;
			},
			sleep: async () => true,
			getResetInfo: () => ({ currentNode: node, ownedSF: new Map(sourceFiles), lastAugReset: 0 }),
			getPlayer: () => ({ factions: [], money }),
			dnet: { isDarknetServer: () => false },
			gang: { inGang: () => false },
			heart: { break: () => 0 },
			...overrides,
		},
	});
	return world;
}
