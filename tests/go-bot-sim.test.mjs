// go/go-bot.js main, played game after game against tests/support/fake-go.mjs (the real move search, a scripted opponent whose bonus
// grows with each win). These check what the loop promises over many games: who is played and in what order, when it moves on
// (bonus gains levelling off, a losing record), the hourly retry of a skipped opponent, finishing a game in progress, the board size
// per opponent, what survives a restart and an install, the plan reading, and the flags. tests/go.test.mjs checks the plan order
// and the move search on tiny boards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { goSim, OPPONENTS } from "./support/fake-go.mjs";
import { main } from "/go/go-bot.js";
import { loadConfig } from "/utils/config.js";
import { fakeNs } from "./support/fake-ns.mjs";

const DATA = "/data/go-bonus.json";
const saved = (sim) => JSON.parse(sim.ns.read(DATA) || "{}");
const order = (sim) => sim.games.map((game) => game.opponent);
/** The sequence with runs of the same opponent folded: ["Netburners", "The Black Hand"]. */
const runs = (sim) => order(sim).filter((name, i, all) => name !== all[i - 1]);
const logs = (sim) => sim.ns.logs.join("\n");
const ROTATION = loadConfig(fakeNs()).go.rotation;
const MIN = 60_000;

test("it plays the focus game after game, recording each one on disk", async () => {
	const sim = goSim();
	await sim.run(main, { games: 6 });
	assert.deepEqual(order(sim), Array(6).fill("Netburners"), "the default focus, while its bonus is still climbing");
	const entry = saved(sim).Netburners;
	assert.equal(entry.games, 6);
	assert.deepEqual(entry.wins, Array(6).fill(true));
	assert.deepEqual(entry.gains, Array(6).fill(0.5), "each game's bonus gain, from the stats the game reports");
	assert.equal(entry.bonus, 3);
	assert.equal(sim.resets.length, 6, "a fresh board for every game");
	assert.ok(sim.resets.every((reset) => reset.opponent === "Netburners" && reset.size === 7));
});

test("--opponent picks the focus; every game is a win or a loss in the log with its score and the bonus it gave", async () => {
	const sim = goSim({ results: (opponent, n) => ({ won: n !== 1, gain: 0.25 }) });
	await sim.run(main, { opponent: "Daedalus", games: 3 });
	assert.deepEqual(order(sim), ["Daedalus", "Daedalus", "Daedalus"]);
	assert.match(logs(sim), /=== IPvGO bot: focus Daedalus on 7x7 ===/);
	assert.match(logs(sim), /WIN {2}vs Daedalus 20 - 5\.5 \| 1W 0L, streak 1, bonus 0\.25% \(\+0\.25\)/);
	assert.match(logs(sim), /LOSS vs Daedalus 3 - 20 \| 1W 1L, streak 0/);
	assert.deepEqual(saved(sim).Daedalus.wins, [true, false, true]);
	assert.equal(saved(sim).Daedalus.gains[1], 0, "a lost game gained nothing");
});

test("a longer game, move by move: the bot keeps choosing moves until the opponent passes while it leads, then passes to win", async () => {
	const sim = goSim({ movesPerGame: 4 });
	await sim.run(main, { games: 2 });
	assert.equal(sim.moves, 8, "four moves a game");
	assert.equal(sim.passes, 2, "one pass at the end of each, to take the win");
	assert.deepEqual(sim.games.map((game) => game.won), [true, true]);
});

test("it moves on to the next opponent once the focus's bonus gain per game falls to a quarter of its peak", async () => {
	const sim = goSim({ results: (opponent, n) => ({ won: true, gain: n < 10 ? 1 : 0.1 }) });
	await sim.run(main, { games: 24 });
	assert.deepEqual(runs(sim), ["Netburners", ROTATION[0]], `${order(sim).join(", ")}`);
	assert.equal(order(sim).filter((name) => name === "Netburners").length, 20, "two windows of ten games are needed before it can call a level-off");
	assert.match(logs(sim), /Switching Netburners -> The Black Hand: bonus gain per game fell to 10% of its peak/);
});

test("it does not move on while the gain stays above the threshold, however many games", async () => {
	const sim = goSim({ results: (opponent, n) => ({ won: true, gain: n < 10 ? 1 : 0.3 }) });
	await sim.run(main, { games: 30 });
	assert.deepEqual(runs(sim), ["Netburners"], "30 % of the peak is above 25 %");
});

test("--level-off and --span set when it moves on", async () => {
	const sim = goSim({ results: (opponent, n) => ({ won: true, gain: n < 3 ? 1 : 0.6 }) });
	await sim.run(main, { games: 10, span: 3, "level-off": 0.7 });
	assert.deepEqual(runs(sim), ["Netburners", ROTATION[0]], "0.6 is under 70 % of the peak, after two windows of three");
	assert.equal(order(sim).filter((name) => name === "Netburners").length, 6);
});

