// DeepGreen (Mastermind) and Factori-Os solvers in darknet/feedback-solvers.js, against a copy of the game's replies
// (bitburner-src DarkNet/effects/authentication.ts and utils/darknetAuthUtils.ts).
// Regressions: a guess of the wrong length, losing the guess history between runs, ignoring the "I can see a 8 and a 6" log
// clues, and reading no usable reply from a Factori-Os answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { solveMastermind, solveDivisibility, isDivisible } from "/darknet/feedback-solvers.js";
import { readLogs, parseClue, parseMastermindReply } from "/darknet/heartbleed.js";

/** The game's scoring, copied. */
function score(password, attempt) {
	const exact = password.split("").filter((digit, i) => digit === attempt[i]).length;
	const restPassword = password.split("").filter((digit, i) => digit !== attempt[i]);
	const restAttempt = attempt.split("").filter((digit, i) => digit !== password[i]);
	const misplaced = restAttempt.filter((digit, i) => restPassword.includes(digit)
		&& restAttempt.slice(0, i).filter((d) => d === digit).length < restPassword.filter((d) => d === digit).length).length;
	return [exact, misplaced];
}
const seeded = (seed = 1) => () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

/** A DeepGreen server: wrong guesses reply "exact,misplaced" and every attempt lands in the log, like the game's. */
function deepGreen(password, { logClues = [], hideLog = false, noData = false } = {}) {
	const tried = [];
	const log = [];
	const overrides = { dnet: {
		authenticate: async (_host, guess) => {
			tried.push(guess);
			if (guess === password) { log.unshift({ message: { code: 200, passwordAttempted: guess }, pid: 1 }); return { success: true, code: 200 }; }
			const [exact, misplaced] = score(password, guess);
			const message = `Hint: ${exact} symbols are match exactly,  and ${misplaced} symbols match but are in the wrong place.`;
			log.unshift({ message: { code: 401, message, data: `${exact},${misplaced}`, passwordAttempted: guess }, pid: 1 });
			return { success: false, code: 401, message, data: noData ? undefined : `${exact},${misplaced}` };
		},
		heartbleed: async () => {
			if (hideLog) throw new Error("no logs");
			return [...logClues.map((message) => JSON.stringify({ message, pid: -1 })), ...log.map((entry) => JSON.stringify(entry))];
		},
	} };
	const ns = fakeNs({ overrides });
	return { ns, tried, log };
}
const details = (length) => ({ passwordLength: length, passwordFormat: "numeric", modelId: "DeepGreen" });

test("Mastermind never guesses a different length than the server reports", async () => {
	for (const password of ["886", "000", "123", "999"]) {
		const { ns, tried } = deepGreen(password);
		const result = await solveMastermind(ns, "h", details(3), [], [], seeded(7));
		assert.equal(result.password, password);
		assert.ok(tried.every((guess) => guess.length === 3), `tried ${tried}`);
		assert.ok(tried.length <= 15, `took ${tried.length} guesses`);
	}
});

test("Mastermind does not repeat a guess within a run", async () => {
	const { ns, tried } = deepGreen("886");
	await solveMastermind(ns, "h", details(3), [], [], seeded(3));
	assert.equal(new Set(tried).size, tried.length);
});

test("the log's 'a 8 and a 6' clue narrows the guesses: every guess holds an 8 and a 6", async () => {
	const { ns, tried } = deepGreen("886", { logClues: ["There's definitely a 8 and a 6..."] });
	const result = await solveMastermind(ns, "h", details(3), [], [], seeded(5));
	assert.equal(result.password, "886");
	assert.ok(tried.every((guess) => guess.includes("8") && guess.includes("6")), `tried ${tried}`);
	assert.ok(tried.length <= 6, `took ${tried.length} guesses`);
});

test("a second run builds on the first run's guesses (read back from the server log)", async () => {
	const { ns, tried, log } = deepGreen("886");
	// First run stops after a few guesses (the server drops us), second run starts fresh from the log alone.
	let calls = 0;
	const real = ns.dnet.authenticate;
	ns.dnet.authenticate = async (host, guess) => (++calls > 3 ? { success: false, code: 503, message: "offline" } : real(host, guess));
	const first = await solveMastermind(ns, "h", details(3), [], [], seeded(11));
	assert.ok(first.later);
	const before = tried.length;
	ns.dnet.authenticate = real;
	const second = await solveMastermind(ns, "h", details(3), [], [], seeded(11));
	assert.equal(second.password, "886");
	const afterGuesses = tried.slice(before);
	assert.ok(afterGuesses.every((guess) => !tried.slice(0, before).includes(guess)), "repeated an earlier guess");
	assert.ok(log.length > 0);
});

