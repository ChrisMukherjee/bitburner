/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");

	// Choose your opponent and board size (e.g., "Netburners", 5x5 board)
	const opponent = "Netburners";
	const boardSize = 5;

	ns.print(`Starting IPvGO Bot against ${opponent} on a ${boardSize}x${boardSize} board...`);

	while (true) {
		// Reset or start a new game
		try {
			ns.go.resetBoardState(opponent, boardSize);
		} catch (e) {
			ns.tprint(`ERROR starting IPvGO game: ${e}`);
			await ns.sleep(5000);
			continue;
		}

		// Play the active game loop
		while (true) {
			// Check if the game has ended
			if (ns.go.getCurrentPlayer() === "None") {
				let gameState = ns.go.getGameState();
				let playerScore = gameState?.currentScore?.player ?? 0;
				let enemyScore = gameState?.currentScore?.enemy ?? 0;
				ns.print(`Game finished. Score - You: ${playerScore}, Opponent: ${enemyScore}`);
				break;
			}

			// Fetch valid moves using the go analysis namespace
			let validMoves = ns.go.analysis.getValidMoves();
			let madeMove = false;

			// Scan the grid to find the first valid coordinate and play it
			for (let x = 0; x < boardSize; x++) {
				for (let y = 0; y < boardSize; y++) {
					if (validMoves[x] && validMoves[x][y]) {
						try {
							await ns.go.makeMove(x, y);
							madeMove = true;
						} catch (err) {
							// Move failed because game state changed or ended
						}
						break;
					}
				}
				if (madeMove) break;
			}

			// Re-check game state before trying to pass the turn
			if (ns.go.getCurrentPlayer() === "None") {
				break;
			}

			// If no valid moves were found, pass the turn safely
			if (!madeMove) {
				try {
					await ns.go.passTurn();
				} catch (err) {
					// Game likely ended during pass attempt
				}
			}

			// Small pacing delay between turns
			await ns.sleep(200);
		}

		// Brief pause before starting the next match
		await ns.sleep(1000);
	}
}