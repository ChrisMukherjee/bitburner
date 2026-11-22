// singularity/auto-destroy.js: when it ends the BitNode. Destroying the daemon cannot be undone, so these check that it
// waits for every condition, never acts on a mere suggestion or --dry, and leaves itself running while it hands over.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeWorld } from "./support/fake-world.mjs";
import { main } from "/singularity/auto-destroy.js";

const DAEMON = "w0r1d_d43m0n";
const STOP = "test: stop the loop";

/** Runs main for `passes` loop iterations (one sleep each), then stops it. */
async function run({ args = {}, config = {}, ports = {}, hacking = 3000, daemon = true, root = true, procs = [], passes = 1, execFails = false, homeFiles = ["BruteSSH.exe"], serverRoot = true } = {}) {
	let sleeps = 0;
	const world = fakeWorld({
		node: 1, sourceFiles: [[4, 3]], homeFiles,
		servers: { n00dles: { ram: 8, root: serverRoot } },
		scriptRam: () => (execFails ? 100 : 2), // too big for home: exec returns 0
		files: { "data/config.json": JSON.stringify({ bitnodeRouteAuto: false, bitnodeRoute: [{ bitNode: 5, level: 1 }], ...config }) },
		ports,
		overrides: {
			flags: (schema) => ({ ...Object.fromEntries(schema.map(([name, value]) => [name, value])), ...args }),
			serverExists: (host) => (host === DAEMON ? daemon : true),
			getServerRequiredHackingLevel: () => 2500,
			getHackingLevel: () => hacking,
			hasRootAccess: (host) => (host === DAEMON ? root : host === "home" || serverRoot),
			getResetInfo: () => ({ currentNode: 1, ownedSF: new Map([[4, 3]]), lastAugReset: 0, ownedAugs: new Map() }),
			sleep: async () => { if (++sleeps >= passes) throw new Error(STOP); },
			getScriptRam: () => 34,
		},
	});
	for (const [script, host = "home"] of procs) world.start(script, host);
	const self = world.start("singularity/auto-destroy.js");
	world.ns.pid = self;
	try {
		await main(world.ns);
	} catch (err) {
		if (err.message !== STOP) throw err;
	}
	return world;
}

const destroyCalls = (world) => world.ns.called("exec").filter(([script]) => script === "singularity/next-bitnode.js");

test("it waits while The Red Pill isn't installed: nothing is killed or started", async () => {
	const world = await run({ daemon: false, procs: [["hack/batcher.js"]] });
	assert.equal(destroyCalls(world).length, 0);
	assert.ok(world.names().includes("hack/batcher.js"), "other scripts keep running while it waits");
});

test("it waits while hacking is below the daemon's level", async () => {
	const world = await run({ hacking: 2499 });
	assert.equal(destroyCalls(world).length, 0);
	assert.ok(world.ns.logs.some((line) => /hacking 2499 of 2500/.test(line)));
});

test("at exactly the required level it goes: kills the other scripts on home, keeps itself, starts next-bitnode with the route's BitNode", async () => {
	const world = await run({ hacking: 2500, procs: [["hack/batcher.js"], ["gang/gang-manager.js"]] });
	const calls = destroyCalls(world);
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].slice(0, 4), ["singularity/next-bitnode.js", "home", 1, 5], "BitNode 5 from bitnodeRoute");
	assert.deepEqual(world.names("home").filter((name) => name !== "singularity/next-bitnode.js"), ["singularity/auto-destroy.js"], "only itself is left to hand over from");
});

test("without root it opens ports and nukes before deciding; no root still means no destroy", async () => {
	const world = await run({ root: false, serverRoot: false });
	assert.deepEqual(world.ns.called("nuke"), [["n00dles"]], "tries to get root first, on the servers that lack it");
	assert.equal(destroyCalls(world).length, 0, "the daemon still has no root in this fake");
	assert.ok(world.ns.logs.some((line) => /no root yet/.test(line)));
});

