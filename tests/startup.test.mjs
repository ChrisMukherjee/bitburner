// startup.js runPass: stage choice, what starts where, one-shot timing, restarts, and the cases
// where a script is left out. Runs passes against a fake game world (support/fake-world.mjs) with
// the clock mocked, so "10 seconds later" is exact.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeWorld } from "./support/fake-world.mjs";
import { runPass, newStartupState, SCRIPTS, CONFIG, passDelay } from "/startup.js";
import { readFileSync } from "node:fs";
import { DEFAULTS } from "/config.js";

const START = 1_800_000_000_000;
const SINGULARITY = { available: true, level: 3, ramMultiplier: 1 };
const NO_SINGULARITY = { available: false, level: 0, ramMultiplier: 16 };
// Rooted servers to place scripts on when home is full (like n00dles and the purchased servers).
const SERVERS = { "n00dles": { ram: 4 }, "foodnstuff": { ram: 16 }, "pserv-0": { ram: 64 } };

/** A world, plus a pass function that keeps its state between calls. */
function setup(t, { requested = "auto", sf4 = NO_SINGULARITY, restart = false, ...world } = {}) {
	t.mock.timers.enable({ apis: ["Date"], now: START });
	const game = fakeWorld({ servers: SERVERS, ...world });
	const state = newStartupState(sf4, restart);
	return { game, state, pass: () => runPass(game.ns, requested, state), tick: (ms) => t.mock.timers.tick(ms) };
}
const oneShots = SCRIPTS.filter((entry) => entry.oneShot).map((entry) => entry.script);
const runningOneShots = (game) => game.names().filter((name) => oneShots.includes(name));

test("the stage follows home RAM (startupStages), or the one asked for", (t) => {
	const stages = DEFAULTS.startupStages;
	for (const [ram, expected] of [[8, "start"], [stages.early, "early"], [stages.mid, "mid"], [stages.late, "late"], [4096, "late"]]) {
		const { state, pass } = setup(t, { homeRam: ram });
		pass();
		assert.equal(state.stage, expected, `${ram}GB home`);
		t.mock.timers.reset();
	}
	const { state, pass } = setup(t, { homeRam: 8, requested: "mid" });
	pass();
	assert.equal(state.stage, "mid");
});

test("fresh BitNode, 8GB home, no Singularity: the batcher runs off home with its imports, no Singularity script starts", (t) => {
	const { game, pass } = setup(t, { homeRam: 8, scriptRam: (script) => (script === "hack/batcher.js" ? 10 : 2) });
	pass();
	const batcher = game.running().find((proc) => proc.filename === "hack/batcher.js");
	assert.ok(batcher, "batcher started");
	assert.notEqual(batcher.host, "home");
	const copied = game.copied.get(batcher.host);
	for (const file of ["hack/batcher.js", "utils/ram-pool.js", "utils/ram-reserve.js", "utils/notify.js", "utils/bitnode-mults.js", "utils/config.js"]) {
		assert.ok(copied.has(file), `${file} copied along`);
	}
	assert.deepEqual(game.names().filter((name) => name.startsWith("singularity/")), []);
	assert.ok(game.names("home").includes("tools/reminders.js"), "the no-Singularity reminders run on home");
});

test("only one one-shot at a time, and one that is always ready can't starve the rest", (t) => {
	const { game, pass, tick } = setup(t, { homeRam: 64, node: 4, sf4: SINGULARITY });
	pass();
	const first = runningOneShots(game);
	assert.equal(first.length, 1, `one one-shot, got ${first.join(", ")}`);
	tick(15_000);
	pass();
	assert.deepEqual(runningOneShots(game), first, "none more while it runs");
	game.exit(first[0]);
	tick(15_000);
	pass();
	const second = runningOneShots(game);
	assert.equal(second.length, 1);
	assert.notEqual(second[0], first[0], "one that never ran goes before the one that just did");
});

test("a one-shot isn't started again before its `every` has passed", (t) => {
	const { game, pass, tick } = setup(t, { homeRam: 8, node: 4, sf4: SINGULARITY });
	pass();
	const [first] = runningOneShots(game);
	const entry = SCRIPTS.find((item) => item.script === first);
	game.exit(first);
	// Leave only this one-shot due: every other one-shot is skipped in the config.
	game.ns.write("data/config.json", JSON.stringify({ startupSkip: oneShots.filter((name) => name !== first) }), "w");
	tick(entry.every - 1000);
	pass();
	assert.deepEqual(runningOneShots(game), []);
	tick(2000);
	pass();
	assert.deepEqual(runningOneShots(game), [first]);
});

test("a script whose ready check says no work isn't started (gang manager without a gang)", (t) => {
	const { game, pass } = setup(t, { homeRam: 64 });
	pass();
	assert.ok(!game.names().includes("gang/gang-manager.js"));
});

test("startupSkip in data/config.json leaves a script out", (t) => {
	const { game, pass } = setup(t, { homeRam: 64, files: { "data/config.json": JSON.stringify({ startupSkip: ["hack/batcher.js"] }) } });
	pass();
	assert.ok(!game.names().includes("hack/batcher.js"));
	assert.ok(game.names().includes("hacknet/hacknet-manager.js"));
});

