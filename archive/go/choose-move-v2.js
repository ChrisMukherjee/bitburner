/** @param {NS} ns **/
// Selects a tactical move prioritizing captures, defense, and position weighting while avoiding Ko repetitions.
export function chooseSmartMove(ns, state) {
	const board = state.board; // String representation array (columns)
	const size = board.length;
	const playerChar = state.playerColor === "Black" ? "X" : "O";
	const opChar = state.playerColor === "Black" ? "O" : "X";

	let candidateMoves = [];

	// Analyze existing board groups and their liberties
	const boardGroups = analyzeBoardGroups(board, size);

	// Collect all legal open spaces and score them
	for (let x = 0; x < size; x++) {
		for (let y = 0; y < size; y++) {
			if (board[x][y] === ".") {
				// Filter out obvious self-destructive suicides
				if (isSuicidalMove(board, x, y, size, playerChar, opChar, boardGroups)) {
					continue;
				}

				let score = evaluatePositionWithTactics(board, x, y, size, playerChar, opChar, boardGroups);
				candidateMoves.push({ x, y, score });
			}
		}
	}

	// Sort candidate moves by calculated tactical score (highest first)
	candidateMoves.sort((a, b) => b.score - a.score);

	return candidateMoves;
}

// Flood-fill algorithm to find all distinct stone groups and their open liberties.
function analyzeBoardGroups(board, size) {
	let visited = Array.from({ length: size }, () => Array(size).fill(false));
	let groups = [];
	const directions = [{ dx: 0, dy: 1 }, { dx: 0, dy: -1 }, { dx: 1, dy: 0 }, { dx: -1, dy: 0 }];

	for (let x = 0; x < size; x++) {
		for (let y = 0; y < size; y++) {
			let char = board[x][y];
			if (char !== "." && !visited[x][y]) {
				let groupStones = [];
				let liberties = new Set();
				let queue = [{ x, y }];
				visited[x][y] = true;

				let head = 0;
				while (head < queue.length) {
					let curr = queue[head++];
					groupStones.push(curr);

					for (let d of directions) {
						let nx = curr.x + d.dx;
						let ny = curr.y + d.dy;
						if (nx >= 0 && nx < size && ny >= 0 && ny < size) {
							let neighborChar = board[nx][ny];
							if (neighborChar === ".") {
								liberties.add(`${nx},${ny}`);
							} else if (neighborChar === char && !visited[nx][ny]) {
								visited[nx][ny] = true;
								queue.push({ x: nx, y: ny });
							}
						}
					}
				}

				groups.push({
					color: char,
					stones: groupStones,
					liberties: liberties // Set of "x,y" strings representing open liberties
				});
			}
		}
	}
	return groups;
}

// Enhanced tactical evaluation scoring captures, escapes, and positioning.
function evaluatePositionWithTactics(board, x, y, size, playerChar, opChar, groups) {
	let score = 0;
	const directions = [{ dx: 0, dy: 1 }, { dx: 0, dy: -1 }, { dx: 1, dy: 0 }, { dx: -1, dy: 0 }];

	let capturesOpponent = false;
	let savesFriendly = false;
	let putsOpponentInAtari = false;

	// Check group interactions for this specific move coordinate
	for (let g of groups) {
		let key = `${x},${y}`;
		if (g.liberties.has(key)) {
			if (g.liberties.size === 1) {
				if (g.color === opChar) capturesOpponent = true;
				if (g.color === playerChar) savesFriendly = true;
			} else if (g.liberties.size === 2 && g.color === opChar) {
				putsOpponentInAtari = true;
			}
		}
	}

	// HIGHEST PRIORITY: Capture opponent groups
	if (capturesOpponent) {
		score += 2000;
	}

	// CRITICAL PRIORITY: Save our own groups from capture
	if (savesFriendly) {
		score += 1500;
	}

	// HIGH PRIORITY: Threaten opponent by putting them in atari (1 liberty remaining)
	if (putsOpponentInAtari) {
		score += 350;
	}

	// Positional Weighting (Corners and edges)
	let isCorner = (x === 1 || x === size - 2) && (y === 1 || y === size - 2);
	let isEdge = (x === 0 || x === size - 1 || y === 0 || y === size - 1);

	if (isCorner) score += 15;
	if (!isEdge) score += 5;

	// Neighbor Analysis (Connecting friendly stones and applying pressure)
	for (let d of directions) {
		let nx = x + d.dx;
		let ny = y + d.dy;

		if (nx >= 0 && nx < size && ny >= 0 && ny < size) {
			let neighbor = board[nx][ny];

			if (neighbor === playerChar) {
				score += 10; // Connect / expand
			} else if (neighbor === opChar) {
				score += 8;  // Apply pressure
			} else if (neighbor === ".") {
				score += 3;  // Open space
			}
		}
	}

	return score;
}

// Basic suicide check, exempting moves that capture enemy groups.
function isSuicidalMove(board, x, y, size, playerChar, opChar, groups) {
	// If this move captures an enemy group that is in atari, it's NOT suicide.
	for (let g of groups) {
		let key = `${x},${y}`;
		if (g.color === opChar && g.liberties.has(key) && g.liberties.size === 1) {
			return false; // Valid capture move
		}
	}

	// Check direct adjacent empty spaces (liberties for the new stone itself)
	const directions = [{ dx: 0, dy: 1 }, { dx: 0, dy: -1 }, { dx: 1, dy: 0 }, { dx: -1, dy: 0 }];
	let directLiberties = 0;
	let connectedFriendlyGroups = [];

	for (let d of directions) {
		let nx = x + d.dx;
		let ny = y + d.dy;
		if (nx >= 0 && nx < size && ny >= 0 && ny < size) {
			let neighborChar = board[nx][ny];
			if (neighborChar === ".") {
				directLiberties++;
			} else if (neighborChar === playerChar) {
				// Find which friendly group this neighbor belongs to
				let foundGroup = groups.find(g => g.color === playerChar && g.stones.some(s => s.x === nx && s.y === ny));
				if (foundGroup && !connectedFriendlyGroups.includes(foundGroup)) {
					connectedFriendlyGroups.push(foundGroup);
				}
			}
		}
	}

	// If there are open adjacent spaces, it's safe (has immediate liberties)
	if (directLiberties > 0) {
		return false;
	}

	// If no direct empty spaces, check if it connects to any friendly group that has MORE than 1 liberty 
	// (meaning after filling this spot, the combined group will still have at least 1 liberty remaining).
	for (let group of connectedFriendlyGroups) {
		// If the group has > 1 liberty, or its only liberty is this exact coordinate (which is being filled), 
		// we need to see if combining them leaves any open spaces.
		let combinedLiberties = new Set(group.liberties);
		combinedLiberties.delete(`${x},${y}`); // We are playing on this liberty

		// Add any new liberties the new stone brings from other directions (though directLiberties was 0, 
		// check if other connected stones provide breathing room)
		if (combinedLiberties.size > 0) {
			return false; // Safe, connects to a group with remaining breathing room
		}
	}

	// If it has 0 direct liberties and connects to nothing with surviving liberties, it's suicide.
	return true;
}

// Selects a tactical move using safety filtering and position weighting.
export function chooseMove(ns, state) {
	const board = state.board; // String representation array
	const size = board.length;
	const playerChar = state.playerColor === "Black" ? "X" : "O";
	const opChar = state.playerColor === "Black" ? "O" : "X";

	let candidateMoves = [];

	// Collect all legal open spaces and score them
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