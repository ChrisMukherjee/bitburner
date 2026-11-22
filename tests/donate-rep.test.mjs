// singularity/donate-rep.js: spends cash on faction rep for the key augment (The Red Pill by default) and, beyond the
// reset's planned purchases, for other wanted augments. A donation can't be taken back, so these check when it donates,
// how much, that it never dips into money the plan already needs, and what it tells startup.js on port 33.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { main, otherDonation } from "/singularity/donate-rep.js";

const GATE_PORT = 33;
const RED_PILL = "The Red Pill";

/**
 * @param {object} o
 * @param {Record<string, number>} [o.rep] faction -> current rep
 * @param {Record<string, number>} [o.favor] faction -> favor
 * @param {number} [o.cash]
 * @param {string[]} [o.joined]
 * @param {string[]} [o.owned]
 * @param {number} [o.repNeeded] rep the key augment needs
 * @param {number} [o.repMult] player faction_rep multiplier
 * @param {number} [o.gainFactor] the share of the expected rep a donation really gives (a BitNode multiplier below 1 shrinks it)
 * @param {object | null} [o.plan] data/aug-plan.json
 * @param {object} [o.config] data/config.json
 */
function donateWorld({ rep = {}, favor = {}, cash = 1e12, joined = [], owned = [], repNeeded = 2.5e4, repMult = 1, gainFactor = 1, plan = null, config = {}, sellers = ["Daedalus"] } = {}) {
	const state = { rep: { ...rep }, cash };
	const donations = [];
	const ns = fakeNs({
		files: { ...(plan ? { "data/aug-plan.json": JSON.stringify(plan) } : {}), "data/config.json": JSON.stringify(config) },
		overrides: {
			flags: (schema) => Object.fromEntries(schema.map(([name, value]) => [name, value])),
			getFavorToDonate: () => 150,
			getPlayer: () => ({ factions: joined, mults: { faction_rep: repMult } }),
			getServerMoneyAvailable: () => state.cash,
			format: { number: (v) => String(Math.round(v)) },
			singularity: {
				getOwnedAugmentations: () => owned,
				getAugmentationRepReq: () => repNeeded,
				getAugmentationFactions: () => sellers,
				getFactionFavor: (faction) => favor[faction] ?? 0,
				getFactionRep: (faction) => state.rep[faction] ?? 0,
				getAugmentationPrice: () => 1e6,
				donateToFaction: (faction, amount) => {
					if (amount > state.cash) return false;
					state.cash -= amount;
					state.rep[faction] = (state.rep[faction] ?? 0) + (amount / 1e6) * repMult * gainFactor;
					donations.push([faction, amount]);
					return true;
				},
			},
		},
	});
	return { ns, state, donations, gate: () => ns.portJson(GATE_PORT)?.donate ?? null };
}
const withDry = (world) => { world.ns.flags = () => ({ dry: true }); return world; };

test("donates enough for the key augment once the faction has the favor, and tells the player and stops being called", async () => {
	const world = donateWorld({ joined: ["Daedalus"], favor: { Daedalus: 150 }, rep: { Daedalus: 0 } });
	await main(world.ns);
	assert.equal(world.donations.length, 1);
	const [faction, amount] = world.donations[0];
	assert.equal(faction, "Daedalus");
	assert.ok(world.state.rep.Daedalus >= 2.5e4, "the rep is enough for the augment");
	assert.ok(amount <= 2.5e4 * 1e6 * 1.02, "about 1.01x the exact price, not more");
	assert.equal(world.gate().done, true, "nothing left to donate this run: startup stops calling it");
	assert.ok(world.ns.terminal.some((line) => /Daedalus: The Red Pill is unlocked/.test(line)), "the player is told");
});

test("with less favor than the donation threshold it donates nothing", async () => {
	const world = donateWorld({ joined: ["Daedalus"], favor: { Daedalus: 149 } });
	await main(world.ns);
	assert.equal(world.donations.length, 0);
	assert.equal(world.gate().done, true, "no seller has the favor: nothing more to do this run, startup stops calling it");
});

test("a joined faction is needed: favor without the invite waits instead of donating", async () => {
	const world = donateWorld({ joined: [], favor: { Daedalus: 200 } });
	await main(world.ns);
	assert.equal(world.donations.length, 0);
	assert.equal(world.gate().needCash, 0);
	assert.equal(world.gate().done, undefined);
});

test("not enough cash: nothing donated and the gate carries the cash it needs, so startup waits for it", async () => {
	const world = donateWorld({ joined: ["Daedalus"], favor: { Daedalus: 150 }, cash: 1e9 });
	await main(world.ns);
	assert.equal(world.donations.length, 0);
	const needed = world.gate().needCash;
	assert.ok(needed > 1e9, `needs more than the 1e9 it has, got ${needed}`);
	assert.ok(needed >= 2.5e4 * 1e6, "at least the exact price of the missing rep");
});

test("the rep multiplier lowers the price per rep", async () => {
	const one = donateWorld({ joined: ["Daedalus"], favor: { Daedalus: 150 }, repMult: 1 });
	const two = donateWorld({ joined: ["Daedalus"], favor: { Daedalus: 150 }, repMult: 2 });
	await main(one.ns);
	await main(two.ns);
	assert.ok(Math.abs(one.donations[0][1] / two.donations[0][1] - 2) < 0.01, "double the rep per dollar halves the donation");
});

