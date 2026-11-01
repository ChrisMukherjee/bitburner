/** @param {NS} ns */
// Selects a tactical move using safety filtering and position weighting.
export function chooseSmartMove(ns, state) {
	const board = state.board; // String representation array
	const size = board.length;
	const playerChar = state.playerColor === "Black" ? "X" : "O";
	const opChar = state.playerColor === "Black" ? "O" : "X";

	let candidateMoves = [];

	// 1. Collect all legal open spaces and score them
	for (let x = 0; x < size; x++) {
		for (let y = 0; y < size; y++) {
			if (board[x][y] === ".") {
				// Ignore single-space suicide fills
				if (isObviouslySuicidal(board, x, y, size)) {
					continue;
				}

				let score = evaluatePosition(board, x, y, size, playerChar, opChar);
				candidateMoves.push({ x, y, score });
			}
		}
	}

	if (candidateMoves.length === 0) {
		return { type: "pass" };
	}

	// Sort candidate moves by calculated tactical score (highest first)
	candidateMoves.sort((a, b) => b.score - a.score);

	return { type: "move", x: candidateMoves[0].x, y: candidateMoves[0].y };
}

// Evaluates the strength of a coordinate choice.
function evaluatePosition(board, x, y, size, playerChar, opChar) {
	let score = 0;
	const directions = [{ dx: 0, dy: 1 }, { dx: 0, dy: -1 }, { dx: 1, dy: 0 }, { dx: -1, dy: 0 }];

	// Corner / Edge Bonus (3rd line / standard Go enclosure preference)
	let isCorner = (x === 1 || x === size - 2) && (y === 1 || y === size - 2);
	let isEdge = (x === 0 || x === size - 1 || y === 0 || y === size - 1);

	if (isCorner) score += 15;
	if (!isEdge) score += 5; // Prefer slightly inward from direct outer walls

	// Neighbor analysis
	for (let d of directions) {
		let nx = x + d.dx;
		let ny = y + d.dy;

		if (nx >= 0 && nx < size && ny >= 0 && ny < size) {
			let neighbor = board[nx][ny];

			if (neighbor === playerChar) {
				// Expanding friendly groups / connecting pieces
				score += 10;
			} else if (neighbor === opChar) {
				// Pressure / blocking enemy expansion
				score += 8;
			} else if (neighbor === ".") {
				// Maintaining open liberties
				score += 3;
			}
		}
	}

	return score;
}

// Simple check to avoid playing directly inside fully enclosed spaces without liberties.
function isObviouslySuicidal(board, x, y, size) {
	let emptyCount = 0;
	const directions = [{ dx: 0, dy: 1 }, { dx: 0, dy: -1 }, { dx: 1, dy: 0 }, { dx: -1, dy: 0 }];

	for (let d of directions) {
		let nx = x + d.dx;
		let ny = y + d.dy;
		if (nx >= 0 && nx < size && ny >= 0 && ny < size) {
			if (board[nx][ny] === ".") emptyCount++;
		}
	}

	// If there are zero adjacent empty nodes, avoid placing unless it's an advanced capture
	return emptyCount === 0;
}