test("a script that stops is restarted after a wait that doubles when it keeps stopping soon", (t) => {
	const { game, pass, tick } = setup(t, { homeRam: 64 });
	pass();
	assert.ok(game.names().includes("hacknet/hacknet-manager.js"));
	tick(10_000);
	game.exit("hacknet/hacknet-manager.js");
	pass(); // notices it stopped after 10 s: wait doubles from restartMinMs
	const wait = CONFIG.restartMinMs * 2;
	tick(wait - 1000);
	pass();
	assert.ok(!game.names().includes("hacknet/hacknet-manager.js"), "still waiting");
	tick(2000);
	pass();
	assert.ok(game.names().includes("hacknet/hacknet-manager.js"), "restarted");
});

test("a script that ran a long time and stopped gets the short wait and a toast", (t) => {
	const { game, pass, tick } = setup(t, { homeRam: 64 });
	pass();
	tick(CONFIG.longRunMs + 1000);
	game.exit("hacknet/hacknet-manager.js");
	pass();
	assert.ok(game.ns.toasts.some((line) => /hacknet-manager.js stopped after/.test(line)));
	tick(CONFIG.restartMinMs + 1000);
	pass();
	assert.ok(game.names().includes("hacknet/hacknet-manager.js"));
});

test("a new stage swaps the Go bot's opponent instead of running two bots", (t) => {
	const { game, pass } = setup(t, { homeRam: DEFAULTS.startupStages.early });
	pass();
	const bots = () => game.running().filter((proc) => proc.filename === "go/go-bot.js").map((proc) => proc.args.join(" "));
	assert.deepEqual(bots(), ["--opponent Netburners"]);
	game.hosts.home.ram = DEFAULTS.startupStages.mid;
	pass();
	assert.deepEqual(bots(), ["--opponent The Black Hand"]);
});

test("--restart stops our running scripts once and starts them again", (t) => {
	const { game, pass } = setup(t, { homeRam: 64, restart: true });
	const oldPid = game.start("hacknet/hacknet-manager.js");
	const notOurs = game.start("my-own-script.js");
	pass();
	const manager = game.running().find((proc) => proc.filename === "hacknet/hacknet-manager.js");
	assert.ok(manager && manager.pid !== oldPid, "restarted with a new pid");
	assert.ok(game.running().some((proc) => proc.pid === notOurs), "other scripts are left alone");
	pass();
	assert.equal(game.running().find((proc) => proc.filename === "hacknet/hacknet-manager.js").pid, manager.pid, "only once");
});

test("an old looping copy of a one-shot (other args) is stopped", (t) => {
	const { game, pass } = setup(t, { homeRam: 64, node: 4, sf4: SINGULARITY });
	const looping = game.start("singularity/player-work.js", "home", []);
	pass();
	assert.ok(!game.running().some((proc) => proc.pid === looping));
});

test("where hacking pays almost nothing, the batcher is stopped and the stock trader starts early", (t) => {
	const mults = { node: 8, mults: { ScriptHackMoney: 0, ScriptHackMoneyGain: 0 }, others: {} };
	const { game, pass } = setup(t, {
		homeRam: 64, node: 8, sourceFiles: [[5, 1]],
		files: { "data/bitnode.txt": "8", "data/bitnode-mults.json": JSON.stringify(mults) },
	});
	game.start("hack/batcher.js", "pserv-0");
	pass();
	assert.ok(!game.names().includes("hack/batcher.js"), "batcher stopped");
	assert.ok(game.names("home").includes("stocks/stock-trader.js"), "stock trader at the early stage");
});

test("without Singularity nothing in singularity/ starts, at any stage", (t) => {
	const { game, pass } = setup(t, { homeRam: 4096 });
	pass();
	assert.deepEqual(game.names().filter((name) => name.startsWith("singularity/")), []);
	assert.ok(!game.names().includes("share/share-manager.js"), "needsSF4 scripts too");
});

test("the first one-shot after a reset is the player's, and the queue behind a running one-shot asks for quick passes", (t) => {
	const { game, pass } = setup(t, { homeRam: 64, node: 4, sf4: SINGULARITY });
	const result = pass();
	const firstEntry = SCRIPTS.find((entry) => entry.script === runningOneShots(game)[0]);
	assert.ok(firstEntry.first, `${firstEntry.script} is marked first`);
	assert.equal(result.queued, true, "others are due behind it, so the next pass comes after queueMs");
	assert.ok(CONFIG.queueMs < CONFIG.passMs);
	// Once it has exited, the next one starts on the very next (quick) pass and the queue drains.
	let guard = 0;
	let last = result;
	while (last.queued && guard++ < 30) {
		const running = runningOneShots(game);
		for (const name of running) game.exit(name);
		last = pass();
	}
	assert.equal(last.queued, false, "nothing left behind the last one");
});

test("no quick passes when no one-shot is waiting", (t) => {
	const { game, pass } = setup(t, { homeRam: 8, node: 4, sf4: SINGULARITY });
	game.ns.write("data/config.json", JSON.stringify({ startupSkip: oneShots.slice(1) }), "w");
	assert.equal(pass().queued, false);
});

test("regression: the main loop sleeps queueMs while one-shots are queued, passMs otherwise", () => {
	assert.equal(passDelay({ queued: true }), CONFIG.queueMs);
	assert.equal(passDelay({ queued: false }), CONFIG.passMs);
	assert.equal(passDelay(undefined), CONFIG.passMs);
	// The loop must use it: queueMs was once defined, and runPass returned queued, but the loop never slept on it.
	const source = readFileSync(new URL("../startup.js", import.meta.url), "utf8");
	assert.match(source, /await ns\.sleep\(passDelay\(/);
});
