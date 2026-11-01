/** @param {NS} ns */
// IPvGO move selection. Pure functions, no ns calls, so this file costs no RAM.
// Every candidate move is played out on a copy of the board (captures resolved),
// then the opponent's best reply is played out too (2-ply search), and the
// resulting position is scored by territory, stones and group safety.

const DIRS = [[0, 1], [0, -1], [1, 0], [-1, 0]];

// Weight for empty points that are closer to one colour but not yet enclosed.
const INFLUENCE_WEIGHT = 0.6;
// A move must beat passing by at least this much to be worth playing.
const PASS_MARGIN = 0.3;

/**
 * Choose a move for `me` ("X" or "O").
 * @param {string[]} board - ns.go.getBoardState()
 * @param {string} me - "X" for black, "O" for white
 * @param {string[][]} history - ns.go.getMoveHistory(), used for the superko rule
 * @param {boolean} behind - true if the real game score says we are losing
 * @param {() => Promise<any>} [pause] - awaited between candidates so big boards don't freeze the game (pass () => ns.sleep(0))
 * @returns {{type: "move", x: number, y: number, value: number, passValue: number} | {type: "pass", value: number, passValue: number}}
 */
export async function chooseMove(board, me, history = [], behind = false, pause = null) {
	const opp = me === "X" ? "O" : "X";
	const grid = toGrid(board);
	const seen = new Set(history.map(h => h.join("")));
	seen.add(board.join(""));

	// Value of passing: the opponent gets a free move.
	const passValue = bestReplyValue(grid, me, opp);

	let best = null;
	for (const [x, y] of emptyPoints(grid)) {
		if (isOwnEye(grid, x, y, me)) continue;
		const sim = play(grid, x, y, me);
		if (!sim) continue; // suicide
		if (isSelfAtari(sim, x, y)) continue;
		if (seen.has(toBoard(sim.grid).join(""))) continue; // ko / superko

		const value = bestReplyValue(sim.grid, me, opp);
		if (pause) await pause();
		if (!best || value > best.value) best = { x, y, value };
	}

	if (!best) return { type: "pass", value: passValue, passValue };

	// When ahead (or level), only play moves that clearly gain something.
	// When behind on the real score, keep playing anything that isn't a blunder,
	// because passing would just let the game end as a loss.
	const margin = behind ? -1 : PASS_MARGIN;
	if (best.value - passValue < margin) return { type: "pass", value: best.value, passValue };
	return { type: "move", x: best.x, y: best.y, value: best.value, passValue };
}

// Opponent's best reply to `grid` (opponent to move), scored from our side.
function bestReplyValue(grid, me, opp) {
	let worst = evaluate(grid, me, me); // opponent passes
	for (const [x, y] of emptyPoints(grid)) {
		if (isOwnEye(grid, x, y, opp)) continue;
		const sim = play(grid, x, y, opp);
		if (!sim || isSelfAtari(sim, x, y)) continue;
		const v = evaluate(sim.grid, me, me);
		if (v < worst) worst = v;
	}
	return worst;
}

/**
 * Score a position from `me`'s side. `toMove` is who plays next, which matters
 * for groups in atari: the side to move can capture or rescue them.
 */
export function evaluate(grid, me, toMove) {
	const n = grid.length;
	const opp = me === "X" ? "O" : "X";
	let score = 0;

	// Stones and group safety
	const groupSeen = makeSeen(n);
	for (let x = 0; x < n; x++) {
		for (let y = 0; y < n; y++) {
			const c = grid[x][y];
			if ((c !== "X" && c !== "O") || groupSeen[x][y]) continue;
			const g = getGroup(grid, x, y, groupSeen);
			const sign = c === me ? 1 : -1;
			const size = g.stones.length;
			let value = size;
			if (g.liberties === 1) {
				// In atari: if the other side moves next, treat it as captured.
				value = c === toMove ? size * 0.5 : -size;
			} else if (g.liberties === 2) {
				value = size * 0.85;
			}
			score += sign * value;
		}
	}

	// Territory: enclosed regions count fully, contested regions by distance.
	const regionSeen = makeSeen(n);
	for (let x = 0; x < n; x++) {
		for (let y = 0; y < n; y++) {
			if (grid[x][y] !== "." || regionSeen[x][y]) continue;
			const region = getRegion(grid, x, y, regionSeen);
			if (region.borders.size === 1) {
				const owner = region.borders.has(me) ? 1 : -1;
				score += owner * region.points.length;
			} else if (region.borders.size === 2) {
				score += INFLUENCE_WEIGHT * influence(grid, region.points, me, opp);
			}
		}
	}

	return score;
}

