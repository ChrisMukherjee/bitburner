// singularity/buy-augs.js main with --plan, --dry and the buying hand-over: what it writes to data/aug-plan.json (read by
// auto-reset, status, donate-rep and the buyer) for a small game world. The reset decision itself is covered in
// reset-rule.test.mjs; this checks the plumbing around it: which augments are listed, in what order, what is unlockable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { main } from "/singularity/buy-augs.js";

const NOW = 1_700_000_000_000;
const HOUR = 3600_000;

/**
 * @param {object} o
 * @param {Record<string, { rep: number, augs: string[] }>} o.factions joined factions with their rep and what they sell
 * @param {Record<string, { price: number, rep: number, stats: object }>} o.augs
 */
function planWorld({ factions, augs, owned = [], installed = [], cash = 1e12, args = { plan: true }, files = {}, ports = {}, hacking = 500 }) {
	const spawned = [];
	const ns = fakeNs({
		files: { "data/config.json": JSON.stringify({}), ...files }, ports,
		overrides: {
			flags: (schema) => ({ ...Object.fromEntries(schema.map(([name, value]) => [name, value])), ...args }),
			getResetInfo: () => ({ currentNode: 1, ownedSF: new Map([[4, 3]]), lastAugReset: NOW - 3 * HOUR, ownedAugs: new Map() }),
			getPlayer: () => ({ factions: Object.keys(factions), money: cash, mults: { faction_rep: 1 }, exp: { hacking: 1000 }, skills: { hacking } }),
			getServerMoneyAvailable: () => cash,
			getTotalScriptIncome: () => [0, 0],
			getMoneySources: () => ({ sinceInstall: { hacking: 1e9 }, sinceStart: { hacking: 1e9 } }),
			getFavorToDonate: () => 150,
			serverExists: () => false,
			format: { number: (v) => String(Math.round(v)), percent: (v) => `${Math.round(v * 100)}%`, time: (ms) => `${Math.round(ms / 1000)}s` },
			spawn: (...args) => { spawned.push(args); },
			singularity: {
				getOwnedAugmentations: (purchased) => (purchased ? [...installed, ...owned] : installed),
				getFactionRep: (faction) => factions[faction]?.rep ?? 0,
				getAugmentationsFromFaction: (faction) => factions[faction]?.augs ?? [],
				getAugmentationStats: (aug) => augs[aug]?.stats ?? {},
				getAugmentationRepReq: (aug) => augs[aug]?.rep ?? 0,
				getAugmentationPrice: (aug) => augs[aug]?.price ?? 1e6,
				getFactionFavor: () => 0,
				getFactionInviteRequirements: () => [],
				getAugmentationFactions: () => [],
			},
		},
	});
	return { ns, spawned, plan: () => JSON.parse(ns.files["data/aug-plan.json"]) };
}

async function plan(options) {
	const realNow = Date.now;
	Date.now = () => NOW;
	try {
		const world = planWorld(options);
		await main(world.ns);
		return world;
	} finally {
		Date.now = realNow;
	}
}

const hackAug = (price, rep, mult = 1.15) => ({ price, rep, stats: { hacking: mult } });
const useless = (price, rep) => ({ price, rep, stats: { charisma: 1.2, work_money: 1.3 } });

test("--plan lists the useful augments the rep allows, most expensive first, and buys nothing", async () => {
	const world = await plan({
		factions: { CyberSec: { rep: 5000, augs: ["Cheap", "Pricey", "Junk"] } },
		augs: { Cheap: hackAug(1e6, 1000), Pricey: hackAug(5e6, 2000), Junk: useless(2e6, 100) },
	});
	const written = world.plan();
	assert.deepEqual(written.buyList.map((entry) => entry.aug), ["Pricey", "Cheap"], "dearest first, since each purchase raises the rest; junk skipped");
	assert.ok(written.buyList.every((entry) => entry.faction === "CyberSec"));
	assert.deepEqual(written.affordable, ["Pricey", "Cheap"]);
	assert.equal(world.spawned.length, 0, "--plan never starts the buyer");
	assert.equal(world.ns.called("singularity.purchaseAugmentation").length, 0);
});

