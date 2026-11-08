// @ts-check
/** @param {NS} ns **/
import { findPath } from "/utils/find-path.js"
import { getAllServers } from "/utils/get-all-servers.js"

// Servers whose backdoor actually does something (checked against the v3.0.0 game source).
// Lower priority number = more important.
const WORTH_IT = {
	// Hacker faction invites (invite needs the backdoor)
	"CSEC": { priority: 1, faction: "CyberSec", why: "Invite: CyberSec" },
	"avmnite-02h": { priority: 1, faction: "NiteSec", why: "Invite: NiteSec" },
	"I.I.I.I": { priority: 1, faction: "The Black Hand", why: "Invite: The Black Hand" },
	"run4theh111z": { priority: 1, faction: "BitRunners", why: "Invite: BitRunners" },
	"fulcrumassets": { priority: 1, faction: "Fulcrum Secret Technologies", why: "Invite: Fulcrum Secret Technologies (also needs a Fulcrum job + company rep)" },

	// Megacorps: company faction invite needs 300k company rep instead of 400k, and promotions need 25% less rep
	"ecorp": { priority: 2, why: "ECorp faction at 300k rep (not 400k), easier promotions" },
	"megacorp": { priority: 2, why: "MegaCorp faction at 300k rep (not 400k), easier promotions" },
	"b-and-a": { priority: 2, why: "Bachman & Associates faction at 300k rep, easier promotions" },
	"blade": { priority: 2, why: "Blade Industries faction at 300k rep, easier promotions" },
	"nwo": { priority: 2, why: "NWO faction at 300k rep, easier promotions" },
	"clarkinc": { priority: 2, why: "Clarke Incorporated faction at 300k rep, easier promotions" },
	"omnitek": { priority: 2, why: "OmniTek faction at 300k rep, easier promotions" },
	"4sigma": { priority: 2, why: "Four Sigma faction at 300k rep, easier promotions" },
	"kuai-gong": { priority: 2, why: "KuaiGong faction at 300k rep, easier promotions" },
	"fulcrumtech": { priority: 2, why: "Fulcrum Secret Technologies at 300k Fulcrum rep, easier promotions" },

	// Gyms and universities: 10% off every class / training session
	"rothman-uni": { priority: 3, why: "10% off Rothman University classes (Sector-12)" },
	"summit-uni": { priority: 3, why: "10% off Summit University classes (Aevum)" },
	"zb-institute": { priority: 3, why: "10% off ZB Institute classes (Volhaven)" },
	"powerhouse-fitness": { priority: 3, why: "10% off Powerhouse Gym (Sector-12), 'Discount!' achievement" },
	"iron-gym": { priority: 3, why: "10% off Iron Gym (Sector-12)" },
	"crush-fitness": { priority: 3, why: "10% off Crush Fitness (Aevum)" },
	"snap-fitness": { priority: 3, why: "10% off Snap Fitness (Aevum)" },
	"millenium-fitness": { priority: 3, why: "10% off Millenium Fitness (Volhaven)" },

	// Ends the BitNode. Only backdoor it when you are ready to leave.
	"w0r1d_d43m0n": { priority: 0, why: "DESTROYS THE BITNODE. Only when you're ready to finish this run!" },
};

// Other company servers: backdoor makes job promotions there need 25% less rep (no faction attached).
const COMPANY_SERVERS = new Set([
	"helios", "vitalife", "icarus", "univ-energy", "galactic-cyber", "aerocorp", "omnia", "solaris",
	"deltaone", "global-pharm", "nova-med", "lexo-corp", "rho-construction", "alpha-ent", "aevum-police",
	"syscore", "computek", "netlink", "stormtech", "defcomm", "omega-net", "n00dles", "foodnstuff", "joesguns",
]);

const GREEN = "\u001b[32m", YELLOW = "\u001b[33m", RED = "\u001b[31m", CYAN = "\u001b[36m", GREY = "\u001b[90m", RESET = "\u001b[0m";
const TIER_LABEL = { 0: `${RED}[END]${RESET}`, 1: `${GREEN}[FACTION]${RESET}`, 2: `${CYAN}[MEGACORP]${RESET}`, 3: `${YELLOW}[DISCOUNT]${RESET}`, 4: `${GREY}[COMPANY]${RESET}` };

