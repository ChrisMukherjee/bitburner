// The reset itself, after the rule says RESET: singularity/auto-reset.js (stop everything, sell stocks,
// buy, install), singularity/workers/aug-buyer.js (what gets bought, NeuroFlux against home upgrades) and
// singularity/install-augs.js (its safeguard, home upgrades, then the install). A wrong step here can't be
// undone in game: an install with nothing bought, or stocks lost to the reset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { fakeWorld } from "./support/fake-world.mjs";
import { resetNow } from "/singularity/auto-reset.js";
import { main as buyerMain } from "/singularity/workers/aug-buyer.js";
import { main as installMain } from "/singularity/install-augs.js";

const PLAN = "data/aug-plan.json";
const NEUROFLUX = "NeuroFlux Governor";

/** A plan as buy-augs.js --plan writes it, deciding RESET. */
function plan(changes = {}) {
	return {
		checkedAt: Date.now(), queued: [], affordable: ["A"], cost: 1e9, buyList: [{ aug: "A", faction: "F" }],
		neurofluxFaction: "F", decision: { reset: true, push: false, reason: "test", value: 1, rate: 1, curve: [{ inMinutes: 0, augs: 1, neuroflux: 0 }] },
		...changes,
	};
}

// --- auto-reset.js resetNow ---

/** A world where the buyer records `bought` in the plan and every helper finishes at once. */
function resetWorld({ bought = { augs: ["A"], neuroflux: 0 }, buyerWrites = true, planChanges = {} } = {}) {
	const order = [];
	const world = fakeWorld({
		homeRam: 256,
		servers: { "pserv-0": { ram: 64 } },
		files: { [PLAN]: JSON.stringify(plan(planChanges)) },
		onExec: (script, args, game) => {
			order.push([script, ...args].join(" "));
			if (script === "singularity/workers/aug-buyer.js" && buyerWrites) {
				const current = JSON.parse(game.ns.read(PLAN));
				current.lastBuy = { at: Date.now(), ...bought };
				game.ns.write(PLAN, JSON.stringify(current), "w");
			}
			// startup.js and the installer would keep going; everything else here is a one-shot.
			return { exits: !["startup.js", "singularity/install-augs.js"].includes(script) };
		},
	});
	world.copied.get("pserv-0").add("stocks/stock-trader.js");
	return { world, order };
}

test("reset order: stop home, stop every stock trader, sell stocks, buy, then install", async () => {
	const { world, order } = resetWorld();
	world.start("hack/batcher.js");
	world.start("stocks/stock-trader.js", "pserv-0", ["--buy-4s"]);
	world.start("hack/workers/hack.js", "pserv-0");
	const installed = await resetNow(world.ns, plan());
	assert.equal(installed, true);
	assert.deepEqual(order, [
		"stocks/stock-trader.js --liquidate --no-buy-tix",
		"singularity/workers/aug-buyer.js",
		"singularity/install-augs.js --force startup.js",
	]);
	assert.ok(!world.names("home").includes("hack/batcher.js"), "home was cleared for the buyer");
	assert.ok(!world.names().includes("stocks/stock-trader.js"), "no trader left to buy back in");
	assert.ok(world.names("pserv-0").includes("hack/workers/hack.js"), "workers elsewhere keep running");
});

test("the buyer got nothing the advice counted: no install, startup.js runs again", async () => {
	// The advice counted a NeuroFlux level, but the buyer gave the cash to a home upgrade instead.
	const advice = { decision: { reset: true, push: false, reason: "nf", curve: [{ inMinutes: 0, augs: 0, neuroflux: 1 }] }, affordable: [] };
	const { world, order } = resetWorld({ bought: { augs: [], neuroflux: 0 }, planChanges: advice });
	const installed = await resetNow(world.ns, plan(advice));
	assert.equal(installed, false);
	assert.ok(!order.some((line) => line.startsWith("singularity/install-augs.js")), "never installs");
	assert.ok(world.names("home").includes("startup.js"), "startup.js restarted");
	assert.ok(world.ns.terminal.some((line) => /Not installing/.test(line)));
});

test("nothing new to buy but augments already bought (by hand): installs", async () => {
	const advice = { affordable: [], queued: ["Bought earlier"], decision: { reset: true, push: false, reason: "x", curve: [{ inMinutes: 0, augs: 0, neuroflux: 0 }] } };
	const { world, order } = resetWorld({ bought: { augs: [], neuroflux: 0 }, planChanges: advice });
	assert.equal(await resetNow(world.ns, plan(advice)), true);
	assert.ok(order.includes("singularity/install-augs.js --force startup.js"));
});

test("the buyer didn't record a pass (crashed): no install", async () => {
	const { world, order } = resetWorld({ buyerWrites: false });
	assert.equal(await resetNow(world.ns, plan()), false);
	assert.ok(!order.some((line) => line.startsWith("singularity/install-augs.js")));
	assert.ok(world.names("home").includes("startup.js"));
});

test("a Daedalus push counts its fill list, not the usual plan", async () => {
	const advice = { affordable: [], daedalusPush: { fill: ["cheap1", "cheap2"] }, decision: { reset: true, push: true, reason: "push", curve: [{ inMinutes: 0, augs: 0, neuroflux: 3 }] } };
	const { world } = resetWorld({ bought: { augs: [], neuroflux: 0 }, planChanges: advice });
	assert.equal(await resetNow(world.ns, plan(advice)), false, "the fill wasn't bought: no install");
});

// --- aug-buyer.js ---

