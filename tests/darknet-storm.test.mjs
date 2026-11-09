// Storm rule (darknet/storm-rule.js), the manager's bookkeeping (dnet-manager.js manageStorm / noteSeed) and the
// crawler's step (darknet/crawler.js syncStorm).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { decideStorm, rateBetween, bestRate, rampMs, stallMs, freeingRate, rateNoise } from "/darknet/storm-rule.js";
import { manageStorm, noteSeed, newStormState } from "/darknet/dnet-manager.js";
import { syncStorm } from "/darknet/crawler.js";
import { STORM, STORM_TARGET_FILE } from "/darknet/config.js";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/** Income of `high` $/s for `highMin` minutes, then `low` $/s, one sample per 30s, ending at `now`. */
function history({ high, highMin, low, lowMin, now, usable = 1000, blocked = () => 0 }) {
	const samples = [];
	const start = now - (highMin + lowMin) * MIN;
	let money = 0;
	for (let t = start; t <= now; t += 30 * 1000) {
		samples.push({ t, money, blocked: blocked(t), usable });
		money += (t < start + highMin * MIN ? high : low) * 30;
	}
	return samples;
}
const NOW = 4 * HOUR;
/** A run that earned well, then dried up and stopped finding servers. */
function dry(over = {}) {
	return {
		now: NOW, startedAt: 0, lastStorm: 0, seedHost: "seed-host",
		samples: history({ high: 1000, highMin: 60, low: 100, lowMin: 40, now: NOW }),
		discoveries: [10 * MIN, 12 * MIN, 15 * MIN, 20 * MIN, 25 * MIN, 40 * MIN, 70 * MIN],
		pending: 0, blockedGb: 0, atRiskShare: 0.5, ...over,
	};
}

test("rates: average over a window, and the best window in the history", () => {
	const samples = history({ high: 1000, highMin: 60, low: 100, lowMin: 40, now: NOW });
	assert.ok(Math.abs(rateBetween(samples, NOW - 10 * MIN, NOW) - 100) < 1);
	assert.ok(Math.abs(bestRate(samples, NOW, 10 * MIN, 3 * HOUR) - 1000) < 1);
	assert.equal(rateBetween([], 0, NOW), 0);
});

test("a dried-up darknet with a seed fires, and the reason has the numbers", () => {
	const decision = decideStorm(dry());
	assert.equal(decision.fire, true);
	assert.match(decision.reason, /income 100\/s vs 1000\/s possible/);
});

test("it waits with no seed, in cooldown, or without enough history", () => {
	assert.equal(decideStorm(dry({ seedHost: null })).fire, false);
	assert.match(decideStorm(dry({ lastStorm: NOW - 5 * MIN })).reason, /cooling down/);
	assert.match(decideStorm(dry({ samples: history({ high: 1000, highMin: 5, low: 100, lowMin: 10, now: NOW }) })).reason, /history/);
	assert.match(decideStorm(dry({ startedAt: NOW - 5 * MIN })).reason, /history/);
});

test("it waits while servers are being cracked or servers keep turning up", () => {
	assert.match(decideStorm(dry({ pending: 2 })).reason, /still being cracked/);
	assert.match(decideStorm(dry({ discoveries: [...dry().discoveries, NOW - MIN] })).reason, /still finding/);
});

test("it waits while blocked RAM is visibly being freed, but not when the blocked RAM is stuck", () => {
	// 300GB blocked now, freed at 10GB a minute: about 30 more minutes to clear, so income is still rising.
	const falling = history({ high: 1000, highMin: 60, low: 100, lowMin: 40, now: NOW, blocked: (t) => 300 + 10 * (NOW - t) / MIN });
	const last = falling[falling.length - 1].blocked;
	assert.match(decideStorm(dry({ samples: falling, blockedGb: last })).reason, /still being freed/);
	const stuck = history({ high: 1000, highMin: 60, low: 100, lowMin: 40, now: NOW, blocked: () => 300 });
	assert.equal(decideStorm(dry({ samples: stuck, blockedGb: 300 })).fire, true);
	assert.ok(freeingRate(falling, NOW, 10 * MIN) > 0);
	assert.equal(freeingRate(stuck, NOW, 10 * MIN), 0);
});