test("--bn overrides the route; with no route left and no --bn it only tells the player once", async () => {
	let world = await run({ args: { bn: 12 } });
	assert.equal(destroyCalls(world)[0][3], 12);
	world = await run({ config: { bitnodeRoute: [{ bitNode: 5, level: 1 }], bitnodePlan: [] } });
	assert.equal(destroyCalls(world)[0]?.[3], 5, "baseline: the route entry is followed");
	const doneRoute = [{ bitNode: 1, level: 1 }]; // BitNode 1 destroyed now gives SF1.1, so the route is done
	world = await run({ config: { bitnodeRoute: doneRoute, bitnodePlan: [] }, passes: 3 });
	assert.equal(destroyCalls(world).length, 0, "nothing to go to: the BitNode stays open");
	assert.equal(world.ns.toasts.filter((line) => /no BitNode route to follow/.test(line)).length, 1, "the player is told once, not every minute");
});

test("a plan suggestion alone (bitnodeRouteAuto off) is shown but never acted on", async () => {
	const world = await run({ config: { bitnodeRoute: [], bitnodeRouteAuto: false, bitnodePlan: [{ bitNode: 5, level: 1, tier: 1 }] } });
	assert.equal(destroyCalls(world).length, 0, "suggestion-only destroys nothing");
});

test("with bitnodeRouteAuto on the plan's suggestion is followed once the route is empty", async () => {
	const world = await run({ config: { bitnodeRoute: [], bitnodeRouteAuto: true, bitnodePlan: [{ bitNode: 6, level: 1, tier: 1 }] } });
	assert.equal(destroyCalls(world)[0]?.[3], 6);
});

test("--dry says what it would do and destroys nothing, even over several passes", async () => {
	const world = await run({ args: { dry: true }, passes: 3, procs: [["hack/batcher.js"]] });
	assert.equal(destroyCalls(world).length, 0);
	assert.ok(world.names().includes("hack/batcher.js"), "nothing is killed in --dry");
});

test("a fresh sleeve-shop hold keeps the BitNode open even when the daemon is ready, and --no-hold ignores it", async () => {
	const hold = { time: Date.now(), hold: true, reason: "sleeve in reach", cost: 1e9 };
	const { SLEEVE_HOLD_PORT } = await import("/utils/sleeve-hold.js");
	let world = await run({ ports: { [SLEEVE_HOLD_PORT]: hold }, passes: 2 });
	assert.equal(destroyCalls(world).length, 0, "holding for a sleeve");
	assert.equal(world.ns.toasts.filter((line) => /BitNode stays open/.test(line)).length, 1, "told once over two passes");
	world = await run({ ports: { [SLEEVE_HOLD_PORT]: hold }, args: { "no-hold": true } });
	assert.equal(destroyCalls(world).length, 1, "--no-hold skips the wait");
});

test("a finished Bladeburner Black Ops route ends the BitNode with no daemon, but a stale 'done' does not", async () => {
	const fresh = { blackOps: { done: true, time: Date.now() } };
	let world = await run({ daemon: false, ports: { 36: fresh } });
	assert.equal(destroyCalls(world).length, 1);
	world = await run({ daemon: false, ports: { 36: { blackOps: { done: true, time: Date.now() - 2 * 3600_000 } } } });
	assert.equal(destroyCalls(world).length, 0, "a done flag older than an hour no longer counts");
});

test("if next-bitnode can't be started it says so and exits instead of looping forever", async () => {
	const world = await run({ execFails: true, passes: 5 });
	assert.ok(world.ns.terminal.some((line) => /couldn't start singularity\/next-bitnode\.js.*run \/singularity\/next-bitnode\.js 5/.test(line)), "the player is told how to run it by hand");
	assert.equal(world.ns.called("sleep").length, 0, "it returns instead of sleeping and trying again");
});

test("without the Singularity API it exits cleanly and touches nothing", async () => {
	const world = fakeWorld({ node: 1, sourceFiles: [], overrides: { flags: () => ({ bn: 0, dry: false, "no-hold": false }), getScriptName: () => "singularity/auto-destroy.js" } });
	await main(world.ns);
	assert.equal(world.ns.called("kill").length, 0);
	assert.equal(world.ns.called("exec").length, 0);
});
