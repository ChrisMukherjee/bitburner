// @ts-check
import { loadConfig } from "/utils/config.js";
import { getAllServers } from "/utils/get-all-servers.js";
import { readIncomeRate } from "/utils/income.js";
import { routeStep } from "/utils/bitnode-route.js";
import { bitnodeMults } from "/utils/bitnode-mults.js";
import { hasSingularity } from "/utils/singularity.js";
import { goOrder } from "/go/go-plan.js";
import { bladeburnerAccess } from "/utils/bladeburner.js";
import { hackingSegments, bladeburnerSegments, routeLines } from "/utils/route-progress.js";

/**
 * One-screen summary of the run, so you don't have to tail six logs.
 *
 *   run /tools/status.js
 *   alias status='run /tools/status.js'   (absolute path, so it works from any directory)
 *
 * Shows: stage and home RAM, cash and income, Intelligence (only once above 0), current work, faction rep goals with ETAs, the
 * reset advice, how close the BitNode is to ending per route (hacking: Daedalus, The Red Pill, w0r1d_d43m0n; Bladeburner: Black Ops,
 * rank; the route node-eta.js picked in full, the other on one line; kill switch status.routeProgress; utils/route-progress.js) and
 * the next BitNode on the route, Go progress, the city-faction plan, stocks, one block per mechanic (gang ...), and which
 * startup.js scripts run.
 *
 * Cheap on purpose (about 5GB): almost everything comes from what the other scripts already
 * post, read with 0GB calls:
 *   port 23  faction rep goals        (singularity/workers/faction-goals.js, via player-work.js)
 *   port 24  batcher income            (utils/income.js)
 *   port 25  city-faction plan         (singularity/workers/city-plan.js, via player-work.js)
 *   port 26  stock summary             (stock-trader.js, its first tick, then every 10 ticks)
 *   port 28  gang summary              (gang/gang-manager.js, every gang update; any mechanic
 *            manager listed in MECHANIC_PORTS posts ready-made lines the same way)
 *   port 36  Bladeburner state + lines (bladeburner/bb-manage.js and bb-pass.js, one-shots)
 *   data/aug-plan.json   reset advice + rep rates, Red Pill rep/price and Daedalus invite needs
 *                        (buy-augs.js --plan, every 10 min via auto-reset.js)
 *   data/go-bonus.json   Go bonus history (go/go-bot.js)
 *   startup.js and go/go-bot.js are read as text for their script list, stage thresholds and
 *   Go rotation, so this never falls out of step with them.
 * Rep ETAs use the auto-reset snapshots; between those it keeps its own in data/status-rep.json.
 */
const GOALS_PORT = 23;
const CITY_PORT = 25;
const STOCK_SUMMARY_PORT = 26;
// Ports where mechanic managers post { time, title, script, lines }; add one per mechanic folder.
const MECHANIC_PORTS = [28, 36];
const PLAN_FILE = "data/aug-plan.json";
const GO_FILE = "data/go-bonus.json";
const REP_FILE = "data/status-rep.json";
const DAEMON = "w0r1d_d43m0n";
const RED_PILL = "The Red Pill";
// Same defaults as go/go-bot.js (--span, --level-off, --min-win-rate).
const GO_SETTINGS = { span: 10, levelOff: 0.25, minWinRate: 0.2 };
const RATE_GAP = { minMs: 120_000, maxMs: 3 * 3600_000 };