test("it waits when income is already near what the map can earn", () => {
	const input = dry({ samples: history({ high: 1000, highMin: 60, low: 900, lowMin: 40, now: NOW }) });
	assert.match(decideStorm(input).reason, /not bring back more/);
});

test("a map that shrank is judged by income per GB, not only by the old best", () => {
	// Income fell with the usable RAM (1000GB -> 250GB) while earning per GB stayed the same: nothing is wrong
	// per GB, but refilling to the peak RAM would earn 4x, so a storm that refills the map pays.
	const shrunk = history({ high: 1000, highMin: 60, low: 250, lowMin: 40, now: NOW }).map((sample, i, all) => ({ ...sample, usable: i < all.length * 0.6 ? 1000 : 250 }));
	assert.equal(decideStorm(dry({ samples: shrunk })).fire, true);
});

test("noisy income needs a bigger expected gain", () => {
	const quiet = history({ high: 1000, highMin: 60, low: 100, lowMin: 40, now: NOW });
	assert.ok(rateNoise(quiet, NOW, 10 * MIN).cv < 0.05);
	const noisy = quiet.map((sample, i) => ({ ...sample }));
	let money = quiet[quiet.length - 21].money;
	for (let i = quiet.length - 20; i < quiet.length; i++) { money += Math.floor(i / 4) % 2 ? 12000 : 0; noisy[i].money = money; }
	assert.ok(rateNoise(noisy, NOW, 10 * MIN).cv > 0.5);
});

test("the lost income of a storm counts only for servers it can delete", () => {
	// A slow-filling map, income only just under what it can earn, and everything at risk: not worth it.
	const slow = Array.from({ length: 30 }, (_, i) => i * 2 * MIN);
	const samples = history({ high: 1000, highMin: 60, low: 650, lowMin: 40, now: NOW });
	const input = dry({ discoveries: [...slow, 62 * MIN], samples });
	assert.equal(decideStorm({ ...input, atRiskShare: 1 }).fire, false);
	assert.equal(decideStorm({ ...input, atRiskShare: 0 }).fire, true);
});

test("the stall time scales with the usual gap, and the ramp time is clamped", () => {
	assert.equal(stallMs([]), STORM.stallFloorMs);
	assert.equal(stallMs([0, 10 * MIN, 20 * MIN, 30 * MIN]), 40 * MIN);
	assert.equal(rampMs([]), STORM.rampMinMs);
	assert.equal(rampMs(Array.from({ length: 11 }, (_, i) => i * 30 * MIN)), STORM.rampMaxMs);
});

function managerWorld({ seedHost = "seed-host" } = {}) {
	const map = { "seed-host": { maxRam: 64 }, other: { maxRam: 64 } };
	const passwords = { "seed-host": "a", other: "b" };
	const earnings = { startTime: 0, storm: newStormState(map, passwords) };
	earnings.storm.seedHost = seedHost;
	return { map, passwords, earnings, unsolved: {} };
}

test("the manager samples income, orders the unleash once the rule agrees, then cools down", () => {
	const world = managerWorld();
	let money = 0;
	const ns = fakeNs({ overrides: {
		getMoneySources: () => ({ sinceInstall: { darknet: money } }),
		scp: () => true,
		dnet: { getStasisLinkedServers: () => [], getBlockedRam: () => 0, connectToSession: () => ({ success: true }) },
	} });
	let decision;
	for (let t = 0; t <= 4 * HOUR; t += STORM.sampleMs) {
		money += (t < 3 * HOUR ? 1000 : 100) * (STORM.sampleMs / 1000);
		decision = manageStorm(ns, world, t, true);
		if (decision.fire) break;
	}
	assert.equal(decision.fire, true);
	const order = JSON.parse(ns.files[STORM_TARGET_FILE]);
	assert.equal(order.host, "seed-host");
	assert.equal(world.earnings.storm.fired, 1);
	assert.equal(world.earnings.storm.seedHost, null);
	// the seed is gone, so nothing more is ordered
	assert.equal(manageStorm(ns, world, order.at + STORM.sampleMs, true).fire, false);
});

