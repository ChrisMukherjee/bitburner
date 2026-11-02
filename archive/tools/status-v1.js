import { loadConfig } from "/utils/config.js";
import { getAllServers } from "/utils/get-all-servers.js";
import { readIncomeRate } from "/utils/income.js";

/**
 * One-screen summary of the run, so you don't have to tail six logs.
 *
 *   run /tools/status.js
 *   alias status='run /tools/status.js'   (absolute path, so it works from any directory)
 *
 * Shows: stage and home RAM, cash and income, current work, faction rep goals with ETAs, the
 * reset advice, Go progress, the city-faction plan, stocks, and which startup.js scripts run.
 *
 * Cheap on purpose (about 5GB): almost everything comes from what the other scripts already
 * post, read with 0GB calls:
 *   port 23  faction rep goals        (workers/faction-goals.js, via faction-work.js)
 *   port 24  batcher income            (utils/income.js)
 *   port 25  city-faction plan         (workers/city-plan.js, via city-factions.js)
 *   port 26  stock summary             (stock-trader.js, every 10 ticks)
 *   data/aug-plan.json   reset advice + rep rates (buy-augs.js --plan, every 10 min via auto-reset.js)
 *   data/go-bonus.json   Go bonus history (go/ipvgo-bot.js)
 *   startup.js and go/ipvgo-bot.js are read as text for their script list, stage thresholds and
 *   Go rotation, so this never falls out of step with them.
 * Rep ETAs use the auto-reset snapshots; between those it keeps its own in data/status-rep.json.
 */
const GOALS_PORT = 23;
const CITY_PORT = 25;
const STOCK_SUMMARY_PORT = 26;
const PLAN_FILE = "data/aug-plan.json";
const GO_FILE = "data/go-bonus.json";
const REP_FILE = "data/status-rep.json";
// Same defaults as go/ipvgo-bot.js (--span, --level-off, --min-win-rate).
const GO_SETTINGS = { span: 10, levelOff: 0.25, minWinRate: 0.2 };
const RATE_GAP = { minMs: 120_000, maxMs: 3 * 3600_000 };

