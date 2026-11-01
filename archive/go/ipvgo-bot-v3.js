/** @param {NS} ns */
import { chooseSmartMove } from "/go/choose-move-v2.js"

export async function main(ns) {
	ns.disableLog("ALL");

	// Configuration: Opponent pool to cycle through.
	// Order from easier/starter opponents to tougher ones.
	const opponents = [
		"Netburners",
		"Slum Snakes",
		"The Black Hand",
		"Tetrads",
		"Illuminati",
		"Daedalus"
	];

	let currentOpponentIndex = 0;

	// Track win rate per opponent to switch intelligent targets
	const opponentStats = {};
	opponents.forEach(op => opponentStats[op] = { wins: 0, losses: 0 });

	ns.print("=== IPvGO Automated Bot Started ===");

	while (true) {
		let opponent = opponents[currentOpponentIndex];
		let boardSize = 7; // Standard 7x7 board works well for heuristics

		ns.print(`\n--- Starting Match vs ${opponent} (${boardSize}x${boardSize}) ---`);

		try {
			// Initialize/Reset board for current opponent
			ns.go.resetBoardState(opponent, boardSize);
		} catch (e) {
			ns.print(`Error resetting board for ${opponent}: ${e.message}`);
			await ns.sleep(5000);
			continue;
		}

		// Run match loop
		let result = await playMatch(ns, opponent);

		// Update statistics
		if (result.won) {
			opponentStats[opponent].wins++;
			ns.print(`SUCCESS: Won match vs ${opponent}! (Total: ${opponentStats[opponent].wins}W / ${opponentStats[opponent].losses}L)`);

			// Stay on this opponent if winning, or occasionally cycle if you have a huge win streak
			if (opponentStats[opponent].wins % 10 === 0) {
				currentOpponentIndex = (currentOpponentIndex + 1) % opponents.length;
				ns.print(`Cycling to next opponent to distribute stats/rep...`);
			}
		} else {
			opponentStats[opponent].losses++;
			ns.print(`FAILED: Lost match vs ${opponent}. (Total: ${opponentStats[opponent].wins}W / ${opponentStats[opponent].losses}L)`);

			// If losing consistently, rotate to another opponent
			let losses = opponentStats[opponent].losses;
			let wins = opponentStats[opponent].wins;
			if (losses >= 2 && losses > wins) {
				currentOpponentIndex = (currentOpponentIndex + 1) % opponents.length;
				ns.print(`Loss rate high vs ${opponent}. Switching opponent to ${opponents[currentOpponentIndex]}...`);
			}
		}

		await ns.sleep(500); // Brief pause between matches
	}
}

// Executes a single game loop until completion.
async function playMatch(ns, opponent) {
	let turnsWithoutProgress = 0;

	while (true) {
		let currentPlayer = ns.go.getCurrentPlayer(); // Returns "Black", "White", or "None"
		let board = ns.go.getBoardState();          // Returns string array of board columns

		// If game state returns null/undefined or missing board, wait for it to initialize
		if (!board || currentPlayer === undefined) {
			await ns.sleep(200);
			continue;
		}

		// Check if it's our turn (Assuming player plays Black/X first on a reset board)
		let gameState = ns.go.getGameState();
		let playerColor = gameState?.playerColor || "Black";

		// Check if game is complete
		if (currentPlayer === "None") {
			// Evaluate score
			let score = gameState?.score || {};
			// Determine our color based on initial setup or turn tracking (Default player is usually Black on reset)
			let myScore = playerColor === "Black" ? (score.black ?? 0) : (score.white ?? 0);
			let opponentScore = playerColor === "Black" ? (score.white ?? 0) : (score.black ?? 0);

			ns.print(`Match Finished. Final Score - Us: ${myScore}, Opponent: ${opponentScore}`);

			return {
				won: myScore > opponentScore,
				myScore,
				opponentScore
			};
		}

		// Play turn if it's our turn
		if (currentPlayer === playerColor) {
			// If we are significantly ahead and opponent passed, finish the game
			if (isAheadInScore(ns, gameState, playerColor) && gameState?.lastAction === "pass") {
				ns.print("We lead and opponent passed. Passing to secure victory.");
				await ns.go.passTurn();
				await ns.sleep(200);
				continue;
			}

			// Construct a state object matching what chooseSmartMove expects
			let state = {
				board: board,
				playerColor: playerColor,
				lastAction: gameState?.lastAction
			};

			// Decide move using smart move heuristic
			let candidateMoves = chooseSmartMove(ns, state);
			let movePlayed = false;

			if (candidateMoves && candidateMoves.length > 0) {
				// Try moves one-by-one. If a move causes Ko or is rejected, catch it and try the next best one.
				for (let move of candidateMoves) {
					if (!move || typeof move.x !== "number" || typeof move.y !== "number") {
						continue;
					}

					try {
						let moveResult = await ns.go.makeMove(move.x, move.y);
						ns.print(`Played move at [${move.x}, ${move.y}] -> Result: ${JSON.stringify(moveResult)}`);
						movePlayed = true;
						break;
					} catch (err) {
						// Gracefully catch Ko rule violations or illegal states and try the next option
					}
				}
			}

			// If all candidates failed or none exist, pass turn safely
			if (!movePlayed) {
				ns.print("No legal/successful moves available. Passing turn.");
				await ns.go.passTurn();
			}

			turnsWithoutProgress = 0;
		} else {
			// Not our turn, wait for opponent to move
			turnsWithoutProgress++;
			if (turnsWithoutProgress > 100) {
				ns.print("Warning: Stuck waiting for opponent turn or game state desync. Forcing match reset loop.");
				break;
			}
		}

		await ns.sleep(100);
	}

	return { won: false, myScore: 0, opponentScore: 0 };
}

// Checks if the player is currently leading based on territory and captures.
function isAheadInScore(ns, gameState, playerColor) {
	let score = gameState?.score;
	if (!score) return false;
	let myScore = playerColor === "Black" ? (score.black ?? 0) : (score.white ?? 0);
	let opScore = playerColor === "Black" ? (score.white ?? 0) : (score.black ?? 0);
	// Only trigger automatic game-ending pass if we have a definitive lead
	return myScore > opScore + 2;
}