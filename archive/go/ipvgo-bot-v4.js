/** @param {NS} ns */
import { chooseMove } from "/go/choose-move.js"

// Bonus each faction's win streak gives (from the IPvGO subnet tab).
// Netburners: hacknet production | Slum Snakes: crime success | The Black Hand: hacking money
// Tetrads: str/def/dex/agi | Daedalus: reputation gain | Illuminati: hack/grow/weaken speed
const OPPONENTS = ["Netburners", "Slum Snakes", "The Black Hand", "Tetrads", "Daedalus", "Illuminati", "????????????"];

// Usage: run go/ipvgo-bot.js [--opponent "The Black Hand"] [--size 7] [--games 0] [--debug]
export async function main(ns) {
	ns.disableLog("ALL");
	const flags = ns.flags([
		["opponent", "Netburners"],
		["size", 7],
		["games", 0], // 0 = play forever
		["debug", false],
	]);
	const opponent = flags.opponent;
	const size = flags.size;

	if (!OPPONENTS.includes(opponent)) {
		ns.tprint(`ERROR: unknown opponent "${opponent}". Choose one of: ${OPPONENTS.join(", ")}`);
		return;
	}
	if (![5, 7, 9, 13].includes(size)) {
		ns.tprint(`ERROR: board size must be 5, 7, 9 or 13`);
		return;
	}

	ns.print(`=== IPvGO bot: ${opponent} on ${size}x${size} ===`);

	let played = 0;
	while (flags.games === 0 || played < flags.games) {
		// Resume a game in progress instead of resetting it (a reset mid-game costs the win streak).
		const resuming = ns.go.getCurrentPlayer() !== "None" && ns.go.getOpponent() === opponent;
		if (!resuming) {
			ns.go.resetBoardState(opponent, size);
		} else {
			ns.print("Resuming game in progress");
			if (ns.go.getCurrentPlayer() === "White") await ns.go.opponentNextTurn(false);
		}

		await playGame(ns, flags.debug);
		played++;

		const state = ns.go.getGameState();
		const won = state.blackScore > state.whiteScore;
		const stats = ns.go.analysis.getStats()[opponent];
		ns.print(`${won ? "WIN " : "LOSS"} ${state.blackScore} - ${state.whiteScore} | ` +
			`${stats?.wins ?? 0}W ${stats?.losses ?? 0}L, streak ${stats?.winStreak ?? 0}, bonus ${ns.format.number(stats?.bonusPercent ?? 0)}%`);

		await ns.sleep(200);
	}
}

// Play until the game ends. We are always black ("X") against an AI faction.
async function playGame(ns, debug) {
	while (ns.go.getCurrentPlayer() === "Black") {
		const board = ns.go.getBoardState();
		const state = ns.go.getGameState();
		const behind = state.blackScore <= state.whiteScore;
		const opponentPassed = state.previousMove === null && ns.go.getMoveHistory().length > 0;

		// The opponent passed and we are ahead on the real score: pass to end the game and take the win.
		if (opponentPassed && !behind) {
			ns.print(`Opponent passed, we lead ${state.blackScore} - ${state.whiteScore}. Passing to win.`);
			const result = await ns.go.passTurn();
			if (result.type === "gameOver") return;
			continue;
		}

		const move = await chooseMove(board, "X", ns.go.getMoveHistory(), behind, () => ns.sleep(0));

		if (debug && move.type === "move") {
			ns.go.analysis.highlightPoint(move.x, move.y, "hack", move.value.toFixed(1));
		}

		let result;
		if (move.type === "move") {
			try {
				result = await ns.go.makeMove(move.x, move.y);
			} catch (e) {
				// Should not happen since chooseMove checks legality, but never get stuck on it.
				ns.print(`WARN: move [${move.x},${move.y}] rejected (${e}). Passing.`);
				result = await ns.go.passTurn();
			}
		} else {
			ns.print(`Nothing worth playing (best ${move.value.toFixed(1)} vs pass ${move.passValue.toFixed(1)}). Passing.`);
			result = await ns.go.passTurn();
		}

		if (result.type === "gameOver") return;
	}
}
