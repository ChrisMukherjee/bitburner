/** @param {NS} ns */
/**
 * Choose one of the empty points on the board at random to play
 */
const getRandomMove = (board, validMoves) => {
	const moveOptions = [];
	const size = board[0].length;

	// Look through all the points on the board
	for (let x = 0; x < size; x++) {
		for (let y = 0; y < size; y++) {
			// Make sure the point is a valid move
			const isValidMove = validMoves[x][y] === true;
			// Leave some spaces to make it harder to capture our pieces.
			// We don't want to run out of empty node connections!
			const isNotReservedSpace = x % 2 === 1 || y % 2 === 1;

			if (isValidMove && isNotReservedSpace) {
				moveOptions.push([x, y]);
			}
		}
	}

	// Choose one of the found moves at random
	const randomIndex = Math.floor(Math.random() * moveOptions.length);
	return moveOptions[randomIndex] ?? [];
};