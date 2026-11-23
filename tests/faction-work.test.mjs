// Faction work type (utils/faction-work.js) and its use in singularity/player-work.js and sleeves/plan.js.
// Regression: player-work always asked for hacking work, which Slum Snakes and Tetrads don't offer, so the crime factions
// the Bladeburner route joins for their augments were never worked for; and joined factions missing from factionWork.order
// (crime factions, Silhouette, The Covenant, Illuminati, MegaCorp, KuaiGong International, Four Sigma) never got rep goals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { FACTION_WORK, workTypeRates, factionWorkOrder, goalFactions } from "/utils/faction-work.js";
import { factionWorkStep } from "/singularity/player-work.js";
import { DEFAULTS } from "/config.js";

const person = (skills) => ({ skills: { hacking: 1, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0, ...skills } });
const hacker = person({ hacking: 1000 });
const fighter = person({ hacking: 100, strength: 900, defense: 900, dexterity: 900, agility: 900, charisma: 1000 });

test("game: Slum Snakes and Tetrads offer no hacking work, Bladeburners none at all (FactionInfo.tsx)", () => {
	assert.deepEqual(FACTION_WORK["Slum Snakes"], ["field", "security"]);
	assert.deepEqual(FACTION_WORK.Tetrads, ["field", "security"]);
	assert.deepEqual(FACTION_WORK.Bladeburners, []);
	assert.deepEqual(FACTION_WORK.CyberSec, ["hacking"]);
});

test("regression: a faction without hacking work gets one it offers, even when hacking is configured", () => {
	assert.equal(factionWorkOrder("Slum Snakes", "hacking", hacker).includes("hacking"), false);
	assert.equal(factionWorkOrder("Tetrads", "auto", hacker).length, 2);
});

test("game: the rep rates follow reputation.ts (hacking = hack + int/3; field and security weigh the combat skills)", () => {
	const rates = workTypeRates(person({ hacking: 300, intelligence: 30, strength: 100, defense: 100, dexterity: 100, agility: 100, charisma: 50 }));
	assert.equal(rates.hacking, 300 + 30 / 3);
	assert.equal(rates.security, (0.9 * (400 + 330)) / 4.5);
	assert.equal(rates.field, (0.9 * (400 + 50 + 330)) / 5.5);
	const withShare = workTypeRates(hacker, { sharePower: 1.5 });
	assert.equal(withShare.hacking, workTypeRates(hacker).hacking * 1.5, "share power multiplies hacking work");
});

test("auto picks the kind that earns most: hacking for a hacker, field for a fighter with high charisma, security without", () => {
	assert.equal(factionWorkOrder("Sector-12", "auto", hacker)[0], "hacking");
	assert.equal(factionWorkOrder("Sector-12", "auto", fighter)[0], "field");
	assert.equal(factionWorkOrder("Fulcrum Secret Technologies", "auto", fighter)[0], "security", "Fulcrum offers no field work");
	const plainFighter = { skills: { ...fighter.skills, charisma: 100 } };
	assert.equal(factionWorkOrder("Sector-12", "auto", plainFighter)[0], "security", "field's charisma term doesn't make up for its larger divisor");
});

test("a configured work type goes first wherever the faction offers it", () => {
	assert.deepEqual(factionWorkOrder("Sector-12", "security", hacker), ["security", "hacking", "field"], "then the rest, best first");
	assert.deepEqual(factionWorkOrder("CyberSec", "field", fighter), ["hacking"]);
	assert.deepEqual(factionWorkOrder("Unknown faction"), ["hacking", "field", "security"], "unknown factions may offer anything");
});

test("joined factions missing from the order are appended, in the order joined; unjoined ones never are", () => {
	const order = ["Daedalus", "CyberSec"];
	assert.deepEqual(goalFactions(order, ["CyberSec", "Slum Snakes", "Bladeburners", "Illuminati"]), ["Daedalus", "CyberSec", "Slum Snakes", "Illuminati"]);
	assert.deepEqual(goalFactions(order, []), order);
});

test("choice: the default work type is auto", () => {
	assert.equal(DEFAULTS.factionWork.workType, "auto");
});

function workNs(refuse = []) {
	return fakeNs({ overrides: {
		getResetInfo: () => ({ ownedSF: new Map() }),
		singularity: { workForFaction: (_faction, type) => !refuse.includes(type) },
	} });
}
const state = (workType = "auto") => ({ config: { factionWork: { workType } }, focus: false });

test("player-work starts the best offered work, and leaves it alone once doing it", () => {
	const ns = workNs();
	const s = state();
	assert.equal(factionWorkStep(ns, s, fighter, null, "Slum Snakes"), "field");
	const current = { type: "FACTION", factionName: "Slum Snakes", factionWorkType: "field" };
	assert.equal(factionWorkStep(ns, s, fighter, current, "Slum Snakes"), "");
	assert.equal(ns.called("singularity.workForFaction").length, 1, "no restart while already doing the best work");
});

test("a work type the game refuses is skipped from then on", () => {
	const ns = workNs(["field"]);
	const s = state();
	assert.equal(factionWorkStep(ns, s, fighter, null, "Sector-12"), "security");
	const current = { type: "FACTION", factionName: "Sector-12", factionWorkType: "security" };
	assert.equal(factionWorkStep(ns, s, fighter, current, "Sector-12"), "");
	assert.deepEqual(ns.called("singularity.workForFaction").map((args) => args[1]), ["field", "security"], "field was not asked for again");
});
