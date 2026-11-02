import { loadConfig } from "/utils/config.js";
import { notify } from "/utils/notify.js";
import { getAllServers } from "/utils/get-all-servers.js";

// Port workers/city-plan.js writes to (not imported: the static RAM check would charge its
// Singularity calls to this script too).
const PLAN_PORT = 25;

// Rival groups, in the order to go for them. Joining a city faction blocks every faction in
// the other groups for the rest of the run, so one run gets one group.
// From the v3.0.0 source, the augments worth having that only a city sells:
//   Sector-12: CashRoot Starter Kit (12.5k rep)   Aevum: PC Direct-Neural Interface (PCMatrix, 100k rep)
//   Chongqing: Neuregen Gene Modification (37.5k rep)
//   New Tokyo, Ishima, Volhaven: nothing that NiteSec, Tian Di Hui, The Black Hand or CyberSec
//   don't sell too, so the plan skips them (Volhaven is listed in case that ever changes).
// The groups, in the order tried, and the non-city factions the scripts join anyway (an augment
// they also sell isn't a reason to pick a city) are `cities.groups` and `cities.otherSources`
// in the config (config.js, data/config.json). "Worth having" is `augments` there too.
// Invite rules (v3.0.0 FactionInfo.tsx): be in the faction's city with this much money.
const INVITE_MONEY = {
	"Sector-12": 15e6, "Aevum": 40e6, "Chongqing": 20e6, "New Tokyo": 20e6, "Ishima": 30e6, "Volhaven": 50e6,
};

const CONFIG = {
	travelCost: 200e3,
	loopMs: 30_000,
	refreshMs: 10 * 60_000,    // re-read the plan this often (catches augments bought meanwhile)
	helper: "workers/city-plan.js",
	helperImports: ["utils/config.js", "config.js", "utils/notify.js", "utils/aug-filter.js"],
	tianDiHuiScript: "singularity/get-tian-di-hui.js",
};

/**
 * Gets you into the city factions that still sell augments worth having, one rival group
 * per run: Sector-12 + Aevum (CashRoot, PCMatrix) first, then, once those are owned or bought,
 * Chongqing (Neuregen) in a later run. Flies to the faction's city once you have its invite
 * money plus the $200k flight, then joins on the invite. It joins only the factions with
 * something left to buy, never a rival. faction-work.js then works them (last, after the
 * hacking factions) and buy-augs.js buys from them.
 *
 * Owned augments are read from the game each time (installed or bought-not-installed), so
 * nothing is kept in files: whatever you own decides the group, across resets.
 *
 * Waits while get-tian-di-hui.js is still running, so the two don't fly against each other
 * (Tian Di Hui needs Chongqing, New Tokyo or Ishima). Exits once the group's factions are
 * joined, or when no city sells anything you still want.
 *
 * About 10GB, plus workers/city-plan.js (about 17GB) for a moment at the start, after each
 * join and every 10 minutes (on home, else on this server).
 *
 *   run singularity/city-factions.js         travel and join
 *   run singularity/city-factions.js --dry   print the plan, travel and join nothing
 */
/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	const flags = ns.flags([["dry", false]]);
	const cities = loadConfig(ns).cities;
	let plan = null;
	let planAt = 0;
	let lastMessage = "";
	let lastAnnounced = ""; // the city plan last shown as a toast + terminal line

	while (true) {
		if (!plan || Date.now() - planAt >= CONFIG.refreshMs) {
			const fresh = await refreshPlan(ns, cities);
			if (fresh) {
				plan = fresh;
				planAt = Date.now();
			}
		}

		const player = ns.getPlayer();
		let message;
		let done = false;
		if (!plan) {
			message = `[city] no room yet for ${CONFIG.helper} (${ns.format.ram(ns.getScriptRam(CONFIG.helper))}); retrying`;
		} else {
			const joined = new Set(player.factions);
			const wanted = (group) => group.factions.filter((faction) => plan.needs(group, faction).length > 0);
			const lockedIndex = plan.groups.findIndex((group) => group.factions.some((faction) => joined.has(faction)));
			const groupIndex = lockedIndex >= 0 ? lockedIndex : plan.groups.findIndex((group) => wanted(group).length > 0);

			if (flags.dry) printPlan(ns, plan, lockedIndex, groupIndex);
			else lastAnnounced = announcePlan(ns, plan, groupIndex, joined, wanted, lastAnnounced);

			if (groupIndex < 0) {
				message = "[city] no city faction sells anything you still want; done.";
				done = true;
			} else {
				const group = plan.groups[groupIndex];
				const todo = wanted(group).filter((faction) => !joined.has(faction));
				if (todo.length === 0) {
					const next = plan.groups.findIndex((other, index) => index !== groupIndex && wanted(other).length > 0);
					message = `[city] joined everything wanted in ${group.factions.join(" + ")}` +
						(next >= 0 ? `; once its augments are bought, a later run goes for ${wanted(plan.groups[next]).join(" + ")}.` : ".");
					done = true;
				} else if (flags.dry) {
					message = `[city] --dry: would go for ${todo.join(", ")} next.`;
					done = true;
				} else {
					message = await pursue(ns, player, todo, plan, group);
					if (message.startsWith("[city] joined")) planAt = 0; // refresh: the next faction or group may change
				}
			}
		}

		if (message !== lastMessage) ns.print(message);
		lastMessage = message;
		if (done) {
			if (flags.dry) ns.tprint(message);
			return;
		}
		await ns.sleep(CONFIG.loopMs);
	}
}

