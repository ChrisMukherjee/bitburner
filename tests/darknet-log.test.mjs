// How often the darknet manager reports (summaryDue), and that the contract solver stays quiet in the terminal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { summaryDue } from "/darknet/dnet-manager.js";
import { main as solverMain } from "/contracts/workers/contract-solver.js";

const MIN = 60000;

test("terminal summary comes every terminalMinutes, the log every logMinutes", () => {
	const settings = { logMinutes: 5, terminalMinutes: 30 };
	const last = { lastLog: 0, lastTerminal: 0 };
	assert.deepEqual(summaryDue(4 * MIN, last, settings), { log: false, terminal: false });
	assert.deepEqual(summaryDue(5 * MIN, last, settings), { log: true, terminal: false });
	assert.deepEqual(summaryDue(30 * MIN, last, settings), { log: true, terminal: true });
});

test("an urgent event prints to both at once; terminalMinutes 0 silences the periodic line", () => {
	const last = { lastLog: 0, lastTerminal: 0 };
	assert.deepEqual(summaryDue(MIN, last, { logMinutes: 5, terminalMinutes: 30 }, true), { log: true, terminal: true });
	assert.equal(summaryDue(999 * MIN, last, { terminalMinutes: 0 }).terminal, false);
});


test("contract solver prints nothing to the terminal when it solves a contract", async () => {
	const ns = fakeNs({ overrides: {
		args: [JSON.stringify([["n00dles", "a.cct"]])],
		codingcontract: {
			getContractType: () => "Find Largest Prime Factor",
			getData: () => 15,
			attempt: () => "reward",
		},
	} });
	await solverMain(ns);
	assert.deepEqual(ns.terminal, []);
	assert.ok(ns.logs.some((line) => line.includes("successfully solved 1")));
});