test("when a BitNode makes donations pay less than expected it tops up at the rate it saw, then stops", async () => {
	const world = donateWorld({ joined: ["Daedalus"], favor: { Daedalus: 150 }, gainFactor: 0.5 });
	await main(world.ns);
	assert.ok(world.donations.length >= 2, "the first donation fell short, so it donates again");
	assert.ok(world.donations.length <= 3, "at most three rounds");
	assert.ok(world.state.rep.Daedalus >= 2.5e4, "and the top-ups use the measured rate, so the rep ends up enough");
});

test("a key augment already owned, or already unlocked by rep, costs nothing", async () => {
	let world = donateWorld({ joined: ["Daedalus"], favor: { Daedalus: 150 }, owned: [RED_PILL] });
	await main(world.ns);
	assert.equal(world.donations.length, 0);
	assert.equal(world.gate().done, true, "owned: done for the run");
	world = donateWorld({ joined: ["Daedalus"], favor: { Daedalus: 150 }, rep: { Daedalus: 3e4 } });
	await main(world.ns);
	assert.equal(world.donations.length, 0, "the rep is already there");
	assert.equal(world.gate().needCash, 0, "waiting for auto-reset to buy it");
});

test("--dry says what it would donate and neither donates nor posts a gate", async () => {
	const world = withDry(donateWorld({ joined: ["Daedalus"], favor: { Daedalus: 150 } }));
	await main(world.ns);
	assert.equal(world.donations.length, 0);
	assert.equal(world.ns.portJson(GATE_PORT), null);
	assert.ok(world.ns.terminal.some((line) => /would donate/.test(line)));
});

// --- other wanted augments, from cash beyond the plan ---

const plan = (extra = {}) => ({
	checkedAt: Date.now(), affordable: ["a", "b"], cost: 4e9, priceStep: 1.9,
	unlockable: [{ aug: "Neuro", faction: "CyberSec", repNeeded: 1e5, value: 10 }], ...extra,
});
const wanted = { joined: ["CyberSec"], favor: { CyberSec: 150 }, rep: { CyberSec: 0 }, sellers: ["Daedalus"], owned: [RED_PILL] };

test("other augments: off unless donations.anyFaction is on, and never from a missing or old plan", async () => {
	const off = donateWorld({ ...wanted, plan: plan(), config: { augments: { donations: { anyFaction: false } } } });
	await main(off.ns);
	assert.equal(off.donations.length, 0, "kill switch");
	const old = donateWorld({ ...wanted, plan: plan({ checkedAt: Date.now() - 31 * 60_000 }) });
	await main(old.ns);
	assert.equal(old.donations.length, 0, "a plan older than 30 minutes says nothing about this reset");
	const none = donateWorld({ ...wanted });
	await main(none.ns);
	assert.equal(none.donations.length, 0);
});

test("other augments: donates only when cash covers the planned purchases plus the donation plus the augment, with a safety margin", async () => {
	const amount = 1e5 * 1e6 * 1.01; // missing rep at 1 rep per 1e6 dollars, plus the 1% margin
	const price = 1e6 * 1.9 ** 2;      // price after the 2 planned augments
	const required = (4e9 + amount + price) * 1.25;
	const short = donateWorld({ ...wanted, plan: plan(), cash: required - 1 });
	await main(short.ns);
	assert.equal(short.donations.length, 0, "a dollar short of the safety margin");
	assert.equal(short.gate().needCash, Math.ceil(required) === required ? required : short.gate().needCash);
	assert.ok(Math.abs(short.gate().needCash - required) < 2, `asks for ${short.gate().needCash}, expected ${required}`);
	const enough = donateWorld({ ...wanted, plan: plan(), cash: required + 1 });
	await main(enough.ns);
	assert.equal(enough.donations.length, 1);
	assert.equal(enough.donations[0][0], "CyberSec");
	assert.ok(enough.state.cash >= 4e9, "the planned purchases' cash is still there afterwards");
});

test("otherDonation picks the best value per dollar and skips owned augments and factions without favor", () => {
	const ns = fakeNs({
		overrides: {
			read: () => JSON.stringify(plan({ unlockable: [
				{ aug: "Cheap", faction: "A", repNeeded: 1e5, value: 10 },
				{ aug: "Better", faction: "A", repNeeded: 1e5, value: 50 },
				{ aug: "Owned", faction: "A", repNeeded: 1e5, value: 999 },
				{ aug: "NoFavor", faction: "B", repNeeded: 1e5, value: 999 },
				{ aug: "NotJoined", faction: "C", repNeeded: 1e5, value: 999 },
			] })),
			singularity: { getFactionFavor: (f) => (f === "B" ? 10 : 200), getFactionRep: () => 0, getAugmentationPrice: () => 1e6 },
		},
	});
	const best = otherDonation(ns, { anyFaction: true, safety: 1 }, { factions: ["A", "B"] }, 150, new Set(["Owned"]), 1e-6);
	assert.equal(best.aug, "Better");
	assert.equal(best.faction, "A");
});
