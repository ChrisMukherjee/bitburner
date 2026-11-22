// tools/status.js main: the screen a player reads. Drives main with a fake game and checks what it says about stage,
// work, reset advice, goals, route progress and which startup scripts are up, down or waiting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeWorld } from "./support/fake-world.mjs";
import { main } from "/tools/status.js";

const NOW = 1_700_000_000_000;
const HOUR = 3600_000;

function statusRun({ homeRam = 64, player = {}, files = {}, ports = {}, procs = [], resetInfo = {}, overrides = {} } = {}) {
	// eslint-disable-next-line prefer-const
	let world;
	world = fakeWorld({
		homeRam, files, ports, servers: { n00dles: { ram: 8 } },
		overrides: {
			getPlayer: () => ({
				money: 5e6, factions: [], skills: { hacking: 120, intelligence: 0 }, exp: { intelligence: 0 }, ...player,
			}),
			getResetInfo: () => ({
				currentNode: 1, ownedSF: new Map(), lastAugReset: NOW - 2 * HOUR, lastNodeReset: NOW - 5 * HOUR,
				ownedAugs: new Map(), bitNodeOptions: {}, ...resetInfo,
			}),
			getServerRequiredHackingLevel: () => 3000,
			serverExists: () => false,
			getTotalScriptIncome: () => [0, 0],
			// Like the game: a port holds objects, not their JSON text.
			peek: (port) => {
				const raw = world.ns.ports[port];
				if (raw === undefined) return "NULL PORT DATA";
				try { return JSON.parse(raw); } catch { return raw; }
			},
			format: { number: (v) => String(Math.round(v)), time: (ms) => `${Math.round(ms / 60000)}m`, ram: (gb) => `${gb}GB`, percent: (v) => `${Math.round(v * 100)}%` },
			...overrides,
		},
	});
	for (const [script, host, args] of procs) world.start(script, host ?? "home", args ?? []);
	return world;
}

async function run(options) {
	const realNow = Date.now;
	Date.now = () => NOW;
	try {
		const world = statusRun(options);
		await main(world.ns);
		return world.ns.terminal.join("\n");
	} finally {
		Date.now = realNow;
	}
}

test("a fresh run shows stage, cash and no Intelligence line", async () => {
	const text = await run({});
	assert.match(text, /=== STATUS \(run 120m old, hacking 120\) ===/);
	assert.match(text, /Stage \S+ \| home/);
	assert.match(text, /Cash \$5000000|Cash \$5\d+/);
	assert.doesNotMatch(text, /Intelligence/, "stays quiet at 0 Intelligence");
});

const sf4 = { ownedSF: new Map([[4, 3]]) };
const withSingularity = (extra = {}) => ({
	resetInfo: sf4,
	overrides: {
		singularity: {
			getCurrentWork: () => null,
			getFactionRep: () => 0,
			...(extra.singularity ?? {}),
		},
		...extra.overrides,
	},
});

test("without Singularity it says work and goals are unknown rather than guessing", async () => {
	const text = await run({});
	assert.match(text, /Doing: unknown \(needs BitNode 4 or Source-File 4\)/);
	assert.match(text, /Faction goals: need BitNode 4 or Source-File 4/);
});

test("Intelligence is shown once it is above 0", async () => {
	const text = await run({ player: { skills: { hacking: 100, intelligence: 7 }, exp: { intelligence: 1234 } } });
	assert.match(text, /Intelligence 7 \(1234 exp\)/);
});

test("faction goals list the faction being worked first, mark it, and say 'no rate yet' without a measured rate", async () => {
	const goals = { goals: { CyberSec: { rep: 1000, aug: "Cranial Signal Processors", count: 2 }, NiteSec: { rep: 5000, aug: "Neural-Retention Enhancement", count: 1, skipped: 3 } }, time: NOW - 60_000 };
	const text = await run({
		player: { factions: ["CyberSec", "NiteSec"] }, ports: { 23: goals },
		...withSingularity({
			singularity: {
				getCurrentWork: () => ({ type: "FACTION", factionName: "NiteSec", factionWorkType: "hacking" }),
				getFactionRep: (faction) => (faction === "CyberSec" ? 400 : 1000),
			},
		}),
	});
	assert.match(text, /Doing: hacking work for NiteSec/);
	const lines = text.split("\n");
	const nite = lines.findIndex((line) => /\* NiteSec: 1000 \/ 5000 for Neural-Retention Enhancement \(1 left, 3 out of reach\) \| no rate yet/.test(line));
	const cyber = lines.findIndex((line) => /^\s{3}CyberSec: 400 \/ 1000/.test(line) || /\s CyberSec: 400 \/ 1000/.test(line));
	assert.ok(nite >= 0 && cyber > nite, `the faction being worked comes first and carries the *:\n${text}`);
});