test("without --plan or --dry it hands over to the buyer, keeping the reserve", async () => {
	const world = await plan({
		args: { reserve: 5e9 },
		factions: { CyberSec: { rep: 5000, augs: ["Cheap"] } }, augs: { Cheap: hackAug(1e6, 1000) },
	});
	assert.equal(world.spawned.length, 1);
	assert.equal(world.spawned[0][0], "singularity/workers/aug-buyer.js");
	assert.deepEqual(world.spawned[0].slice(2), ["--reserve", 5e9]);
	const noReserve = await plan({ args: {}, factions: { CyberSec: { rep: 5000, augs: ["Cheap"] } }, augs: { Cheap: hackAug(1e6, 1000) } });
	assert.deepEqual(noReserve.spawned[0].slice(2), [], "no reserve flag passed when 0");
});

test("--dry writes the plan too, prints the advice and still doesn't buy", async () => {
	const world = await plan({ args: { dry: true }, factions: { CyberSec: { rep: 5000, augs: ["Cheap"] } }, augs: { Cheap: hackAug(1e6, 1000) } });
	assert.equal(world.spawned.length, 0);
	assert.ok(world.ns.terminal.length > 0, "advice printed");
	assert.deepEqual(world.plan().buyList.map((entry) => entry.aug), ["Cheap"]);
});

test("--all buys useless augments too; an owned augment is never listed", async () => {
	const factions = { CyberSec: { rep: 5000, augs: ["Cheap", "Junk", "Have"] } };
	const augs = { Cheap: hackAug(1e6, 1000), Junk: useless(2e6, 100), Have: hackAug(1e6, 10) };
	const world = await plan({ args: { plan: true, all: true }, factions, augs, installed: ["Have"] });
	assert.deepEqual(world.plan().buyList.map((entry) => entry.aug).sort(), ["Cheap", "Junk"]);
});

test("an augment whose rep is short is 'unlockable' with how much is missing, from the faction closest to it, not 'affordable'", async () => {
	const world = await plan({
		factions: { CyberSec: { rep: 900, augs: ["Far"] }, NiteSec: { rep: 4000, augs: ["Far"] } },
		augs: { Far: hackAug(3e6, 5000) },
	});
	const written = world.plan();
	assert.deepEqual(written.buyList, [], "nothing to buy yet");
	assert.equal(written.unlockable.length, 1, "listed once even though two factions sell it");
	assert.equal(written.unlockable[0].aug, "Far");
	assert.equal(written.unlockable[0].faction, "NiteSec", "the faction with more rep is closer");
	assert.equal(written.unlockable[0].missing, 1000);
});

test("an augment another faction already unlocks is not also listed as locked", async () => {
	const world = await plan({
		factions: { CyberSec: { rep: 900, augs: ["Both"] }, NiteSec: { rep: 9000, augs: ["Both"] } },
		augs: { Both: hackAug(3e6, 5000) },
	});
	assert.deepEqual(world.plan().unlockable, []);
	assert.deepEqual(world.plan().buyList.map((entry) => [entry.aug, entry.faction]), [["Both", "NiteSec"]], "bought from the faction that has the rep");
});

test("affordable counts only what the cash covers, in the buy order, and cost is their total", async () => {
	const world = await plan({
		cash: 6.5e6,
		factions: { CyberSec: { rep: 5000, augs: ["A", "B", "C"] } },
		augs: { A: hackAug(5e6, 100), B: hackAug(1e6, 100), C: hackAug(0.9e6, 100) },
	});
	const written = world.plan();
	assert.ok(written.affordable.includes("A"), "the dearest comes first and fits");
	const total = written.affordable.reduce((sum, aug, index) => sum + { A: 5e6, B: 1e6, C: 0.9e6 }[aug] * 1.9 ** index, 0);
	assert.ok(Math.abs(written.cost - total) < 1, `cost ${written.cost} should be the price total with the rising step, ${total}`);
	assert.ok(written.cost <= 6.5e6, "never plans more than the cash");
});

test("a plan from before the last install doesn't give rep rates; two checks apart measure them", async () => {
	const stale = { time: NOW - 30 * HOUR, checkedAt: NOW - 30 * HOUR, rep: { CyberSec: 0 }, perSecond: { CyberSec: 99 } };
	let world = await plan({ files: { "data/aug-plan.json": JSON.stringify(stale) }, factions: { CyberSec: { rep: 5000, augs: [] } }, augs: {} });
	assert.deepEqual(world.plan().perSecond, {}, "the old run's rate is not carried over");
	const lastCheck = { time: NOW - 10 * 60_000, checkedAt: NOW - 10 * 60_000, rep: { CyberSec: 3800 }, perSecond: {} };
	world = await plan({ files: { "data/aug-plan.json": JSON.stringify(lastCheck) }, factions: { CyberSec: { rep: 5000, augs: [] } }, augs: {} });
	assert.ok(Math.abs(world.plan().perSecond.CyberSec - 2) < 1e-9, "1200 rep in 600 s");
});

