// Design: docs/player-work.md
import { loadConfig } from "/utils/config.js";
import { notify } from "/utils/notify.js";

// Port openers you can create (v3.0.0 src/Programs/data/ProgramsMetadata.ts): [file, hacking level, seconds at that
// level]. Creating takes seconds * required level / your hacking level (focused; 80% speed unfocused).
const OPENERS = [
	["BruteSSH.exe", 50, 600],
	["FTPCrack.exe", 100, 1200],
	["relaySMTP.exe", 250, 3000],
	["HTTPWorm.exe", 500, 6000],
	["SQLInject.exe", 750, 12000],
];
const CREATE = "/singularity/workers/start-create.js";
const CRIME = "/singularity/workers/start-crime.js";

/**
 * The start stage's stand-in for player-work.js, which needs 32.5GB and so can't run on a home below
 * 64GB (a fresh BitNode) or on any server that small. One short pass, run by startup.js every minute
 * until the early stage, when player-work.js takes over:
 *   1. below studying.hackLevel (and in studying.city): the free course from the `studying` config;
 *   2. then a missing port opener you can create at your hacking level in at most `createPrograms.maxMinutes`
 *      (the darkweb price is far out of reach at this point, and the opener unlocks more servers for the batcher);
 *   3. then the crime that earns the most per second at your current chance, for cash towards home RAM
 *      and the port openers (the batcher earns little on a small network).
 * Leaves alone any other work (faction, company, ...), whoever started it. A class keeps running only
 * below the study target; past it, crime takes over. Focused unless `playerFocus` is false in the config.
 * The 5GB calls (create, crime) live in two workers in singularity/workers/ that it hands over to with
 * ns.spawn, which frees its own RAM first, so no step needs more than the biggest worker. 7.35GB
 * here, 6.6GB (create) or 12.1GB (crime) in the worker; it fits a 16GB server.
 *   run /singularity/player-work-start.js
 */
/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	const { studying, playerFocus, createPrograms } = loadConfig(ns);
	const focus = playerFocus !== false;
	const player = ns.getPlayer();
	const current = ns.singularity.getCurrentWork();
	const hacking = player.skills.hacking;

	if (current && current.type !== "CLASS" && current.type !== "CRIME") {
		ns.print(`[start-work] ${current.type} work is running; leaving it alone`);
		return;
	}
	if (hacking < studying.hackLevel) {
		if (current?.type === "CLASS") {
			ns.print(`[start-work] studying, hacking ${hacking} < ${studying.hackLevel}`);
			return;
		}
		if (player.city === studying.city && ns.singularity.universityCourse(studying.university, studying.course, focus)) {
			notify(ns, "[start-work]", `studying ${studying.course} until hacking ${studying.hackLevel}`, "info");
			return;
		}
		ns.print(`[start-work] can't study here (in ${player.city}, not ${studying.city}); crime instead`);
	}

	// Creating beats buying while cash is scarce. Skip what the darkweb sale could cover right now.
	const speed = focus ? 1 : 0.8;
	const creatable = OPENERS
		.filter(([file]) => !ns.fileExists(file, "home"))
		.map(([file, level, seconds]) => [file, level, seconds * level / hacking / speed / 60])
		.filter(([, level, minutes]) => hacking >= level && minutes <= createPrograms.maxMinutes)
		.sort((first, second) => first[2] - second[2]);
	// The 5GB create and crime calls live in workers; ns.spawn frees this script's RAM before the worker
	// starts. The worker's file may be missing on the server this runs on (startup only copies imports).
	const worker = creatable.length > 0 ? CREATE : CRIME;
	ns.scp(worker, ns.getHostname(), "home");
	if (creatable.length > 0) ns.spawn(worker, { spawnDelay: 0 }, creatable[0][0], Math.ceil(creatable[0][2]), focus);
	else ns.spawn(worker, { spawnDelay: 0 }, focus);
}