test("a goal already reached drops out, and when all are reached it says so", async () => {
	const goals = { goals: { CyberSec: { rep: 1000, aug: "X", count: 1 } }, time: NOW };
	const text = await run({ player: { factions: ["CyberSec"] }, ports: { 23: goals }, ...withSingularity({ singularity: { getFactionRep: () => 1500 } }) });
	assert.match(text, /every joined faction is at its goal/);
	assert.doesNotMatch(text, /CyberSec: 1500/);
});

test("rep ETA comes from the measured rate in the reset plan", async () => {
	const goals = { goals: { CyberSec: { rep: 1000, aug: "X", count: 1 } }, time: NOW };
	const plan = { checkedAt: NOW - 600_000, time: NOW - 600_000, perSecond: { CyberSec: 2 }, decision: { reset: false, reason: "waiting for more rep" }, queued: [], affordable: [], cost: 0 };
	const text = await run({
		player: { factions: ["CyberSec"] }, ports: { 23: goals }, files: { "data/aug-plan.json": JSON.stringify(plan) },
		...withSingularity({ singularity: { getFactionRep: () => 400 } }),
	});
	// 600 missing at 2/s is 300 s = 5 min, and 2/s is 120/min
	assert.match(text, /CyberSec: 400 \/ 1000 for X \(1 left\) \| ETA ~5m at 120\/min/);
});