/**
 * A shop: prices rise 1.9x after each purchase (NeuroFlux a further 1.14x per level). `needs` maps an
 * augment to one that must be bought first. Returns the ns and the shop's state.
 */
function shop({ money, prices, needs = {}, neurofluxPrice = Infinity, gates = {}, planChanges = {} }) {
	const state = { money, prices: { ...prices, [NEUROFLUX]: neurofluxPrice }, owned: [] };
	const ns = fakeNs({
		files: { [PLAN]: JSON.stringify(plan({ buyList: Object.keys(prices).map((aug) => ({ aug, faction: "F" })), affordable: Object.keys(prices), ...planChanges })) },
		ports: { 33: gates },
		overrides: {
			flags: () => ({ reserve: 0, _: [] }),
			getServerMoneyAvailable: () => state.money,
			singularity: {
				getAugmentationPrice: (aug) => state.prices[aug],
				purchaseAugmentation: (faction, aug) => {
					const price = state.prices[aug];
					if (price > state.money || (needs[aug] && !state.owned.includes(needs[aug]))) return false;
					state.money -= price;
					state.owned.push(aug);
					for (const name of Object.keys(state.prices)) state.prices[name] *= 1.9;
					if (aug === NEUROFLUX) state.prices[NEUROFLUX] *= 1.14;
					return true;
				},
			},
		},
	});
	return { ns, state, plan: () => JSON.parse(ns.files[PLAN]) };
}

test("the buyer buys most expensive first, and retries one whose prerequisite came later", async () => {
	const { ns, state, plan: written } = shop({ money: 1e10, prices: { "Gen II": 3e9, "Gen I": 1e9, Small: 1e8 }, needs: { "Gen II": "Gen I" } });
	await buyerMain(ns);
	assert.deepEqual(state.owned, ["Gen I", "Gen II", "Small"]);
	const after = written();
	assert.deepEqual(after.lastBuy.augs, ["Gen I", "Gen II", "Small"]);
	assert.deepEqual(after.affordable, []);
	assert.deepEqual(new Set(after.queued), new Set(["Gen I", "Gen II", "Small"]));
});

test("the buyer spends what's left on NeuroFlux while no home upgrade is affordable", async () => {
	const { ns, state, plan: written } = shop({ money: 1e9, prices: {}, neurofluxPrice: 1e8 });
	await buyerMain(ns);
	assert.equal(state.owned.length, 3); // $100m, $217m, $469m
	assert.equal(written().lastBuy.neuroflux, 3);
});

test("the buyer leaves the cash to an affordable home upgrade instead of NeuroFlux", async () => {
	const { ns, state, plan: written } = shop({ money: 1e9, prices: {}, neurofluxPrice: 1e8, gates: { "home-ram": { needCash: 5e8 } } });
	await buyerMain(ns);
	assert.deepEqual(state.owned, []);
	assert.equal(written().lastBuy.neuroflux, 0);
	assert.ok(ns.terminal.some((line) => /home upgrade/.test(line)));
});

test("the buyer refuses a plan older than 10 minutes", async () => {
	const { ns, state } = shop({ money: 1e10, prices: { A: 1e9 }, planChanges: { checkedAt: Date.now() - 11 * 60_000 } });
	await buyerMain(ns);
	assert.deepEqual(state.owned, []);
});

// --- install-augs.js ---

/** install-augs.js with these flags and plan; records the home buyers it ran and the install. */
function installer({ flags = {}, planChanges = {}, installReturns = undefined } = {}) {
	const ran = [];
	const world = fakeWorld({
		homeRam: 256,
		files: { [PLAN]: JSON.stringify(plan({ affordable: [], queued: ["A"], ...planChanges })) },
		onExec: (script, args) => { ran.push([script, ...args].join(" ")); return { exits: script !== "startup.js" }; },
		overrides: {
			flags: () => ({ force: false, "keep-cash": false, _: ["startup.js"], ...flags }),
			singularity: { installAugmentations: (after) => { ran.push(`install ${after}`); return installReturns; } },
		},
	});
	return { world, ran };
}

test("install: spends cash on home RAM then cores, logs the reset, then installs", async () => {
	const { world, ran } = installer();
	await installMain(world.ns);
	assert.deepEqual(ran, [
		"singularity/upgrade-home-ram.js --once --spend-all",
		"singularity/upgrade-home-cores.js --once --spend-all",
		"install startup.js",
	]);
	assert.equal(JSON.parse(world.ns.files["data/reset-log.json"]).length, 1);
});

test("install refuses when the advice says wait, augments are affordable but unbought, or nothing is bought", async () => {
	const cases = [
		{ decision: { reset: false, reason: "wait for X" } },
		{ affordable: ["Unbought"] },
		{ queued: [] },
	];
	for (const planChanges of cases) {
		const { world, ran } = installer({ planChanges });
		await installMain(world.ns);
		assert.ok(!ran.some((line) => line.startsWith("install")), `installed with ${JSON.stringify(planChanges)}`);
		assert.ok(world.ns.terminal.some((line) => /Not installing/.test(line)));
	}
});

test("install --force skips the advice check", async () => {
	const { world, ran } = installer({ flags: { force: true }, planChanges: { decision: { reset: false, reason: "wait" } } });
	await installMain(world.ns);
	assert.ok(ran.includes("install startup.js"));
});

test("the game refuses the install (nothing bought): startup.js is started again", async () => {
	const { world } = installer({ flags: { force: true }, installReturns: false });
	await installMain(world.ns);
	assert.ok(world.names("home").includes("startup.js"));
});