/** @param {NS} ns */
export async function main(ns) {
	const player = ns.getPlayer();
	const now = Date.now();
	const resetInfo = ns.getResetInfo();
	const lastReset = resetInfo.lastAugReset;
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
	// Intelligence only grows with Source-File 5 (or by other means); stay quiet at 0. Plain player fields, no extra RAM.
	if (player.skills.intelligence > 0) {
		out.push(`Intelligence ${player.skills.intelligence} (${ns.format.number(player.exp.intelligence)} exp)`);
	}

	// --- Current work and faction goals ---
	// Work and rep need the Singularity API (BitNode 4 or Source-File 4); without it those lines say so.
	// No extra RAM: getResetInfo is already called above.
	const sf4 = hasSingularity(ns);
	const work = sf4 ? ns.singularity.getCurrentWork() : null;
	// Bladeburner actions are not "work" to getCurrentWork; bb-pass.js posts the running one on port 36.
	const bbAction = peekJson(ns, 36)?.action;
	const bbFresh = bbAction && Date.now() - (bbAction.time ?? 0) < 10 * 60_000;
	const doing = !work && bbFresh ? `Bladeburner: ${bbAction.name} (${bbAction.type})` : sf4 ? describeWork(work) : null;
	out.push(`Doing: ${doing ?? "unknown (needs BitNode 4 or Source-File 4)"}`);

	const plan = readJson(ns, PLAN_FILE);
	const goalsPost = peekJson(ns, GOALS_PORT);
	const joined = new Set(player.factions);
	const rep = Object.fromEntries(player.factions.map((faction) => [faction, sf4 ? ns.singularity.getFactionRep(faction) : 0]));
	const rates = repRates(ns, rep, plan, now, lastReset);
	if (!sf4) {
		out.push("Faction goals: need BitNode 4 or Source-File 4 (player-work.js posts them)");
	} else if (!goalsPost?.goals) {
		out.push("Faction goals: none posted yet (player-work.js posts them on port 23)");
	} else {
		const open = Object.entries(goalsPost.goals)
			.filter(([faction, goal]) => joined.has(/** @type {any} */ (faction)) && goal.rep > 0 && rep[faction] < goal.rep);
		const working = work?.type === "FACTION" ? work.factionName : "";
		out.push(`Faction goals (posted ${ago(goalsPost.time)})${open.length ? ":" : ": every joined faction is at its goal"}`);
		// The one being worked first, then the rest in player-work's order.
		open.sort(([first], [second]) => Number(second === working) - Number(first === working));
		for (const [faction, goal] of open.slice(0, 5)) {
			const missing = goal.rep - rep[faction];
			const rate = rates.perSecond[faction] ?? 0;
			const eta = rate > 0 ? `ETA ~${ns.format.time((missing / rate) * 1000)} at ${ns.format.number(rate * 60)}/min` : "no rate yet";
			out.push(`  ${faction === working ? "*" : " "} ${faction}: ${ns.format.number(rep[faction])} / ${ns.format.number(goal.rep)} ` +
				`for ${goal.aug} (${goal.count} left${goal.skipped ? `, ${goal.skipped} out of reach` : ""}) | ${eta}`);
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

	// --- BitNode: Daedalus -> The Red Pill -> w0r1d_d43m0n -> next BitNode ---
	const node = resetInfo.currentNode;
	const destroyer = processes.find((proc) => proc.filename === "singularity/auto-destroy.js");
	const forcedBN = destroyer ? argValue(destroyer.args, "--bn") : null;
	const routed = routeStep(ns, config, bitnodeMults(ns));
	const step = routed && routed.source !== "suggestion-only" ? routed : null; // a mere suggestion destroys nothing
	const nextBN = forcedBN ? `BitNode ${forcedBN} (auto-destroy --bn)`
		: step ? `BitNode ${step.bitNode} (${step.source === "route" ? "route" : "plan"}: SF${step.bitNode}.${step.level})`
		: routed ? `none set (you pick; the plan suggests BitNode ${routed.bitNode}: ${routed.why})` : "none, bitnodeRoute is done (you pick)";
	const sfAfter = (resetInfo.ownedSF.get(node) ?? 0) + 1;
	out.push(`BitNode ${node}: destroying gives SF${node}.${sfAfter}, next ${nextBN} | auto-destroy ` +
		(destroyer ? (destroyer.args.includes("--dry") ? "running in --dry" : "running") : "not running"));
	const redPill = plan?.checkedAt >= lastReset ? plan.bitnode?.redPill : null;
	const planFresh = plan?.checkedAt >= lastReset;
	const bbPost = peekJson(ns, 36);
	const verdict = bbPost?.plan && now - (bbPost.plan.time ?? 0) < 30 * 60_000 ? bbPost.plan : null; // node-eta.js' route verdict
	const showBladeburner = config.status?.routeProgress !== false && bladeburnerAccess(ns).available;
	const installedCount = resetInfo.ownedAugs.size;
	const daemonExists = ns.serverExists(DAEMON);
	const fmt = { number: (value) => ns.format.number(value), int: (value) => Math.round(value).toLocaleString("en-US"), time: (ms) => ns.format.time(ms), money };
	const hacking = hackingSegments({
		hacking: player.skills.hacking, installed: installedCount,
		have: { money: player.money, installed: installedCount, skills: { ...player.skills } },
		daedalusJoined: joined.has("Daedalus"), daedalusRep: rep.Daedalus ?? 0, repPerSecond: rates.perSecond.Daedalus ?? 0,
		invite: planFresh ? plan.bitnode?.daedalusInvite ?? null : null, redPill,
		redPillInstalled: resetInfo.ownedAugs.has(RED_PILL), redPillBought: !!plan?.queued?.includes(RED_PILL) && planFresh,
		daemon: {
			exists: daemonExists, root: daemonExists && ns.hasRootAccess(DAEMON),
			level: daemonExists ? ns.getServerRequiredHackingLevel(DAEMON) : Number(verdict?.daemonLevel) || null,
		},
	}, fmt);
	const bladeburner = showBladeburner ? bladeburnerSegments({
		state: bbPost?.state && now - (bbPost.stateTime ?? 0) < 15 * 60_000 ? bbPost.state : "off",
		progress: bbPost?.progress ?? null, hold: verdict?.hold === true && verdict?.route === "combat", ago,
	}, fmt) : null;
	out.push(...routeLines({
		route: verdict?.route === "hacking" || verdict?.route === "combat" ? verdict.route : null,
		routeAgo: verdict ? ` (node-eta.js ${verdict.prior ? "first guess from the BitNode's multipliers" : "estimate"}, ${ago(verdict.time)})` : "", hacking, bladeburner, fallback: config.bladeburner?.route,
	}));
	if (resetInfo.ownedAugs.has(RED_PILL) && daemonExists) {
		const needed = ns.getServerRequiredHackingLevel(DAEMON);
		if (player.skills.hacking >= needed && ns.hasRootAccess(DAEMON) && !step && !forcedBN) {
			out.push(`  READY, nothing is destroyed until you pick a BitNode: run /singularity/next-bitnode.js <n> (or add to bitnodeRoute)`);
		}
	}

	// --- Go ---
	const goBot = processes.find((proc) => proc.filename === "go/go-bot.js");
	const goData = readJson(ns, GO_FILE) ?? {};
	const focus = goBot ? argValue(goBot.args, "--opponent") ?? "Netburners" : null;
	const rotation = parseList(ns.read("go/go-bot.js"), "ROTATION");
	const manualRotation = goBot ? argValue(goBot.args, "--rotation") : null;
	const goPlan = goOrder(ns, config, focus ?? "Netburners", {
		noPlan: !!goBot?.args.includes("--no-plan"),
		rotation: manualRotation ? manualRotation.split(",").map((name) => name.trim()) : null,
	});
	const order = focus ? (goBot.args.includes("--no-rotate") ? [focus] : goPlan.order) : rotation;
	const playing = focus ? order.find((name) => goProgress(goData[name]) === "climbing") ?? focus : null;
	out.push(`Go: ${goBot ? `bot running, focus ${focus}, now playing ${playing}` : "bot not running"}` +
		(goBot && goPlan.boosted.length ? ` | plan boosts ${goPlan.boosted.map((entry) => `${entry.opponent} (${entry.why})`).join(", ")}` : ""));
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
		out.push("City factions: no plan posted (player-work.js posts it on port 25)");
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
	out.push(...stockLines(peekJson(ns, STOCK_SUMMARY_PORT), !!processes.find((proc) => proc.filename === "stocks/stock-trader.js"), {
		money, percent: (value, digits = 0) => ns.format.percent(value, digits), time: (ms) => ns.format.time(ms), ago: (time) => ago(time),
	}));

	// --- Mechanics (gang/, later bladeburner/, corp/ ...): their managers post ready-made lines ---
	for (const port of MECHANIC_PORTS) {
		const post = peekJson(ns, port);
		if (!post?.lines) continue;
		// One-shot managers (oneShot: true in the post) only run for a moment, so not running is normal for them.
		const running = post.oneShot || processes.some((proc) => proc.filename === post.script);
		if (!running) {
			out.push(`${post.title}: ${post.script} isn't running (run \`startup\`)`);
			continue;
		}
		out.push(`${post.title} (${ago(post.time)}): ${post.lines[0]}`);
		for (const line of post.lines.slice(1)) out.push(`  ${line}`);
	}

	// --- Darknet: the manager only runs once DarkscapeNavigator.exe is owned (darknet/ready.js) ---
	out.push("Darknet: " + darknetLine(ns, processes, stage, stageNames));

	// --- Scripts startup.js manages ---
	const entries = parseStartupScripts(startupText);
	const level = stageNames.indexOf(stage);
	const skipped = new Set(config.startupSkip); // turned off in the config: not "stopped"
	// One-shots run for a moment now and then, so not running is normal for them.
	const inStage = entries.filter((entry) => !entry.oneShot && !skipped.has(entry.script) &&
		stageNames.indexOf(entry.stage) <= level && (!entry.until || stageNames.indexOf(entry.until) > level));
	const running = [];
	const stopped = []; // should be running: startup.js restarts them
	const waiting = []; // have a ready check that says there is no work yet
	// Every script startup.js knows that is running (any stage); missing only counts for this stage's.
	const inStageScripts = new Set(inStage.map((entry) => entry.script));
	for (const script of new Set(entries.map((entry) => entry.script))) {
		const entry = entries.find((candidate) => candidate.script === script);
		const copies = processes.filter((proc) => proc.filename === script);
		const name = script.replace(/^.*\//, "").replace(/\.js$/, "");
		if (copies.length === 0) {
			if (inStageScripts.has(script)) (entry.hasReady ? waiting : stopped).push(name);
			continue;
		}
		running.push(name + (copies.some((proc) => proc.host === "home") ? "" : `@${copies[0].host}`));
	}
	out.push(`Running: ${running.join(", ") || "-"}`);
	if (waiting.length) out.push(`Waiting for work: ${waiting.join(", ")} (startup.js starts them when there is something to do; nothing for you to do)`);
	if (stopped.length) out.push(`Stopped: ${stopped.join(", ")} (startup.js restarts them within a minute; if they stay down, run \`startup\`)`);

	ns.tprint("\n" + out.join("\n"));
}

/**
 * The status lines for the stock trader (stocks/stock-trader.js posts the summary on port 26). A trader that is up but has
 * no summary is only seconds old (it posts on its first market tick); one waiting for the TIX API says so and what it
 * needs. With a summary: positions and profit, then how it is doing since its window started (profit per hour, share of
 * capital invested, drawdown, costs) when it has been measuring long enough to mean something.
 * @param {any} stocks the summary, or null
 * @param {boolean} running whether stocks/stock-trader.js is in the process list
 * @param {{ money: (n: number) => string, percent: (n: number, digits?: number) => string, time: (ms: number) => string, ago: (t: number) => string }} fmt
 */
export function stockLines(stocks, running, fmt) {
	if (!running) return ["Stocks: stock-trader.js not running"];
	if (!stocks) return ["Stocks: trader just started, first summary on its next market tick (a few seconds)"];
	if (stocks.mode === "waiting") {
		return [`Stocks (${fmt.ago(stocks.time)}): waiting for the ${stocks.waitingFor}, which costs ${fmt.money(stocks.cost)} ` +
			`(cash ${fmt.money(stocks.cash)}, ${fmt.money(stocks.reserve)} stays in reserve)`];
	}
	const lines = [`Stocks (${fmt.ago(stocks.time)}): ${stocks.mode}, ${stocks.positions} positions worth ${fmt.money(stocks.value)} ` +
		`(unrealized ${fmt.money(stocks.unrealized)}), profit since install ${fmt.money(stocks.earned)}`];
	const measure = stocks.measure;
	if (measure && measure.sinceMs >= 600_000) {
		lines.push(`  last ${fmt.time(measure.sinceMs)}: ${fmt.money(measure.perHour)}/h (${fmt.percent(measure.returnPerHour, 1)}/h of working capital), ` +
			`invested ${fmt.percent(measure.invested)}, idle ${fmt.percent(measure.idle)}` +
			(measure.heldBack > 0.01 ? `, held back for buyers ${fmt.percent(measure.heldBack)}` : "") +
			`, max drawdown ${fmt.money(measure.maxDrawdown)}, trading costs ${fmt.money(measure.costs)}` +
			(measure.capture === null || measure.capture === undefined ? "" : `, drift captured ${fmt.percent(measure.capture)} of the forecast`));
	}
	return lines;
}

export function describeWork(work) {
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

/**
 * One line on the darknet manager: running, or why not. It starts at the "mid" stage and only once
 * DarkscapeNavigator.exe is on home (darknet/ready.js), so a missing program is the usual reason.
 * @param {NS} ns
 * @param {{ filename: string }[]} processes every running script
 * @param {string} stage home-RAM stage name
 * @param {string[]} stageNames stage names in order
 */
export function darknetLine(ns, processes, stage, stageNames) {
	if (processes.some((proc) => proc.filename === "darknet/dnet-manager.js")) return "dnet-manager running (details: tail darknet/dnet-manager.js)";
	if (!ns.fileExists("DarkscapeNavigator.exe", "home")) {
		return "not started: DarkscapeNavigator.exe isn't on home yet (buy-programs buys it with the Singularity API, otherwise buy it on the darkweb)";
	}
	if (stageNames.indexOf(stage) < stageNames.indexOf("mid")) return `not started: waits for the mid stage (home ${stage} now)`;
	return "dnet-manager isn't running (startup.js starts it within a minute; if it stays down, run `startup`)";
}

// "climbing" / "levelled" / "losing", as go/go-bot.js decides it.
export function goProgress(entry) {
	const { span, levelOff, minWinRate } = GO_SETTINGS;
	if (!entry || entry.gains.length < span * 2) return "climbing";
	const results = entry.wins.slice(-span);
	if (results.filter(Boolean).length / results.length < minWinRate) return "losing";
	const recent = entry.gains.slice(-span).reduce((sum, gain) => sum + gain, 0) / span;
	return recent < entry.peak * levelOff ? "levelled" : "climbing";
}

/** [{ stage, script, until, oneShot, hasReady }] from startup.js's SCRIPTS list (one entry per line, keys in any order). */
export function parseStartupScripts(text) {
	return [...text.matchAll(/^[ \t]*\{[^\n]*\bstage:\s*"(\w+)"[^\n]*$/gm)]
		.filter((line) => /\bscript:\s*"[^"]+"/.test(line[0]))
		.map((line) => ({
			stage: line[1], script: line[0].match(/\bscript:\s*"([^"]+)"/)?.[1], until: line[0].match(/\buntil:\s*"(\w+)"/)?.[1],
			oneShot: /\boneShot:\s*true/.test(line[0]),
			hasReady: /\bready:/.test(line[0]),
		}));
}

/** The quoted strings in `const NAME = [...]`. */
export function parseList(text, name) {
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