/** One step towards the first faction in todo: join it, fly there, or say what we wait for. */
async function pursue(ns, player, todo, plan, group) {
	for (const faction of todo) {
		if (ns.singularity.joinFaction(faction)) {
			notify(ns, "[city]", `joined ${faction}`, "success");
			return `[city] joined ${faction} (for ${plan.needs(group, faction).join(", ")})`;
		}
	}
	const faction = todo[0];
	const augs = plan.needs(group, faction).join(", ");
	const needed = INVITE_MONEY[faction];
	if (player.city === faction) {
		return `[city] in ${faction}, waiting for the invite (needs $${ns.format.number(needed)} on hand; for ${augs})`;
	}
	if (!player.factions.includes("Tian Di Hui") && tianDiHuiRunning(ns)) {
		return `[city] waiting for get-tian-di-hui.js to finish before flying to ${faction}`;
	}
	if (player.money < needed + CONFIG.travelCost) {
		return `[city] next: ${faction} for ${augs}; waiting for $${ns.format.number(needed + CONFIG.travelCost)} (invite + flight)`;
	}
	return ns.singularity.travelToCity(faction)
		? `[city] flew to ${faction}, waiting for the invite (for ${augs})`
		: `[city] flight to ${faction} failed, will retry`;
}

/**
 * Says which city invites to accept this run (toast + terminal line, since a wrong click by hand
 * locks out the rival group). Only when the plan changes; returns the new key.
 */
function announcePlan(ns, plan, groupIndex, joined, wanted, lastKey) {
	const allCities = plan.groups.flatMap((group) => group.factions);
	let key;
	let message;
	if (groupIndex < 0) {
		key = "none";
		message = "City plan: no city faction sells anything you still want, so any city invite is fine to accept.";
	} else {
		const group = plan.groups[groupIndex];
		const want = wanted(group);
		const todo = want.filter((faction) => !joined.has(faction));
		if (todo.length === 0) return lastKey; // already joined everything wanted: nothing to decide
		const augs = want.flatMap((faction) => plan.needs(group, faction));
		const avoid = allCities.filter((faction) => !group.factions.includes(faction) && !joined.has(faction));
		key = `${groupIndex}|${todo.join(",")}`;
		message = `City plan: ${want.join(" + ")} (${augs.join(", ")}); this script joins them for you.` +
			(avoid.length ? ` Don't accept ${avoid.join(", ")} this run (rivals).` : "");
	}
	if (key !== lastKey) notify(ns, "[city]", message, "info", true);
	return key;
}

function printPlan(ns, plan, lockedIndex, groupIndex) {
	ns.tprint("city-factions plan (augments still wanted that only a city sells):");
	plan.groups.forEach((group, index) => {
		const tag = index === lockedIndex ? " [joined this run]" : index === groupIndex ? " [next]" : "";
		const parts = group.factions.map((faction) => {
			const augs = plan.needs(group, faction);
			return `${faction}: ${augs.length ? augs.join(", ") : "-"}`;
		});
		ns.tprint(`  ${index + 1}. ${parts.join("  |  ")}${tag}`);
	});
}

function tianDiHuiRunning(ns) {
	return getAllServers(ns).some((host) => ns.ps(host).some((proc) => proc.filename === CONFIG.tianDiHuiScript));
}

/** Runs the helper (home first, else this server) and returns the plan, or null if it couldn't run. */
async function refreshPlan(ns, cities) {
	const askedAt = Date.now();
	const arg = JSON.stringify({ groups: cities.groups, otherSources: cities.otherSources });
	let pid = ns.exec(CONFIG.helper, "home", 1, arg);
	const here = ns.getHostname();
	if (pid === 0 && here !== "home") {
		ns.scp([CONFIG.helper, ...CONFIG.helperImports], here, "home");
		pid = ns.exec(CONFIG.helper, here, 1, arg);
	}
	if (pid === 0) return null;
	while (ns.isRunning(pid)) await ns.sleep(100);
	try {
		const result = JSON.parse(ns.peek(PLAN_PORT));
		if (result.time < askedAt) return null;
		return { groups: result.groups, needs: (group, faction) => group.needs[faction] ?? [] };
	} catch {
		return null;
	}
}
