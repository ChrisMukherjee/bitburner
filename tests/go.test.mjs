// go/go-plan.js (which opponents come first) and go/choose-move.js (move search on tiny boards).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { loadConfig } from "/utils/config.js";
import { planSignals, goOrder, DEFAULT_ROTATION } from "/go/go-plan.js";
import { chooseMove, play, toGrid, toBoard } from "/go/choose-move.js";

const config = loadConfig(fakeNs());
const fresh = () => Date.now() - 60_000;
const stale = () => Date.now() - 3 * 3600_000;
// The game's peek hands back what was written; the fake stores JSON text, so the gang summary (written as an object) is parsed here.
const nsWith = (ports) => fakeNs({
	ports,
	overrides: { peek: (port) => { const raw = ports[port]; return port === 28 && raw ? raw : raw === undefined ? "NULL PORT DATA" : JSON.stringify(raw); } },
});

test("plan signals are all false when no mechanic posted anything", () => {
	assert.deepEqual(planSignals(nsWith({})), { gang: false, bladeburner: false, repGoals: false });
});

test("plan signals: a fresh gang summary, a running Bladeburner state and an open Daedalus rep goal", () => {
	const signals = planSignals(nsWith({
		28: { time: fresh() },
		36: { state: "run", stateTime: fresh() },
		23: { time: fresh(), goals: { Daedalus: { rep: 5000 } } },
	}));
	assert.deepEqual(signals, { gang: true, bladeburner: true, repGoals: true });
});

test("plan signals ignore stale posts and a Bladeburner that is only holding or off", () => {
	const old = planSignals(nsWith({
		28: { time: stale() },
		36: { state: "run", stateTime: stale() },
		23: { time: stale(), goals: { Daedalus: { rep: 5000 } } },
	}));
	assert.deepEqual(old, { gang: false, bladeburner: false, repGoals: false });
	assert.equal(planSignals(nsWith({ 36: { state: "hold", stateTime: fresh() } })).bladeburner, false);
	assert.equal(planSignals(nsWith({ 23: { time: fresh(), goals: { Daedalus: { rep: 0 } } } })).repGoals, false);
	assert.equal(planSignals(nsWith({ 23: { time: fresh(), goals: {} } })).repGoals, false);
});

test("goOrder with nothing running is the focus, then the rotation, with no duplicates", () => {
	const { order, boosted } = goOrder(nsWith({}), config, "Netburners");
	assert.deepEqual(boosted, []);
	assert.equal(order[0], "Netburners");
	assert.deepEqual(order, ["Netburners", ...config.go.rotation.filter((name) => name !== "Netburners")]);
});

test("goOrder puts the opponents the running plan uses ahead of the focus", () => {
	const ns = nsWith({ 36: { state: "run", stateTime: fresh() }, 23: { time: fresh(), goals: { Daedalus: { rep: 1 } } } });
	const { order, boosted } = goOrder(ns, config, "Netburners");
	assert.deepEqual(order.slice(0, 3), ["Tetrads", "Daedalus", "Netburners"]);
	assert.deepEqual(boosted, [{ opponent: "Tetrads", why: "bladeburner" }, { opponent: "Daedalus", why: "repGoals" }]);
	assert.equal(new Set(order).size, order.length);
});

test("goOrder: --no-plan, --rotation and planAware off all keep the plain order", () => {
	const ns = nsWith({ 36: { state: "run", stateTime: fresh() } });
	assert.deepEqual(goOrder(ns, config, "Slum Snakes", { noPlan: true }).boosted, []);
	const custom = goOrder(ns, config, "Tetrads", { rotation: ["Illuminati", "Netburners"] });
	assert.deepEqual(custom.order, ["Tetrads", "Illuminati", "Netburners"]);
	assert.deepEqual(custom.boosted, []);
	const off = goOrder(ns, { go: { ...config.go, planAware: false } }, "Tetrads");
	assert.deepEqual(off.boosted, []);
});

test("goOrder falls back to the built-in rotation when the config has no go section", () => {
	assert.deepEqual(goOrder(nsWith({}), {}, "Daedalus").order, ["Daedalus", ...DEFAULT_ROTATION.filter((n) => n !== "Daedalus")]);
	assert.deepEqual(goOrder(nsWith({}), { go: { rotation: [] } }, "Daedalus").order[0], "Daedalus");
});

// ---- choose-move: tiny boards. "X" is black, "O" is white, "." empty, "#" offline. Each string is one column x.
const opts = { timeMs: 2000, maxPlayouts: 3000, komi: 0 };

test("play() places a stone and removes the captured group", () => {
	// White stone at (1,1) with black on three sides; black plays the fourth.
	const grid = toGrid([".X.", "XO.", ".X."]);
	const result = play(grid, 1, 2, "X");
	assert.ok(result);
	assert.equal(result.captured, 1);
	assert.equal(result.grid[1][1], ".");
	assert.equal(result.grid[1][2], "X");
});

test("play() refuses a move on an occupied point and suicide", () => {
	const grid = toGrid([".X.", "X.X", ".X."]);
	assert.equal(play(grid, 0, 1, "O"), null, "occupied");
	assert.equal(play(grid, 1, 1, "O"), null, "suicide into a black eye");
});

test("toGrid and toBoard are inverses", () => {
	const board = ["X.O", "...", "O.X"];
	assert.deepEqual(toBoard(toGrid(board)), board);
});

test("chooseMove returns a legal move on an empty board and never plays on an occupied point", async () => {
	const board = ["XO.", ".O.", "..."];
	const move = await chooseMove(board, "X", [], false, null, opts);
	assert.equal(move.type === "move" || move.type === "pass", true);
	if (move.type === "move") assert.equal(board[move.x][move.y], ".");
});

test("chooseMove takes a capture that wins the game", async () => {
	// White's one stone at (1,1) has a single liberty at (1,2); black captures it there and owns the board.
	const board = ["XXX", "XO.", "XXX"];
	const move = await chooseMove(board, "X", [], false, null, { ...opts, komi: 0.5 });
	assert.equal(move.type, "move");
	assert.deepEqual([move.x, move.y], [1, 2]);
});

test("chooseMove does not fill its own eye", async () => {
	// Black has two eyes at (0,0) and (2,2)... a pass is better than filling either.
	const board = [".X.XX", "XXXXX", "XXXXX", "XXXXX", "XXXX."];
	const move = await chooseMove(board, "X", [], false, null, opts);
	if (move.type === "move") {
		assert.notDeepEqual([move.x, move.y], [0, 0]);
		assert.notDeepEqual([move.x, move.y], [4, 4]);
	}
});

test("chooseMove honours the superko history: it will not recreate an earlier board", async () => {
	// Only one legal point (1,1) is left for black; the history says that result already happened.
	const board = ["X#X", "#.#", "X#X"];
	const after = ["X#X", "#X#", "X#X"];
	const move = await chooseMove(board, "X", [after], false, null, opts);
	assert.equal(move.type, "pass");
});
