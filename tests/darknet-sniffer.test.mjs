// OpenWebAccessPoint solver in darknet/feedback-solvers.js, checked against a copy of the game's packet capture
// (bitburner-src DarkNet/models/packetSniffing.ts, capturePackets).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { sniffCandidates, solvePacketSniffer } from "/darknet/feedback-solvers.js";

const digits = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join("");

/** The game's capture: easy servers write " host:password " into noise, hard ones hide the bare password in random data. */
function capture(host, password, difficulty) {
	const passwordData = difficulty > 16 ? password : ` ${host}:${password} `;
	const noise = digits(124 + Math.floor(Math.random() * 20));
	const at = Math.floor(Math.random() * (noise.length - passwordData.length));
	return noise.slice(0, at) + passwordData + noise.slice(at);
}
function nsFor(host, password, difficulty) {
	const tried = [];
	const ns = fakeNs({ overrides: { dnet: { authenticate: async (_host, guess) => {
		tried.push(guess);
		if (guess === password) return { success: true, code: 200 };
		return { success: false, code: 401, message: "no", data: capture(host, password, difficulty) };
	} } } });
	return { ns, tried };
}

test("host-marked packets give the password directly", () => {
	const { marked } = sniffCandidates("123 darkhost:4829017 556", "darkhost", 7, "numeric");
	assert.equal(marked, "4829017");
});

test("hard servers: the password is the run common to every capture", async () => {
	for (let i = 0; i < 20; i++) {
		const password = digits(7);
		const { ns, tried } = nsFor("h", password, 30);
		const result = await solvePacketSniffer(ns, "h", { passwordLength: 7, passwordFormat: "numeric" });
		assert.equal(result.password, password);
		assert.ok(tried.length <= 6);
	}
});

test("easy servers: the marked password opens it on the second login", async () => {
	const { ns, tried } = nsFor("cafe-1", "1234567", 5);
	const result = await solvePacketSniffer(ns, "cafe-1", { passwordLength: 7, passwordFormat: "numeric" });
	assert.equal(result.password, "1234567");
	assert.equal(tried.length, 2);
});

test("unknown length is left unsolved without any login", async () => {
	const { ns, tried } = nsFor("h", "1234567", 5);
	const result = await solvePacketSniffer(ns, "h", {});
	assert.equal(result.password, undefined);
	assert.equal(tried.length, 0);
});