test("reset advice: none for this run when the plan predates the last reset, otherwise the decision with auto-reset's mode", async () => {
	const stale = { checkedAt: NOW - 10 * HOUR, decision: { reset: true, reason: "old" }, queued: [], affordable: [], cost: 0 };
	let text = await run({ files: { "data/aug-plan.json": JSON.stringify(stale) } });
	assert.match(text, /Reset: no advice for this run yet/);
	const fresh = { checkedAt: NOW - 60_000, decision: { reset: true, reason: "value per hour fell" }, queued: ["A"], affordable: ["B", "C"], cost: 1e6 };
	text = await run({ files: { "data/aug-plan.json": JSON.stringify(fresh) }, procs: [["singularity/auto-reset.js", "home", ["--dry"]]] });
	assert.match(text, /Reset: RESET NOW \(checked 1m ago\): value per hour fell/);
	assert.match(text, /1 bought \+ 2 affordable for \$1000000 \| auto-reset is in --dry: it won't reset by itself/);
	text = await run({ files: { "data/aug-plan.json": JSON.stringify(fresh) }, procs: [["singularity/auto-reset.js", "home", []]] });
	assert.match(text, /auto-reset will act on it/);
	text = await run({ files: { "data/aug-plan.json": JSON.stringify({ ...fresh, decision: { reset: false, reason: "r" } }) } });
	assert.match(text, /Reset: wait[\s\S]*\| auto-reset not running/);
});

test("a forced auto-destroy --bn wins over the plan, and a running --dry is called out", async () => {
	const text = await run({ resetInfo: { currentNode: 3, ownedSF: new Map([[3, 1]]) }, procs: [["singularity/auto-destroy.js", "home", ["--bn", "5", "--dry"]]] });
	assert.match(text, /BitNode 3: destroying gives SF3\.2, next BitNode 5 \(auto-destroy --bn\) \| auto-destroy running in --dry/);
});

test("a challenge that forbids a mechanic is stated, since that mechanic stays off by design", async () => {
	const text = await run({ files: { "data/config.json": JSON.stringify({ forbid: ["bladeburner", "gang"] }) } });
	assert.match(text, /Challenge on: no Bladeburner division, no gang/);
});

test("mechanic managers: lines shown when running, a hint when a persistent manager is down, nothing for a one-shot that is between runs", async () => {
	const gang = { time: NOW - 30_000, title: "Gang", script: "gang/gang-manager.js", lines: ["12 members", "respect 5k"] };
	const sleeves = { time: NOW - 30_000, title: "Sleeves", script: "sleeves/sleeve-manager.js", oneShot: true, lines: ["8 sleeves"] };
	let text = await run({ ports: { 28: gang, 40: sleeves }, procs: [["gang/gang-manager.js", "home", []]] });
	assert.match(text, /Gang \(1m ago\): 12 members\n {2}respect 5k/);
	assert.match(text, /Sleeves \(1m ago\): 8 sleeves/, "one-shots only run for a moment, so not running is normal");
	text = await run({ ports: { 28: gang } });
	assert.match(text, /Gang: gang\/gang-manager\.js isn't running \(run `startup`\)/);
	assert.doesNotMatch(text, /12 members/);
});

test("Bladeburner's running action is shown as the work when getCurrentWork has none, but only while fresh", async () => {
	const action = (time) => ({ action: { name: "Training", type: "General", time } });
	let text = await run({ ports: { 36: action(NOW - 60_000) }, ...withSingularity() });
	assert.match(text, /Doing: Bladeburner: Training \(General\)/);
	text = await run({ ports: { 36: action(NOW - 20 * 60_000) }, ...withSingularity() });
	assert.match(text, /Doing: nothing \(idle\)/, "a 20 minute old post no longer counts");
});

test("startup scripts: running ones are listed (with their host when off home), stage ones that are down are called out, skipped ones are not", async () => {
	const text = await run({
		homeRam: 2048,
		files: { "data/config.json": JSON.stringify({ startupSkip: ["hacknet/hacknet-manager.js"] }) },
		procs: [["hack/batcher.js", "home"], ["pserv/pserv-manager.js", "n00dles"]],
	});
	const running = text.split("\n").find((line) => line.startsWith("Running:"));
	assert.match(running, /batcher/);
	assert.match(running, /pserv-manager@n00dles/);
	const stopped = text.split("\n").find((line) => line.startsWith("Stopped:")) ?? "";
	assert.doesNotMatch(stopped, /hacknet-manager/, "turned off in the config, so not 'stopped'");
	assert.doesNotMatch(stopped, /pserv-manager|batcher/);
	assert.match(stopped, /go-bot|auto-destroy/, "a stage script that is not running is called out");
});

test("a script with a ready check and no work yet is 'waiting for work', not 'stopped'", async () => {
	const text = await run({ homeRam: 2048 });
	const waiting = text.split("\n").find((line) => line.startsWith("Waiting for work:")) ?? "";
	assert.match(waiting, /gang-manager|dnet-manager|stock-trader|bb-manage/, `scripts with ready: checks wait:\n${text}`);
	const stopped = text.split("\n").find((line) => line.startsWith("Stopped:")) ?? "";
	assert.doesNotMatch(stopped, /gang-manager/);
});

const bb = { resetInfo: { ownedSF: new Map([[6, 1]]) } };
const verdictPort = (plan) => ({ 36: { state: "running", stateTime: NOW - 1000, plan } });

test("route: a fresh node-eta verdict names the route and where it came from; a stale one falls back to the config's route", async () => {
	let text = await run({ ...bb, ports: verdictPort({ route: "combat", time: NOW - 60_000 }) });
	assert.match(text, /Route: Bladeburner \(node-eta\.js estimate, 1m ago\)/);
	text = await run({ ...bb, ports: verdictPort({ route: "hacking", time: NOW - 60_000, prior: true }) });
	assert.match(text, /Route: hacking \(node-eta\.js first guess from the BitNode's multipliers, 1m ago\)/);
	text = await run({ ...bb, ports: verdictPort({ route: "combat", time: NOW - 40 * 60_000 }) });
	assert.doesNotMatch(text, /node-eta\.js estimate/, "a verdict older than 30 minutes is not shown as current");
	assert.match(text, /Route: Bladeburner for now \(bladeburner\.route\)/);
	text = await run({ ...bb, files: { "data/config.json": JSON.stringify({ bladeburner: { route: "hacking" } }) } });
	assert.match(text, /Route: hacking for now \(bladeburner\.route\)/);
});

test("route: the kill switch status.routeProgress false leaves only the hacking lines", async () => {
	const text = await run({ ...bb, files: { "data/config.json": JSON.stringify({ status: { routeProgress: false } }) }, ports: verdictPort({ route: "combat", time: NOW - 60_000 }) });
	assert.doesNotMatch(text, /Route:|Bladeburner route/);
});

test("with The Red Pill installed, the daemon rooted and hacking high enough, status says nothing is destroyed until a BitNode is picked", async () => {
	const base = {
		resetInfo: { ownedAugs: new Map([["The Red Pill", 1]]), ownedSF: new Map([[1, 1]]) },
		player: { skills: { hacking: 3000, intelligence: 0 } },
		overrides: { serverExists: () => true, hasRootAccess: () => true },
		files: { "data/config.json": JSON.stringify({ bitnodeRoute: [{ bitNode: 1, level: 1 }], bitnodeRouteAuto: false, bitnodePlan: [] }) },
	};
	let text = await run(base);
	assert.match(text, /READY, nothing is destroyed until you pick a BitNode/);
	text = await run({ ...base, procs: [["singularity/auto-destroy.js", "home", ["--bn", "5"]]] });
	assert.doesNotMatch(text, /READY, nothing is destroyed/, "a forced --bn means it will go by itself");
	text = await run({ ...base, player: { skills: { hacking: 2999, intelligence: 0 } } });
	assert.doesNotMatch(text, /READY, nothing is destroyed/, "one hacking level short");
});

test("rep rate between two status runs: measured from our own snapshot, ignored when too old, from before the reset, or when rep fell", async () => {
	const goals = { goals: { CyberSec: { rep: 1000, aug: "X", count: 1 } }, time: NOW };
	const go = async (snapshot) => run({
		player: { factions: ["CyberSec"] }, ports: { 23: goals }, files: { "data/status-rep.json": JSON.stringify(snapshot) },
		...withSingularity({ singularity: { getFactionRep: () => 400 } }), resetInfo: { ...sf4, lastAugReset: NOW - 10 * HOUR }, // the reset is not what limits these
	});
	// 300 rep gained in 10 minutes = 0.5/s = 30/min; 600 missing = 20 minutes
	assert.match(await go({ time: NOW - 600_000, rep: { CyberSec: 100 }, perSecond: {} }), /ETA ~20m at 30\/min/);
	assert.match(await go({ time: NOW - 2 * HOUR, rep: { CyberSec: 100 }, perSecond: {} }), /ETA/, "2h is inside the 3 hour window");
	assert.match(await go({ time: NOW - 3 * HOUR, rep: { CyberSec: 100 }, perSecond: {} }), /ETA/, "exactly 3 hours is still allowed");
	assert.match(await go({ time: NOW - 3 * HOUR - 1000, rep: { CyberSec: 100 }, perSecond: {} }), /no rate yet/, "a snapshot over 3 hours old says nothing about now");
	assert.match(await go({ time: NOW - 600_000, rep: { CyberSec: 900 }, perSecond: {} }), /no rate yet/, "rep went down (spent or reset): no negative rate");
});

test("a snapshot from before the last reset is not used, and one under two minutes old keeps the earlier rates", async () => {
	const goals = { goals: { CyberSec: { rep: 1000, aug: "X", count: 1 } }, time: NOW };
	const base = { player: { factions: ["CyberSec"] }, ports: { 23: goals }, ...withSingularity({ singularity: { getFactionRep: () => 400 } }) };
	// lastAugReset is NOW - 2h
	assert.match(await run({ ...base, files: { "data/status-rep.json": JSON.stringify({ time: NOW - 2 * HOUR - 60_000, rep: { CyberSec: 100 }, perSecond: {} }) } }), /no rate yet/);
	const fresh = await run({ ...base, files: { "data/status-rep.json": JSON.stringify({ time: NOW - 30_000, rep: { CyberSec: 399 }, perSecond: { CyberSec: 2 } }) } });
	assert.match(fresh, /ETA ~5m at 120\/min/, "running status twice in a row doesn't throw the measured rate away");
});

test("more than five open goals show five and count the rest", async () => {
	const names = ["A", "B", "C", "D", "E", "F", "G"];
	const goals = { goals: Object.fromEntries(names.map((name) => [name, { rep: 1000, aug: `aug-${name}`, count: 1 }])), time: NOW };
	const text = await run({ player: { factions: names }, ports: { 23: goals }, ...withSingularity() });
	assert.equal(text.split("\n").filter((line) => /\/ 1000 for aug-/.test(line)).length, 5);
	assert.match(text, /\.\.\.and 2 more/);
	const exactlyFive = await run({ player: { factions: names.slice(0, 5) }, ports: { 23: { goals: Object.fromEntries(names.slice(0, 5).map((name) => [name, { rep: 1000, aug: "x", count: 1 }])), time: NOW } }, ...withSingularity() });
	assert.doesNotMatch(exactlyFive, /and \d+ more/);
});

test("Go line: the bot's focus, and the opponent still climbing is the one being played", async () => {
	const goData = {
		Netburners: { wins: [true, true], bonus: 5, games: 30, peak: 5, gains: [1, 1], lastPlayed: 1 },
		"The Black Hand": { wins: [true, false, false, false, false], bonus: 1, games: 10, peak: 2, gains: [1, 1], lastPlayed: 2 },
	};
	const text = await run({ files: { "data/go-bonus.json": JSON.stringify(goData) }, procs: [["go/go-bot.js", "home", ["--opponent", "Netburners", "--no-plan"]]] });
	assert.match(text, /Go: bot running, focus Netburners, now playing /);
	assert.match(text, /Netburners 5 ?%/);
	const none = await run({});
	assert.match(none, /Go: bot not running/);
});

test("stage thresholds: a script whose 'until' stage has been reached is no longer expected", async () => {
	// go-bot Netburners runs from early until mid. At a mid-sized home it should not be listed as stopped; at early it should.
	const early = await run({ homeRam: 64 });
	const mid = await run({ homeRam: 1024 });
	const stoppedIn = (text) => text.split("\n").find((line) => line.startsWith("Stopped:")) ?? "";
	assert.match(stoppedIn(early), /go-bot/, "early stage expects the go bot");
	assert.match(stoppedIn(mid), /go-bot/, "mid stage expects the next go bot instead");
});