/**
 * Lists servers that still need a backdoor, with the ones worth doing highlighted.
 * Flags: --all also prints commands for servers whose backdoor has no effect.
 */
export async function main(ns) {
	ns.disableLog("ALL");
	const flags = ns.flags([["all", false]]);

	const myLevel = ns.getHackingLevel();
	const myFactions = new Set(ns.getPlayer().factions);

	const ready = [];     // worth it, can backdoor now
	const locked = [];    // worth it, not yet possible
	const minor = [];     // possible now, small or no benefit
	let doneCount = 0;

	for (const host of getAllServers(ns)) {
		const s = ns.getServer(host);
		if (s.purchasedByPlayer || host === "home") continue;

		const reqLevel = s.requiredHackingLevel ?? ns.getServerRequiredHackingLevel(host);
		let info = WORTH_IT[host];
		// Already in the faction this backdoor invites you to: it no longer matters
		if (info?.faction && myFactions.has(info.faction)) info = null;
		if (!info && COMPANY_SERVERS.has(host)) info = { priority: 4, why: "Job promotions need 25% less rep" };

		if (s.backdoorInstalled) {
			if (info) doneCount++;
			continue;
		}

		const entry = { host, reqLevel, info };
		const canDo = s.hasAdminRights && myLevel >= reqLevel;

		if (info && info.priority <= 3) {
			if (canDo) ready.push(entry);
			else {
				const missing = [];
				if (!s.hasAdminRights) missing.push(`root (${s.numOpenPortsRequired ?? "?"} ports)`);
				if (myLevel < reqLevel) missing.push(`hack ${reqLevel} (you: ${myLevel})`);
				entry.missing = missing.join(", ");
				locked.push(entry);
			}
		} else if (canDo) {
			minor.push(entry);
		}
	}

	// Printed bottom-up: the most useful entries end up at the bottom of the terminal, nearest where you read.
	// Within a section, higher priority sorts later; w0r1d_d43m0n (priority 0) goes first, away from the bottom.
	const bottomUp = (a, b) => Number(b.info?.priority === 0) - Number(a.info?.priority === 0)
		|| (b.info?.priority ?? 9) - (a.info?.priority ?? 9) || b.reqLevel - a.reqLevel;
	ready.sort(bottomUp);
	locked.sort(bottomUp);
	minor.sort(bottomUp);

	// tprintf adds no "list-backdoors.js:" prefix, so each command line can be triple-clicked and copied
	const out = (line) => ns.tprintf("%s", line);
	const cmd = (host) => "home; " + findPath(ns, host).slice(1).map(h => `connect ${h}`).join("; ") + "; backdoor";

	const companyMinor = minor.filter(e => e.info);
	const useless = minor.filter(e => !e.info);

	out(`\n${GREY}=== NO EFFECT (${useless.length}): backdoor only allows direct 'connect' ===${RESET}`);
	if (flags.all) {
		for (const e of useless) {
			out(`\n${GREY}${e.host} (hack ${e.reqLevel})${RESET}`);
			out(cmd(e.host));
		}
	} else if (useless.length > 0) {
		out(`${GREY}  Run with --all to list them.${RESET}`);
	}

	if (locked.length > 0) {
		out(`\n${YELLOW}=== WORTH IT LATER (${locked.length}) ===${RESET}`);
		for (const e of locked) {
			out(`  ${TIER_LABEL[e.info.priority]} ${e.host}: ${e.info.why}`);
			out(`  ${GREY}    needs ${e.missing}${RESET}`);
		}
	}

	// Other company servers (25% easier promotions)
	if (companyMinor.length > 0) {
		out(`\n${GREY}=== SMALL BENEFIT (${companyMinor.length}) ===${RESET}`);
		for (const e of companyMinor) {
			out(`\n${TIER_LABEL[4]} ${e.host} (hack ${e.reqLevel}): ${e.info.why}`);
			out(cmd(e.host));
		}
	}

	out(`\n${doneCount} useful backdoor(s) already installed.`);

	out(`\n${GREEN}=== WORTH BACKDOORING NOW (${ready.length}) ===${RESET}`);
	if (ready.length === 0) out("  Nothing useful waiting right now.");
	for (const e of ready) {
		out(`\n${TIER_LABEL[e.info.priority]} ${e.host} (hack ${e.reqLevel}): ${e.info.why}`);
		out(cmd(e.host));
	}
}