// For a contested region, +1 per point closer to our stones, -1 per point closer to theirs.
function influence(grid, points, me, opp) {
	const dMe = distances(grid, me);
	const dOpp = distances(grid, opp);
	let total = 0;
	for (const [x, y] of points) {
		if (dMe[x][y] < dOpp[x][y]) total++;
		else if (dOpp[x][y] < dMe[x][y]) total--;
	}
	return total;
}

// BFS distance through empty points from every stone of `color`.
function distances(grid, color) {
	const n = grid.length;
	const dist = Array.from({ length: n }, () => Array(n).fill(Infinity));
	const queue = [];
	for (let x = 0; x < n; x++) {
		for (let y = 0; y < n; y++) {
			if (grid[x][y] === color) {
				dist[x][y] = 0;
				queue.push([x, y]);
			}
		}
	}
	for (let head = 0; head < queue.length; head++) {
		const [x, y] = queue[head];
		for (const [nx, ny] of neighbors(n, x, y)) {
			if (grid[nx][ny] !== "." || dist[nx][ny] !== Infinity) continue;
			dist[nx][ny] = dist[x][y] + 1;
			queue.push([nx, ny]);
		}
	}
	return dist;
}

/**
 * Place a stone and resolve captures.
 * @returns {{grid: string[][], captured: number} | null} null if the move is illegal (occupied or suicide)
 */
export function play(grid, x, y, color) {
	if (grid[x][y] !== ".") return null;
	const n = grid.length;
	const opp = color === "X" ? "O" : "X";
	const next = grid.map(col => col.slice());
	next[x][y] = color;

	let captured = 0;
	for (const [nx, ny] of neighbors(n, x, y)) {
		if (next[nx][ny] !== opp) continue;
		const g = getGroup(next, nx, ny);
		if (g.liberties === 0) {
			for (const [sx, sy] of g.stones) next[sx][sy] = ".";
			captured += g.stones.length;
		}
	}

	if (captured === 0 && getGroup(next, x, y).liberties === 0) return null;
	return { grid: next, captured };
}

// The stone just played has one liberty left and captured nothing, so it can be taken next move.
// (Throw-ins and snapbacks are skipped too; they are rare on small boards and easy to misjudge.)
function isSelfAtari(sim, x, y) {
	return sim.captured === 0 && getGroup(sim.grid, x, y).liberties === 1;
}

// A single empty point surrounded only by our stones (or the board edge / dead nodes).
// Filling it never helps unless it is the group's last liberty, which play() rejects anyway.
function isOwnEye(grid, x, y, color) {
	let friendly = 0;
	for (const [nx, ny] of neighbors(grid.length, x, y)) {
		const c = grid[nx][ny];
		if (c === color) friendly++;
		else if (c !== "#") return false;
	}
	return friendly > 0;
}

// Stones and liberty count of the group at (x, y).
function getGroup(grid, x, y, seen = makeSeen(grid.length)) {
	const n = grid.length;
	const color = grid[x][y];
	const stones = [];
	const libs = new Set();
	const queue = [[x, y]];
	seen[x][y] = true;
	for (let head = 0; head < queue.length; head++) {
		const [cx, cy] = queue[head];
		stones.push([cx, cy]);
		for (const [nx, ny] of neighbors(n, cx, cy)) {
			const c = grid[nx][ny];
			if (c === ".") libs.add(nx * n + ny);
			else if (c === color && !seen[nx][ny]) {
				seen[nx][ny] = true;
				queue.push([nx, ny]);
			}
		}
	}
	return { stones, liberties: libs.size };
}

// Connected empty region at (x, y) and the colours that border it.
function getRegion(grid, x, y, seen) {
	const n = grid.length;
	const points = [];
	const borders = new Set();
	const queue = [[x, y]];
	seen[x][y] = true;
	for (let head = 0; head < queue.length; head++) {
		const [cx, cy] = queue[head];
		points.push([cx, cy]);
		for (const [nx, ny] of neighbors(n, cx, cy)) {
			const c = grid[nx][ny];
			if (c === "X" || c === "O") borders.add(c);
			else if (c === "." && !seen[nx][ny]) {
				seen[nx][ny] = true;
				queue.push([nx, ny]);
			}
		}
	}
	return { points, borders };
}

function* emptyPoints(grid) {
	for (let x = 0; x < grid.length; x++) {
		for (let y = 0; y < grid.length; y++) {
			if (grid[x][y] === ".") yield [x, y];
		}
	}
}

function neighbors(n, x, y) {
	const out = [];
	for (const [dx, dy] of DIRS) {
		const nx = x + dx;
		const ny = y + dy;
		if (nx >= 0 && nx < n && ny >= 0 && ny < n) out.push([nx, ny]);
	}
	return out;
}

function makeSeen(n) {
	return Array.from({ length: n }, () => Array(n).fill(false));
}

export function toGrid(board) {
	return board.map(col => col.split(""));
}

export function toBoard(grid) {
	return grid.map(col => col.join(""));
}
