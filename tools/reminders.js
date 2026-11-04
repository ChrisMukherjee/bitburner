// Design: docs/reminders.md
import { notify } from "/utils/notify.js";
import { nukeAllServers } from "/utils/nuke-all.js";
import { hasSingularity } from "/utils/singularity.js";

// Servers worth backdooring, and why. Everything else is ignored.
const WORTH_IT = {
	"CSEC": "CyberSec invite",
	"avmnite-02h": "NiteSec invite",
	"I.I.I.I": "The Black Hand invite",
	"run4theh111z": "BitRunners invite",
	"fulcrumassets": "helps the Fulcrum Secret Technologies invite",
	"w0r1d_d43m0n": "finishes the BitNode",
};
// Darkweb prices (the game's defaults); the scripts can't buy these without the Singularity API.
const TOR_PRICE = 200e3;
const PROGRAMS = [
	["BruteSSH.exe", 500e3], ["FTPCrack.exe", 1.5e6], ["relaySMTP.exe", 5e6],
	["HTTPWorm.exe", 30e6], ["SQLInject.exe", 250e6], ["Formulas.exe", 5e9],
];
const STATE_FILE = "data/reminders.json";   // what was announced; home only, so this runs on home

/**
 * For runs WITHOUT the Singularity API (the scripts there can't backdoor or buy anything): one short pass that tells you, once each,
 * when a server worth backdooring can be backdoored (with the terminal command to paste) and when you can afford TOR or
 * programs you don't own. Exits at once when the Singularity API works, because singularity/auto-backdoor.js and
 * singularity/buy-programs.js do both by themselves. startup.js runs it every minute on home.
 * Ported from the other player's backdoor-watch.js and shop-reminder.js (one pass instead of a resident loop).
 */
/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	if (hasSingularity(ns)) return;
	let announced = [];
	try { announced = JSON.parse(ns.read(STATE_FILE) || "[]"); } catch { /* start again */ }
	const seen = new Set(announced);
	const before = seen.size;
	remindBackdoors(ns, seen);
	remindPrograms(ns, seen);
	if (seen.size !== before) ns.write(STATE_FILE, JSON.stringify([...seen]), "w");
}

/** Announces each worthwhile server once it is in reach and rootable. */
function remindBackdoors(ns, seen) {
	nukeAllServers(ns); // root whatever the port openers allow
	const parent = { home: null }; // every server -> the server it is reached from
	const queue = ["home"];
	while (queue.length > 0) {
		const current = queue.shift();
		for (const next of ns.scan(current)) {
			if (!(next in parent)) {
				parent[next] = current;
				queue.push(next);
			}
		}
	}
	for (const [host, reason] of Object.entries(WORTH_IT)) {
		const key = `backdoor:${host}`;
		if (!(host in parent) || seen.has(key)) continue;
		const server = ns.getServer(host);
		if (server.backdoorInstalled || ns.getHackingLevel() < server.requiredHackingSkill || !server.hasAdminRights) continue;
		const path = [];
		for (let hop = host; hop; hop = parent[hop]) path.unshift(hop);
		const command = "home; " + path.slice(1).map((hop) => `connect ${hop}`).join("; ") + "; backdoor";
		notify(ns, "[backdoor]", `${host} is ready (${reason}). Paste: ${command}`, "success", true);
		seen.add(key);
	}
}

/** Announces TOR, then the programs you can afford together, once each. */
function remindPrograms(ns, seen) {
	const money = ns.getServerMoneyAvailable("home");
	if (!ns.hasTorRouter()) {
		if (money >= TOR_PRICE && !seen.has("shop:TOR")) {
			notify(ns, "[shop]", "You can afford a TOR router (Alpha Enterprises in the city). Then run: buy -a", "info", true);
			seen.add("shop:TOR");
		}
		return;
	}
	let budget = money;
	const names = [];
	for (const [name, cost] of PROGRAMS) {
		if (ns.fileExists(name, "home") || budget < cost) continue;
		names.push(name);
		budget -= cost;
	}
	if (names.length > 0 && !names.every((name) => seen.has(`shop:${name}`))) {
		names.forEach((name) => seen.add(`shop:${name}`));
		notify(ns, "[shop]", `Programs you can afford: ${names.join(", ")}. Run: buy -a`, "info", true);
	}
}