/** @param {NS} ns */
export async function main(ns) {
	const player = ns.getPlayer();
	const now = Date.now();
	const lastReset = ns.getResetInfo().lastAugReset;
	const money = (amount) => "$" + ns.format.number(amount);
	const ago = (time) => (time ? `${ns.format.time(Math.max(0, now - time))} ago` : "never");
	const out = [];

	const processes = getAllServers(ns).flatMap((host) => ns.ps(host).map((proc) => ({ ...proc, host })));

	// --- Stage, RAM, money ---
	const startupText = ns.read("startup.js");
	const config = loadConfig(ns);
	const thresholds = config.startupStages;
	const homeRam = ns.getServerMaxRam("home");
	const stageNames = Object.keys(thresholds);
	const stage = stageNames.filter((name) => homeRam >= thresholds[name]).pop() ?? "?";
	const nextStage = stageNames.find((name) => thresholds[name] > homeRam);
	const income = readIncomeRate(ns);
	out.push(`=== STATUS (run ${ns.format.time(now - lastReset)} old, hacking ${player.skills.hacking}) ===`);
	out.push(`Stage ${stage} | home ${ns.format.ram(ns.getServerUsedRam("home"))} / ${ns.format.ram(homeRam)} used` +
		(nextStage ? ` | ${nextStage} at ${ns.format.ram(thresholds[nextStage])}` : ""));
	out.push(`Cash ${money(player.money)} | income ${money(income.perSecond)}/s (${income.source})`);

	// --- Current work and faction goals ---
	const work = ns.singularity.getCurrentWork();
	out.push(`Doing: ${describeWork(work)}`);

	const plan = readJson(ns, PLAN_FILE);
	const goalsPost = peekJson(ns, GOALS_PORT);
	const joined = new Set(player.factions);
	const rep = Object.fromEntries(player.factions.map((faction) => [faction, ns.singularity.getFactionRep(faction)]));
	const rates = repRates(ns, rep, plan, now, lastReset);
	if (!goalsPost?.goals) {
		out.push("Faction goals: none posted yet (faction-work.js posts them on port 23)");
	} else {
		const open = Object.entries(goalsPost.goals)
			.filter(([faction, goal]) => joined.has(faction) && goal.rep > 0 && rep[faction] < goal.rep);
		const working = work?.type === "FACTION" ? work.factionName : "";
		out.push(`Faction goals (posted ${ago(goalsPost.time)})${open.length ? ":" : ": every joined faction is at its goal"}`);
		// The one being worked first, then the rest in faction-work's order.
		open.sort(([first], [second]) => (second === working) - (first === working));
		for (const [faction, goal] of open.slice(0, 5)) {
			const missing = goal.rep - rep[faction];
			const rate = rates.perSecond[faction] ?? 0;
			const eta = rate > 0 ? `ETA ~${ns.format.time((missing / rate) * 1000)} at ${ns.format.number(rate * 60)}/min` : "no rate yet";
			out.push(`  ${faction === working ? "*" : " "} ${faction}: ${ns.format.number(rep[faction])} / ${ns.format.number(goal.rep)} ` +
				`for ${goal.aug} (${goal.count} left) | ${eta}`);
		}
		if (open.length > 5) out.push(`    ...and ${open.length - 5} more`);
	}

	// --- Reset advice ---
	const autoReset = processes.find((proc) => proc.filename === "singularity/auto-reset.js");
	if (!plan?.decision || plan.checkedAt < lastReset) {
		out.push("Reset: no advice for this run yet (auto-reset.js writes it every 10 min; or run `augs`)");
	} else {
		out.push(`Reset: ${plan.decision.reset ? "RESET NOW" : "wait"} (checked ${ago(plan.checkedAt)}): ${plan.decision.reason}`);
		out.push(`  ${plan.queued.length} bought + ${plan.affordable.length} affordable for ${money(plan.cost)}` +
			(autoReset ? (autoReset.args.includes("--dry") ? " | auto-reset is in --dry: it won't reset by itself" : " | auto-reset will act on it") : " | auto-reset not running"));
	}

	// --- Go ---
	const goBot = processes.find((proc) => proc.filename === "go/ipvgo-bot.js");
	const goData = readJson(ns, GO_FILE) ?? {};
	const focus = goBot ? argValue(goBot.args, "--opponent") ?? "Netburners" : null;
	const rotation = parseList(ns.read("go/ipvgo-bot.js"), "ROTATION");
	const order = focus ? (goBot.args.includes("--no-rotate") ? [focus] : [focus, ...rotation.filter((name) => name !== focus)]) : rotation;
	const playing = focus ? order.find((name) => goProgress(goData[name]) === "climbing") ?? focus : null;
	out.push(`Go: ${goBot ? `bot running, focus ${focus}, now playing ${playing}` : "bot not running"}`);
	const goParts = order.filter((name) => goData[name]).map((name) => {
		const entry = goData[name];
		const recent = entry.wins.slice(-GO_SETTINGS.span);
		const winRate = recent.length ? Math.round((100 * recent.filter(Boolean).length) / recent.length) : 0;
		return `${name} ${ns.format.number(entry.bonus, 3)}% (${goProgress(entry)}, ${winRate}% wins)`;
	});
	if (goParts.length) out.push(`  ${goParts.join(" | ")}`);

	// --- City factions ---
	const city = peekJson(ns, CITY_PORT);
	if (!city?.groups) {
		out.push("City factions: no plan posted (city-factions.js posts it on port 25)");
	} else {
		const wanted = (group) => group.factions.filter((faction) => (group.needs[faction] ?? []).length > 0);
		const lockedGroup = city.groups.find((group) => group.factions.some((faction) => joined.has(faction)));
		const group = lockedGroup ?? city.groups.find((candidate) => wanted(candidate).length > 0);
		if (!group) {
			out.push("City factions: nothing left worth buying from any city");
		} else {
			const parts = wanted(group).map((faction) =>
				`${faction}${joined.has(faction) ? " (joined)" : ""}: ${group.needs[faction].join(", ")}`);
			out.push(`City factions (${lockedGroup ? "this run's group" : "next group"}, plan ${ago(city.time)}): ` +
				(parts.length ? parts.join(" | ") : `${group.factions.join(" + ")}, nothing left to buy`));
		}
	}

	// --- Stocks ---
	const stocks = peekJson(ns, STOCK_SUMMARY_PORT);
	const trader = processes.find((proc) => proc.filename === "stock-trader.js");
	if (!trader) {
		out.push("Stocks: stock-trader.js not running");
	} else if (!stocks) {
		out.push("Stocks: trader running, no summary yet (it posts every 10 market ticks)");
	} else {
		out.push(`Stocks (${ago(stocks.time)}): ${stocks.mode}, ${stocks.positions} positions worth ${money(stocks.value)} ` +
			`(unrealized ${money(stocks.unrealized)}), profit since install ${money(stocks.earned)}`);
	}

	// --- Scripts startup.js manages ---
	const entries = parseStartupScripts(startupText);
	const level = stageNames.indexOf(stage);
	const skipped = new Set(config.startupSkip); // turned off in the config: not "stopped"
	const inStage = entries.filter((entry) => !skipped.has(entry.script) &&
		stageNames.indexOf(entry.stage) <= level && (!entry.until || stageNames.indexOf(entry.until) > level));
	const running = [];
	const stopped = [];
	// Every script startup.js knows that is running (any stage); missing only counts for this stage's.
	const inStageScripts = new Set(inStage.map((entry) => entry.script));
	for (const script of new Set(entries.map((entry) => entry.script))) {
		const copies = processes.filter((proc) => proc.filename === script);
		const name = script.replace(/^.*\//, "").replace(/\.js$/, "");
		if (copies.length === 0) {
			if (inStageScripts.has(script)) stopped.push(name);
			continue;
		}
		running.push(name + (copies.some((proc) => proc.host === "home") ? "" : `@${copies[0].host}`));
	}
	out.push(`Running: ${running.join(", ") || "-"}`);
	if (stopped.length) out.push(`Not running: ${stopped.join(", ")} (some exit when done; \`run startup.js\` restarts the rest)`);

	ns.tprint("\n" + out.join("\n"));
}

function describeWork(work) {
	if (!work) return "nothing (idle)";
	switch (work.type) {
		case "FACTION": return `${work.factionWorkType} work for ${work.factionName}`;
		case "COMPANY": return `job at ${work.companyName}`;
		case "CLASS": return `${work.classType} at ${work.location}`;
		case "CREATE_PROGRAM": return `writing ${work.programName}`;
		case "CRIME": return `crime: ${work.crimeType}`;
		case "GRAFTING": return `grafting ${work.augmentation}`;
		default: return work.type;
	}
}

/**
 * Rep per second per faction. Our own snapshot (data/status-rep.json) when it's 2 min to 3h old,
 * else the rates buy-augs.js measured for data/aug-plan.json. The snapshot only moves on once it's
 * 2 minutes old, so running status often still builds up a usable window.
 */
function repRates(ns, rep, plan, now, lastReset) {
	const planRates = plan?.perSecond && plan.time >= lastReset ? plan.perSecond : {};
	const previous = readJson(ns, REP_FILE);
	const valid = previous?.rep && previous.time >= lastReset && now - previous.time <= RATE_GAP.maxMs;
	if (valid && now - previous.time < RATE_GAP.minMs) {
		return { perSecond: { ...planRates, ...previous.perSecond } };
	}
	const perSecond = {};
	if (valid) {
		const seconds = (now - previous.time) / 1000;
		for (const [faction, value] of Object.entries(rep)) {
			const before = previous.rep[faction];
			if (before !== undefined && value >= before) perSecond[faction] = (value - before) / seconds;
		}
	}
	ns.write(REP_FILE, JSON.stringify({ time: now, rep, perSecond }), "w");
	return { perSecond: { ...planRates, ...perSecond } };
}

// "climbing" / "levelled" / "losing", as go/ipvgo-bot.js decides it.
function goProgress(entry) {
	const { span, levelOff, minWinRate } = GO_SETTINGS;
	if (!entry || entry.gains.length < span * 2) return "climbing";
	const results = entry.wins.slice(-span);
	if (results.filter(Boolean).length / results.length < minWinRate) return "losing";
	const recent = entry.gains.slice(-span).reduce((sum, gain) => sum + gain, 0) / span;
	return recent < entry.peak * levelOff ? "levelled" : "climbing";
}

/** [{ stage, script, until }] from startup.js's SCRIPTS list. */
function parseStartupScripts(text) {
	return [...text.matchAll(/\{\s*stage:\s*"(\w+)",\s*script:\s*"([^"]+)"([^\n]*)/g)].map((match) => ({
		stage: match[1], script: match[2], until: match[3].match(/until:\s*"(\w+)"/)?.[1],
	}));
}

/** The quoted strings in `const NAME = [...]`. */
function parseList(text, name) {
	const body = text.match(new RegExp(`const ${name}\\s*=\\s*\\[([^\\]]*)\\]`))?.[1] ?? "";
	return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function argValue(args, flag) {
	const index = args.indexOf(flag);
	return index >= 0 && index + 1 < args.length ? String(args[index + 1]) : null;
}

function readJson(ns, file) {
	try {
		return JSON.parse(ns.read(file) || "null");
	} catch {
		return null;
	}
}

function peekJson(ns, port) {
	const data = ns.peek(port);
	if (data === "NULL PORT DATA") return null;
	if (typeof data === "object") return data;
	try {
		return JSON.parse(data);
	} catch {
		return null;
	}
}