test("history also survives without a readable log (kept in the server's data file)", async () => {
	const { ns, tried } = deepGreen("886", { hideLog: true });
	let calls = 0;
	const real = ns.dnet.authenticate;
	ns.dnet.authenticate = async (host, guess) => (++calls > 3 ? { success: false, code: 503, message: "offline" } : real(host, guess));
	await solveMastermind(ns, "h", details(3), [], [], seeded(2));
	const before = tried.length;
	ns.dnet.authenticate = real;
	const second = await solveMastermind(ns, "h", details(3), [], [], seeded(2));
	assert.equal(second.password, "886");
	assert.ok(tried.slice(before).every((guess) => !tried.slice(0, before).includes(guess)));
});

test("two solvers on one server share what they learn instead of repeating guesses", async () => {
	const { ns, tried } = deepGreen("473");
	await Promise.all([
		solveMastermind(ns, "h", details(3), [], [], seeded(1)),
		solveMastermind(ns, "h", details(3), [], [], seeded(1)),
	]);
	assert.ok(tried.length <= 30, `tried ${tried.length}`);
});

test("a reply with no data is read from the message", async () => {
	const { ns } = deepGreen("886", { noData: true });
	const result = await solveMastermind(ns, "h", details(3), [], [], seeded(9));
	assert.equal(result.password, "886");
});

test("a login typed by hand shows up in the log and is used", async () => {
	const { ns, tried } = deepGreen("886");
	ns.dnet.heartbleed = async () => [JSON.stringify({ message: { code: 200, passwordAttempted: "886" }, pid: 4 })];
	const result = await solveMastermind(ns, "h", details(3), [], [], seeded(1));
	assert.equal(result.password, "886");
	assert.deepEqual(tried, ["886"]);
});

test("log parsing: attempts, clues and replies", async () => {
	assert.deepEqual(parseClue("I can see a 8 and a 6."), ["8", "6"]);
	assert.deepEqual(parseClue("Theres a 3, and maybe a 3..."), ["3", "3"]);
	assert.equal(parseClue("heartbeat check (alive)"), undefined);
	assert.deepEqual(parseMastermindReply("1,2"), { exact: 1, misplaced: 2 });
	assert.deepEqual(parseMastermindReply([1, 2]), { exact: 1, misplaced: 2 });
	assert.deepEqual(parseMastermindReply(undefined, "Hint: 0 symbols are match exactly,  and 1 symbol match but is in the wrong place."), { exact: 0, misplaced: 1 });
	const { ns } = deepGreen("886", { logClues: ["I must use 8 & 6!"] });
	await ns.dnet.authenticate("h", "123");
	const logs = await readLogs(ns, "h", 50);
	assert.deepEqual(logs.clues, [["8", "6"]]);
	assert.equal(logs.observed.length, 1);
	assert.equal(logs.observed[0].guess, "123");
});

// --- Factori-Os ---

function factoriOs(password, shape) {
	const tried = [];
	const ns = fakeNs({ overrides: { dnet: { authenticate: async (_host, guess) => {
		tried.push(guess);
		if (Number(guess) === password) return { success: true, code: 200 };
		const yes = password % Number(guess) === 0;
		if (shape === "boolean") return { success: false, code: 401, message: "x", data: yes };
		if (shape === "message") return { success: false, code: 401, message: yes ? `Password IS divisible by '${guess}'` : `Password is not divisible by '${guess}'` };
		if (shape === "none") return { success: false, code: 401, message: "Unauthorized" };
		return { success: false, code: 401, message: "x", data: String(yes) };
	}, heartbleed: async () => [] } } });
	return { ns, tried };
}

test("Factori-Os reply shapes: string, boolean and message-only all find 26 by factoring", async () => {
	for (const shape of ["string", "boolean", "message"]) {
		const { ns, tried } = factoriOs(26, shape);
		const result = await solveDivisibility(ns, "h", { passwordLength: 2, passwordHint: "The password is divisible by 1 ;)" });
		assert.equal(result.password, "26", shape);
		assert.ok(tried.length < 12, `${shape}: ${tried.length} guesses`);
	}
});

test("Factori-Os: an unreadable reply stops the solver instead of walking every prime", async () => {
	const { ns, tried } = factoriOs(26, "none");
	const result = await solveDivisibility(ns, "h", { passwordLength: 2 });
	assert.equal(result.password, undefined);
	assert.equal(tried.length, 1);
	assert.equal(result.attempts.length, 1);
});

test("Factori-Os picks up a password typed by hand", async () => {
	const { ns, tried } = factoriOs(26, "string");
	ns.dnet.heartbleed = async () => [JSON.stringify({ message: { code: 200, passwordAttempted: "26" }, pid: 4 })];
	const result = await solveDivisibility(ns, "h", { passwordLength: 2 });
	assert.equal(result.password, "26");
	assert.ok(tried.length <= 12);
});

test("isDivisible", () => {
	assert.equal(isDivisible({ data: "true" }), true);
	assert.equal(isDivisible({ data: false }), false);
	assert.equal(isDivisible({ message: "Password IS divisible by '13'" }), true);
	assert.equal(isDivisible({ message: "Password is not divisible by '13'" }), false);
	assert.equal(isDivisible({ message: "Unauthorized" }), undefined);
});
