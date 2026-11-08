// utils/aug-filter.js: which augments are worth buying and what they are worth to the reset rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { wantedBoosts, augValue, unknownStatGroups } from "/utils/aug-filter.js";
import { loadConfig } from "/utils/config.js";

const augments = (ns = fakeNs()) => loadConfig(ns).augments;

test("a hacking augment is wanted on the default (hacking) route; a combat one isn't", () => {
	const config = augments();
	assert.equal(wantedBoosts("BitWire", { hacking: 1.05 }, config), "hack +5%");
	assert.equal(wantedBoosts("Combat Rib", { strength: 1.1, defense: 1.1 }, config), "");
	assert.ok(augValue("BitWire", { hacking: 1.05 }, config) > 0);
	assert.equal(augValue("Combat Rib", { strength: 1.1 }, config), 0);
});

test("special augments are wanted whatever they boost; `never` wins over everything", () => {
	const config = augments();
	assert.match(wantedBoosts("The Red Pill", {}, config), /destroy/);
	config.never = ["BitWire"];
	assert.equal(wantedBoosts("BitWire", { hacking: 1.05 }, config), "");
	assert.equal(augValue("BitWire", { hacking: 1.05 }, config), 0);
});

test("lower-is-better stats count when they go down", () => {
	const post = { time: Date.now(), sinceInstall: { hacknet: 1e9 }, sinceStart: {} }; // hacknet pays, so its stats count
	const config = augments(fakeNs({ ports: { 38: post } }));
	assert.match(wantedBoosts("Hacknet thing", { hacknet_node_purchase_cost: 0.85 }, config), /-15%/);
});

test("value is the weighted sum of ln(multiplier), so two augments add up", () => {
	const config = augments();
	const one = augValue("A", { hacking: 1.1 }, config);
	const both = augValue("AB", { hacking: 1.1 * 1.1 }, config);
	assert.ok(Math.abs(both - 2 * one) < 1e-12);
});

test("money stats follow the income mix: hacknet money isn't wanted when hacking pays everything", () => {
	const post = { time: Date.now(), sinceInstall: { hacking: 1e9 }, sinceStart: {} };
	const config = augments(fakeNs({ ports: { 38: post } }));
	assert.equal(wantedBoosts("Hacknet Money", { hacknet_node_money: 1.25 }, config), "");
	assert.equal(augValue("Hacknet Money", { hacknet_node_money: 1.25 }, config), 0);
});

test("the Bladeburner route wants combat augments and stops valuing hacking", () => {
	const config = augments(fakeNs({ ports: { 36: { state: "train", stateTime: Date.now() } } }));
	assert.notEqual(wantedBoosts("Combat Rib", { strength: 1.1 }, config), "");
	assert.equal(wantedBoosts("BitWire", { hacking: 1.05 }, config), "");
});

test("typos in wantStats are reported", () => {
	const config = augments();
	config.wantStats = ["hacking", "hackin"];
	assert.deepEqual(unknownStatGroups(config), ["hackin"]);
});
