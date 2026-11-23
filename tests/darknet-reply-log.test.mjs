// The game answers a wrong darknet password with only "Unauthorized" and writes the model's reply into the server's log
// (bitburner-src v3.0.1 NetscriptFunctions/Darknet.ts authenticate; DarkNet/effects/authentication.ts). The feedback solvers
// read the reply through loginReply (darknet/heartbleed.js), which lifts it from the log.
// Regression: the solvers read the reply from authenticate's return value, which never has it, so NIL, Factori-Os, DeepGreen
// and OpenWebAccessPoint stopped after one guess in game. The older tests' fakes put the reply in the return value.
import { test } from "node:test";
import assert from "node:assert/strict";
import { darknetServer } from "./support/fake-darknet.mjs";
import { fakeNs } from "./support/fake-ns.mjs";
import { loginReply } from "/darknet/heartbleed.js";
import { solveNil, solveDivisibility, solveMastermind } from "/darknet/feedback-solvers.js";

// authentication.ts checkPassword replies for the models below.
const nilReply = (password, guess) => ({ message: "that wasn't right", data: guess.split("").map((c, i) => (c === password[i] ? "yes" : "yesn't")).join(",") });
const divisibleReply = (password, guess) => (Number(password) % Number(guess)
	? { message: `Password is not divisible by '${guess}'`, data: "false" }
	: { message: `Password IS divisible by '${guess}'`, data: "true" });
function mastermindReply(password, guess) {
	const exact = [...password].filter((c, i) => c === guess[i]).length;
	const restP = [...password].filter((c, i) => c !== guess[i]);
	const restG = [...guess].filter((c, i) => c !== password[i]);
	let misplaced = 0;
	for (const c of restG) {
		const at = restP.indexOf(c);
		if (at >= 0) { misplaced++; restP.splice(at, 1); }
	}
	return { message: `Hint: ${exact} symbols are match exactly,  and ${misplaced} symbols match but are in the wrong place.`, data: `${exact},${misplaced}` };
}

test("regression: NIL is solved when the reply is only in the server's log", async () => {
	const { ns, tried } = darknetServer("40817", nilReply);
	const result = await solveNil(ns, "h", { passwordLength: 5, passwordFormat: "numeric" });
	assert.equal(result.password, "40817");
	assert.ok(tried.length <= 11, `one guess per digit plus the answer, got ${tried.length}`);
});

test("regression: Factori-Os is solved when the reply is only in the server's log", async () => {
	const { ns } = darknetServer(String(2 * 2 * 3 * 7 * 1069), divisibleReply);
	const result = await solveDivisibility(ns, "h", { passwordLength: 5, passwordHint: "The password is divisible by 1 ;)" });
	assert.equal(result.password, String(2 * 2 * 3 * 7 * 1069));
});

test("regression: DeepGreen is solved when the reply is only in the server's log", async () => {
	const { ns } = darknetServer("5307", mastermindReply);
	const result = await solveMastermind(ns, "h", { passwordLength: 4, passwordFormat: "numeric" }, [], [], () => 0.5);
	assert.equal(result.password, "5307");
});

test("loginReply finds this guess's entry behind newer lines from other logins", async () => {
	const other = () => JSON.stringify({ code: 401, message: "Unauthorized", data: "other", passwordAttempted: "999" });
	const { ns, log } = darknetServer("12", nilReply);
	const result = await loginReply(ns, "h", "13");
	assert.equal(result.verdict, "wrong");
	assert.equal(result.data, "yes,yesn't");
	log.unshift(other(), other());
	const again = await loginReply(ns, "h", "13");
	assert.equal(again.data, "yes,yesn't", "the entry for this guess, not the newest line");
});

test("loginReply leaves a result that already has data alone and never calls heartbleed then", async () => {
	const ns = fakeNs({ overrides: { dnet: { authenticate: async () => ({ success: false, code: 401, message: "m", data: "d" }) } } });
	const result = await loginReply(ns, "h", "1");
	assert.equal(result.data, "d");
	assert.equal(ns.called("dnet.heartbleed").length, 0);
});

test("loginReply returns the plain result when the log can't be read (no charisma for heartbleed)", async () => {
	const ns = fakeNs({ overrides: { dnet: {
		authenticate: async () => ({ success: false, code: 401, message: "Unauthorized" }),
		heartbleed: async () => ({ success: false, code: 451, message: "Not Enough Charisma", logs: [] }),
	} } });
	const result = await loginReply(ns, "h", "1");
	assert.equal(result.verdict, "wrong");
	assert.equal(result.data, undefined);
});