test("an opponent that is mostly lost to is skipped, and gets one more game an hour after its last; a restart keeps all of that", async () => {
	const results = (opponent, n) => (opponent === "Netburners" ? { won: false } : { won: true, gain: 1 });
	const sim = goSim({ results });
	await sim.run(main, { games: 20 });
	assert.ok(order(sim).every((name) => name === "Netburners"), "no record yet: it keeps trying the focus");
	await sim.run(main, { games: 3 });
	assert.deepEqual(order(sim).slice(20), Array(3).fill(ROTATION[0]), "lost most of the last ten: on to the next opponent");
	sim.later(30 * MIN);
	await sim.run(main, { games: 2 });
	assert.deepEqual(order(sim).slice(23), Array(2).fill(ROTATION[0]), "half an hour is not enough");
	sim.later(61 * MIN);
	await sim.run(main, { games: 3 });
	assert.deepEqual(order(sim).slice(25), ["Netburners", ROTATION[0], ROTATION[0]], "one retry, then back to the others");
});

test("a skipped opponent that starts winning again is played normally once its window shows wins", async () => {
	let lost = true;
	const sim = goSim({ results: (opponent) => (opponent === "Netburners" && lost ? { won: false } : { won: true, gain: 1 }) });
	await sim.run(main, { games: 23 });
	lost = false;
	for (let hour = 0; hour < 3; hour++) { sim.later(61 * MIN); await sim.run(main, { games: 1 }); }
	// each hour one retry game; wins accumulate in its window
	const retries = order(sim).slice(23).filter((name) => name === "Netburners").length;
	assert.ok(retries >= 2, `${order(sim).slice(23).join(", ")}`);
});

test("when every opponent has levelled off it goes back to the focus", async () => {
	const sim = goSim({ results: (opponent, n) => ({ won: true, gain: n < 2 ? 1 : 0 }) });
	await sim.run(main, { games: 30, span: 2 });
	const first = runs(sim).slice(0, 6);
	assert.deepEqual(first, ["Netburners", ...ROTATION.filter((name) => name !== "Netburners")], "each in turn, the focus first");
	assert.equal(runs(sim)[6], "Netburners", "all six are levelled: back to the focus");
});

test("--no-rotate plays only the focus, even after it has levelled off", async () => {
	const sim = goSim({ results: (opponent, n) => ({ won: true, gain: n < 2 ? 1 : 0 }) });
	await sim.run(main, { games: 12, span: 2, "no-rotate": true });
	assert.deepEqual(runs(sim), ["Netburners"]);
	assert.match(logs(sim), /\(no rotation\)/);
});

test("--rotation sets the order after the focus by hand, and ignores the plan", async () => {
	const sim = goSim({ results: (opponent, n) => ({ won: true, gain: n < 2 ? 1 : 0 }), ports: { 36: { state: "run", stateTime: Date.now() } } });
	await sim.run(main, { games: 12, span: 2, rotation: "Illuminati, Tetrads" });
	assert.deepEqual(runs(sim).slice(0, 3), ["Netburners", "Illuminati", "Tetrads"], "the plan's Tetrads-first is off with a hand-set rotation");
});

test("the plan comes first: a running Bladeburner puts Tetrads ahead of the focus, an open Daedalus goal puts Daedalus ahead too; --no-plan skips them", async () => {
	const ports = { 36: { state: "run", stateTime: Date.now() }, 23: { time: Date.now(), goals: { Daedalus: { rep: 5000 } } } };
	const planned = goSim({ ports });
	await planned.run(main, { games: 2 });
	assert.deepEqual(order(planned), ["Tetrads", "Tetrads"], "boosted opponents jump the queue while their bonus is climbing");
	assert.match(logs(planned), /Plan wants: Tetrads \(bladeburner\), Daedalus \(repGoals\) first/);
	const plain = goSim({ ports });
	await plain.run(main, { games: 2, "no-plan": true });
	assert.deepEqual(order(plain), ["Netburners", "Netburners"]);
	assert.doesNotMatch(logs(plain), /Plan wants/);
});

test("the plan is re-read before every game: a Bladeburner that starts mid-run takes over, and the log says the plan changed", async () => {
	const sim = goSim();
	sim.afterGame = (count) => { if (count === 2) sim.ns.ports[36] = JSON.stringify({ state: "run", stateTime: Date.now() }); };
	await sim.run(main, { games: 4 });
	assert.deepEqual(order(sim), ["Netburners", "Netburners", "Tetrads", "Tetrads"]);
	assert.match(logs(sim), /Plan wants: Tetrads \(bladeburner\) first/);
});

test("a game in progress is finished first, even against an opponent the order would not pick; no new board is started for it", async () => {
	const sim = goSim();
	sim.startGame("Daedalus", 7);
	await sim.run(main, { games: 2 });
	assert.equal(sim.games[0].opponent, "Daedalus");
	assert.equal(sim.resets.length, 1, "the resumed game needs no reset; only the second game starts a board");
	assert.equal(sim.games[1].opponent, "Netburners");
	assert.match(logs(sim), /Resuming game in progress vs Daedalus/);
});

test("a resumed game where the opponent is to move lets it move first", async () => {
	const sim = goSim();
	sim.startGame("Daedalus", 7, "White");
	await sim.run(main, { games: 1 });
	assert.equal(sim.resumed, 1);
	assert.equal(sim.games[0].opponent, "Daedalus");
});