test("NeuroFlux isn't a normal buy-list entry: its faction is named so the buyer can buy levels", async () => {
	const factions = { CyberSec: { rep: 5000, augs: ["NeuroFlux Governor", "Cheap"] } };
	const augs = { Cheap: hackAug(1e6, 1000), "NeuroFlux Governor": { price: 1e6, rep: 500, stats: { hacking: 1.01 } } };
	let world = await plan({ factions, augs });
	assert.deepEqual(world.plan().buyList.map((entry) => entry.aug), ["Cheap"]);
	assert.equal(world.plan().neurofluxFaction, "CyberSec");
	world = await plan({ args: { plan: true, "no-neuroflux": true }, factions, augs });
	assert.equal(world.plan().neurofluxFaction, null, "--no-neuroflux");
});

test("without the Singularity API it exits before writing anything", async () => {
	const ns = fakeNs({ overrides: { getResetInfo: () => ({ currentNode: 1, ownedSF: new Map(), lastAugReset: 0 }), getScriptName: () => "singularity/buy-augs.js" } });
	await main(ns);
	assert.equal("data/aug-plan.json" in ns.files, false);
});

test("rep that went down (spent, or a graft) gives no negative rate, and a faction first seen now has none", async () => {
	const last = { time: NOW - 10 * 60_000, checkedAt: NOW - 10 * 60_000, rep: { CyberSec: 6000 }, perSecond: {} };
	const world = await plan({
		files: { "data/aug-plan.json": JSON.stringify(last) },
		factions: { CyberSec: { rep: 5000, augs: [] }, NiteSec: { rep: 100, augs: [] } }, augs: {},
	});
	assert.deepEqual(world.plan().perSecond, {});
});

test("stocks count toward what is affordable only while the trader's summary is fresh", async () => {
	const factions = { CyberSec: { rep: 5000, augs: ["Pricey"] } };
	const augs = { Pricey: hackAug(5e8, 100) };
	const summary = (time) => ({ 26: { time, value: 1e9 } });
	const fresh = await plan({ cash: 1e6, factions, augs, ports: summary(NOW - 60_000) });
	assert.deepEqual(fresh.plan().affordable, ["Pricey"], "positions sell before the reset, so they count");
	assert.equal(fresh.plan().stocks, 1e9);
	const old = await plan({ cash: 1e6, factions, augs, ports: summary(NOW - 6 * 60_000) });
	assert.deepEqual(old.plan().affordable, [], "a summary over 5 minutes old is not trusted");
	assert.equal(old.plan().stocks, 0);
});

test("Daedalus push: when only the installed-augment count blocks the invite, the plan names the cheapest fill", async () => {
	const requirements = (money) => [{ type: "numAugmentations", numAugmentations: 3 }, { type: "money", money }, { type: "skills", skills: { hacking: 2500 } }];
	const factions = { CyberSec: { rep: 5000, augs: ["Dear", "Cheap1", "Cheap2"] } };
	const augs = { Dear: hackAug(9e8, 100), Cheap1: hackAug(1e6, 100), Cheap2: hackAug(2e6, 100) };
	const world = planWorld({ cash: 1e12, hacking: 3000, factions, augs, installed: ["Old"] });
	world.ns.singularity.getFactionInviteRequirements = () => requirements(1e9);
	const realNow = Date.now;
	Date.now = () => NOW;
	try { await main(world.ns); } finally { Date.now = realNow; }
	const push = world.plan().daedalusPush;
	assert.ok(push, "every other requirement is met");
	assert.equal(push.need, 3);
	assert.equal(push.installed, 1);
	assert.equal(push.missing, 2);
	assert.ok(push.fill.length >= 2 && push.fill.slice(0, 2).every((aug) => aug.startsWith("Cheap")), `the cheapest are used, got ${push.fill}`);
	// And with hacking short of the requirement, the count isn't what blocks the invite, so no push.
	const short = planWorld({ cash: 1e12, hacking: 100, factions, augs, installed: ["Old"] });
	short.ns.singularity.getFactionInviteRequirements = () => requirements(1e9);
	Date.now = () => NOW;
	try { await main(short.ns); } finally { Date.now = realNow; }
	assert.equal(short.plan().daedalusPush, null);
});
