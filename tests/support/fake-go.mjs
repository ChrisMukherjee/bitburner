// A small IPvGO stand-in for running go/go-bot.js main (the real move search, a scripted opponent), the way the game would:
//
//   const sim = goSim({ results: (opponent, n) => ({ won: true, gain: 0.5 }) });
//   await sim.run({ opponent: "Netburners", games: 20 });      // flags, as `run go/go-bot.js --opponent ... --games 20`
//   sim.games                                                  // { opponent, size, won } of each game, in order
//
// Each game is scripted: the opponent answers the bot's `movesPerGame` moves with a stone and then passes; the bot is ahead
// (and passes to take the win) when `results` says it wins, and loses at its last move otherwise. Winning raises the opponent's
// bonus by `gain`, like Go's faction bonus; a lost game leaves it. Stats and the bonus survive between runs (an install clears them:
// sim.install()). Time: Date.now is the real clock plus an offset that sleeps and games move, so the bot's own search timing
// still works while "an hour later" is one call (sim.later(60 * 60_000)).
import { fakeNs } from "./fake-ns.mjs";

export const OPPONENTS = ["Netburners", "Slum Snakes", "The Black Hand", "Tetrads", "Daedalus", "Illuminati", "????????????"];

/**
 * @param {object} [options]
 * @param {(opponent: string, n: number) => { won: boolean, gain?: number }} [options.results]  n = games played against that opponent so far
 * @param {number} [options.movesPerGame]  the bot's moves before the game ends
 * @param {Record<number, any>} [options.ports]
 * @param {Record<string, string>} [options.files]
 * @param {Record<string, number>} [options.bonus]  starting bonusPercent per opponent
 * @param {object} [options.config]  data/config.json
 */
export function goSim({ results = () => ({ won: true, gain: 0.5 }), movesPerGame = 1, ports = {}, files = {}, bonus = {}, config } = {}) {
	let offset = 0;
	const stats = Object.fromEntries(OPPONENTS.map((name) => [name, { bonusPercent: bonus[name] ?? 0, wins: 0, losses: 0, winStreak: 0 }]));
	const played = Object.fromEntries(OPPONENTS.map((name) => [name, 0]));
	/** @type {null | { opponent: string, size: number, board: string[], moves: number, current: string, over: boolean, outcome: any, previousMove: any }} */
	let game = null;
	let history = [];
	let scores = { black: 0, white: 0 };
	const sim = {
		games: [], resets: [], passes: 0, moves: 0, rejected: 0, resumed: 0, highlights: [],
		rejectNextMoves: 0,
		afterGame: null,   // (gamesPlayed) => void, called after each game: change ports, bonuses, the clock
		stats, played,
		now: () => Date.now(),
		later: (ms) => { offset += ms; },
		/** An augmentation install: Go's node power resets, so every bonus restarts at 0. */
		install() { for (const entry of Object.values(stats)) entry.bonusPercent = 0; },
		/** A game already in progress when the bot starts (the player's own, or a stopped bot's). */
		startGame(opponent, size = 7, current = "Black") {
			begin(opponent, size);
			game.current = current;
		},
	};
	const begin = (opponent, size) => {
		game = { opponent, size, board: Array.from({ length: size }, () => ".".repeat(size)), moves: 0, current: "Black", over: false, outcome: results(opponent, played[opponent]), previousMove: undefined };
		history = [];
		scores = { black: 0, white: 0 };
	};
	const end = (won) => {
		const entry = stats[game.opponent];
		game.over = true;
		game.current = "None";
		scores = won ? { black: 20, white: 5.5 } : { black: 3, white: 20 };
		if (won) { entry.wins++; entry.winStreak++; entry.bonusPercent += game.outcome.gain ?? 0.5; } else { entry.losses++; entry.winStreak = 0; }
		played[game.opponent]++;
		offset += 20_000;
		sim.games.push({ opponent: game.opponent, size: game.size, won });
		if (sim.afterGame) sim.afterGame(sim.games.length);
		return { type: "gameOver" };
	};
	const place = (x, y, color) => {
		game.board = game.board.map((column, i) => (i === x ? column.slice(0, y) + color + column.slice(y + 1) : column));
		history.push([...game.board]);
	};
	const go = {
		getCurrentPlayer: () => (game && !game.over ? game.current : "None"),
		getOpponent: () => game.opponent,
		resetBoardState: (opponent, size) => { sim.resets.push({ opponent, size }); begin(opponent, size); return game.board; },
		opponentNextTurn: async () => { sim.resumed++; game.current = "Black"; },
		getBoardState: () => [...game.board],
		getGameState: () => ({ blackScore: scores.black || (game ? game.moves : 0), whiteScore: scores.white, komi: 5.5, previousMove: game.previousMove, currentPlayer: game.current }),
		getMoveHistory: () => history.map((board) => [...board]),
		makeMove: async (x, y) => {
			if (sim.rejectNextMoves > 0) { sim.rejectNextMoves--; sim.rejected++; throw new Error("that point is not playable"); }
			sim.moves++;
			game.moves++;
			place(x, y, "X");
			if (!game.outcome.won) return end(false);
			if (game.moves < movesPerGame) {
				// the opponent answers on the first free point
				const column = game.board.findIndex((text) => text.includes("."));
				const row = game.board[column].indexOf(".");
				place(column, row, "O");
				game.previousMove = [column, row];
			} else {
				game.previousMove = null; // the opponent passes
				scores = { black: 20, white: 5.5 };
			}
			return { type: "move" };
		},
		passTurn: async () => { sim.passes++; return end(!!game.outcome.won); },
		analysis: { getStats: () => JSON.parse(JSON.stringify(stats)), highlightPoint: (x, y, color, text) => { sim.highlights.push({ x, y, color, text }); } },
	};
	const ns = fakeNs({
		files: { ...(config ? { "data/config.json": JSON.stringify(config) } : {}), ...files },
		ports,
		overrides: {
			go,
			sleep: async (ms) => { offset += ms; },
			getScriptName: () => "go/go-bot.js",
			// the game's own ns.flags: the schema's defaults, then what was passed
			flags: (schema) => Object.fromEntries(schema.map(([name, value]) => [name, sim.flagValues && name in sim.flagValues ? sim.flagValues[name] : value])),
		},
	});
	sim.ns = ns;
	/** Runs main with these flags (camelCase is not used: pass "no-rotate" as written), on the offset clock. */
	sim.run = async (main, flags = {}) => {
		const real = Date.now;
		Date.now = () => real() + offset;
		sim.flagValues = { think: 15, ...flags };
		try { await main(ns); } finally { Date.now = real; }
	};
	return sim;
}