test("a game in progress against an opponent that is not in the order (--no-rotate) is not resumed", async () => {
	const sim = goSim();
	sim.startGame("Illuminati", 5);
	await sim.run(main, { games: 1, "no-rotate": true });
	assert.equal(sim.resets.length, 1);
	assert.equal(sim.games[0].opponent, "Netburners");
});

test("Illuminati is played on its own board size (5 by default, --illuminati-size, 0 for the same as --size)", async () => {
	const sized = async (flags) => {
		const sim = goSim({ results: (opponent, n) => ({ won: true, gain: n < 2 ? 1 : 0 }) });
		await sim.run(main, { games: 14, span: 2, ...flags });
		return sim;
	};
	const normal = await sized({});
	const sizes = (sim) => Object.fromEntries(sim.resets.map((reset) => [reset.opponent, reset.size]));
	assert.equal(sizes(normal).Illuminati, 5);
	assert.equal(sizes(normal).Netburners, 7);
	assert.equal(sizes(await sized({ "illuminati-size": 9 })).Illuminati, 9);
	assert.equal(sizes(await sized({ "illuminati-size": 0 })).Illuminati, 7, "0 = the same as --size");
	assert.equal(sizes(await sized({ size: 5 })).Netburners, 5);
});

test("what it learned survives a restart, but an opponent whose bonus fell (an install, a new BitNode) starts over", async () => {
	const sim = goSim();
	await sim.run(main, { games: 4 });
	await sim.run(main, { games: 2 });
	assert.equal(saved(sim).Netburners.games, 6, "the second run continued the record");
	sim.install();
	await sim.run(main, { games: 1 });
	assert.equal(saved(sim).Netburners.games, 1, "the bonus restarted at 0: the old history no longer describes this run");
});

test("regression: a bonus that fell during a game (an install) is recorded as a gain of 0, not a negative one", async () => {
	const sim = goSim();
	await sim.run(main, { games: 2 });
	sim.afterGame = () => { sim.install(); };
	await sim.run(main, { games: 1 });
	assert.ok(saved(sim).Netburners.gains.every((gain) => gain >= 0));
});

test("--reset forgets the saved history; --status prints each opponent and plays nothing", async () => {
	const sim = goSim();
	await sim.run(main, { games: 3 });
	await sim.run(main, { reset: true, games: 1 });
	assert.equal(saved(sim).Netburners.games, 1);
	const status = goSim({ files: { [DATA]: JSON.stringify({ Netburners: { gains: [1, 1], wins: [true, true], peak: 0, games: 2, bonus: 0, lastPlayed: 1 } }) }, bonus: { Netburners: 5 } });
	await status.run(main, { status: true });
	assert.equal(status.games.length, 0);
	assert.equal(status.resets.length, 0);
	assert.ok(status.ns.terminal.some((row) => /Netburners: climbing, bonus 0\.00%, 2 games recorded/.test(row)), status.ns.terminal.join("|"));
	assert.ok(status.ns.terminal.some((row) => /The Black Hand: no games recorded yet/.test(row)));
});

test("--games stops after exactly that many games", async () => {
	const sim = goSim();
	await sim.run(main, { games: 5 });
	assert.equal(sim.games.length, 5);
});

test("bad flags: an unknown opponent, a board size the game doesn't have, an unknown name in --rotation: an ERROR line and no game", async () => {
	for (const [flags, message] of [[{ opponent: "Nobody" }, /unknown opponent "Nobody"/], [{ size: 8 }, /board size must be 5, 7, 9 or 13/], [{ "illuminati-size": 6 }, /board size must be/], [{ rotation: "Daedalus,Nobody" }, /--rotation has an unknown opponent/]]) {
		const sim = goSim();
		await sim.run(main, { games: 1, ...flags });
		assert.equal(sim.games.length, 0, JSON.stringify(flags));
		assert.equal(sim.resets.length, 0);
		assert.match(sim.ns.terminal.join("\n"), message);
	}
	assert.ok(OPPONENTS.includes("????????????"), "the hidden opponent is a valid focus");
	const hidden = goSim();
	await hidden.run(main, { opponent: "????????????", games: 1 });
	assert.equal(hidden.games[0].opponent, "????????????");
});

test("a move the game rejects is answered with a pass, and the game still ends", async () => {
	const sim = goSim();
	sim.rejectNextMoves = 1;
	await sim.run(main, { games: 1 });
	assert.equal(sim.rejected, 1);
	assert.match(logs(sim), /WARN: move \[\d+,\d+\] rejected/);
	assert.equal(sim.games.length, 1);
});

test("--debug marks the chosen point on the board with its win chance; without it nothing is drawn", async () => {
	const on = goSim();
	await on.run(main, { games: 1, debug: true });
	assert.ok(on.highlights.length >= 1 && /^\d+%$/.test(on.highlights[0].text));
	const off = goSim();
	await off.run(main, { games: 1 });
	assert.equal(off.highlights.length, 0);
});