test("with the switch off the decision is still made but no order is written", () => {
	const world = managerWorld();
	let money = 0;
	const ns = fakeNs({ overrides: {
		getMoneySources: () => ({ sinceInstall: { darknet: money } }),
		dnet: { getStasisLinkedServers: () => [], getBlockedRam: () => 0 },
	} });
	let decision;
	for (let t = 0; t <= 4 * HOUR; t += STORM.sampleMs) {
		money += (t < 3 * HOUR ? 1000 : 100) * (STORM.sampleMs / 1000);
		decision = manageStorm(ns, world, t, false);
		if (decision.fire) break;
	}
	assert.equal(decision.fire, true);
	assert.equal(STORM_TARGET_FILE in ns.files, false);
	assert.equal(world.earnings.storm.fired ?? 0, 0);
});

test("seed reports set and clear the seed host; a vanished host is forgotten", () => {
	const world = managerWorld({ seedHost: null });
	noteSeed(world.earnings, { host: "other", present: true });
	assert.equal(world.earnings.storm.seedHost, "other");
	noteSeed(world.earnings, { host: "elsewhere", present: false });
	assert.equal(world.earnings.storm.seedHost, "other");
	noteSeed(world.earnings, { host: "other", present: false });
	assert.equal(world.earnings.storm.seedHost, null);
});

test("new servers and passwords count as discoveries, ones known at the start do not", () => {
	const world = managerWorld({ seedHost: null });
	const ns = fakeNs({ overrides: {
		getMoneySources: () => ({ sinceInstall: { darknet: 0 } }),
		dnet: { getStasisLinkedServers: () => [], getBlockedRam: () => 0 },
	} });
	manageStorm(ns, world, 1000);
	assert.deepEqual(world.earnings.storm.discoveries, []);
	world.map.third = { maxRam: 8 };
	manageStorm(ns, world, 2000);
	world.passwords.third = "c";
	manageStorm(ns, world, 3000);
	assert.deepEqual(world.earnings.storm.discoveries, [2000, 3000]);
});

/** ns for a crawler: the seed file is `present`, the order file holds `order`. */
function crawlerNs({ present, order }) {
	const reports = [];
	const ns = fakeNs({
		files: { [STORM_TARGET_FILE]: JSON.stringify(order) },
		overrides: {
			fileExists: (file) => (file === "STORM_SEED.exe" ? present : false),
			dnet: { unleashStormSeed: () => ({ success: true }) },
		},
	});
	return { ns, reports };
}
const crawlState = (extra = {}) => ({
	self: "seed-host", seedSeen: false, stormAt: 0,
	port: { tryWrite: (text) => { crawlState.sent.push(JSON.parse(text)); return true; } }, ...extra,
});
crawlState.sent = [];

test("the crawler reports the seed once, and unleashes it only on a fresh order naming its server", () => {
	crawlState.sent = [];
	const { ns } = crawlerNs({ present: true, order: {} });
	const crawl = crawlState();
	syncStorm(ns, crawl);
	syncStorm(ns, crawl);
	assert.deepEqual(crawlState.sent.map((m) => m.kind), ["storm-seed"]);
	assert.equal(ns.called("dnet.unleashStormSeed").length, 0);

	const now = Date.now();
	const fresh = crawlerNs({ present: true, order: { host: "seed-host", at: now } });
	const c2 = crawlState({ seedSeen: true });
	syncStorm(fresh.ns, c2);
	syncStorm(fresh.ns, c2); // the same order is not acted on twice
	assert.equal(fresh.ns.called("dnet.unleashStormSeed").length, 1);

	for (const order of [{ host: "other", at: now }, { host: "seed-host", at: now - 10 * MIN }]) {
		const skipped = crawlerNs({ present: true, order });
		syncStorm(skipped.ns, crawlState({ seedSeen: true }));
		assert.equal(skipped.ns.called("dnet.unleashStormSeed").length, 0);
	}
});

test("the crawler reports when the seed leaves and never unleashes without it", () => {
	crawlState.sent = [];
	const gone = crawlerNs({ present: false, order: { host: "seed-host", at: Date.now() } });
	syncStorm(gone.ns, crawlState({ seedSeen: true }));
	assert.deepEqual(crawlState.sent.map((m) => [m.kind, m.present]), [["storm-seed", false]]);
	assert.equal(gone.ns.called("dnet.unleashStormSeed").length, 0);
});
