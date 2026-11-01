/** @param {NS} ns **/
export async function main(ns) {
	ns.disableLog("ALL");

	const opponent = "Netburners";
	const boardSize = 5;

	ns.tprint(`[DEBUG] Script started. Attempting to reset board for ${opponent}...`);

	while (true) {
		try {
			ns.tprint(`[DEBUG] Calling resetBoardState...`);
			ns.go.resetBoardState(opponent, boardSize);
			ns.tprint(`[DEBUG] resetBoardState executed successfully!`);
		} catch (e) {
			ns.tprint(`[CRITICAL ERROR] resetBoardState threw: ${e}`);
			await ns.sleep(5000);
			continue;
		}

		// Check game state immediately after reset
		let gameState = ns.go.getGameState();
		ns.tprint(`[DEBUG] Game state fetched. Is game over? ${gameState.isGameOver}`);

		// Run one quick loop iteration to see what it tries to do next
		let validMoves = ns.go.analysis.getValidMoves();
		ns.tprint(`[DEBUG] Valid moves array length: ${validMoves ? validMoves.length : "undefined"}`);

		// Stop the script after one loop so it doesn't spam your terminal
		ns.tprint(`[DEBUG] Test cycle complete. Stopping script.`);
		break;
	}
}