/** @param {NS} ns */
export async function main(ns) {
	let result, x, y;

	do {
		const board = ns.go.getBoardState();
		const validMoves = ns.go.analysis.getValidMoves();

		const [randX, randY] = getRandomMove(board, validMoves);
		// TODO: more move options

		// Choose a move from our options (currently just "random move")
		x = randX;
		y = randY;

		if (x === undefined) {
			// Pass turn if no moves are found
			result = await ns.go.passTurn();
		} else {
			// Play the selected move
			result = await ns.go.makeMove(x, y);
		}

		// Log opponent's next move, once it happens
		await ns.go.opponentNextTurn();

		await ns.sleep(200);

		// Keep looping as long as the opponent is playing moves
	} while (result?.type !== "gameOver");

	// TODO: add a loop to keep playing
	// TODO: reset board, e.g. `ns.go.resetBoardState("Netburners", 7)`
}