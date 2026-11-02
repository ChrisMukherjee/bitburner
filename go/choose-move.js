// Design: docs/go-bot.md
/** @param {NS} ns */
// IPvGO move selection with Monte Carlo tree search. Pure functions, no ns calls, so this file costs no RAM.
//
// For each move, the bot plays thousands of quick games to the end from the current position
// (both sides capture when they can, rescue groups in atari, don't fill their own eyes and avoid
// self-atari) and keeps the move that wins most often. The search tree (UCT with RAVE) spends more
// of those games on the promising moves and on the opponent's best answers to them.
//
// Scoring follows the v3.0.0 rules exactly: stones on the board plus empty regions that touch only
// one colour, komi for white, ties go to black, and no dead stones are removed. Two passes in a row
// end the game and score the board as it stands, so passing is searched like any other move.

const BLACK = 1;
const WHITE = 2;
const WALL = 3; // offline node ("#")

// Search settings. timeMs is the thinking time per move; more time = stronger but slower games.
const DEFAULTS = {
	timeMs: 400,
	maxPlayouts: 20000,
	komi: 5.5, // pass the real value from ns.go.getGameState().komi
	opponentPassed: false,
	sliceMs: 25, // await pause() this often so the game UI keeps running
};
const RAVE_K = 400; // how long the all-moves-as-first statistics keep influencing a move
const EXPLORE = 0.25; // UCT exploration constant
const MARGIN_WEIGHT = 0.1; // share of the reward that comes from the score margin, not just win/loss

/**
 * Choose a move for `me` ("X" or "O").
 * @param {string[]} board - ns.go.getBoardState()
 * @param {string} me - "X" for black, "O" for white
 * @param {string[][]} history - ns.go.getMoveHistory(), used for the superko rule
 * @param {boolean} behind - unused by the search (it reads the score itself); kept for the old call signature
 * @param {() => Promise<any>} [pause] - awaited every few ms so big boards don't freeze the game (pass () => ns.sleep(0))
 * @param {{timeMs?: number, maxPlayouts?: number, komi?: number, opponentPassed?: boolean}} [options]
 * @returns {Promise<{type: "move", x: number, y: number, value: number, passValue: number, playouts: number} |
 *           {type: "pass", value: number, passValue: number, playouts: number}>} value = estimated win chance
 */
export async function chooseMove(board, me, history = [], behind = false, pause = null, options = {}) {
	const opt = { ...DEFAULTS, ...options };
	const g = new Game(board, opt.komi);
	const color = me === "X" ? BLACK : WHITE;
	const seen = new Set(history.map((h) => h.join("")));

	const root = new Node(-1, null, 3 - color);
	root.passes = opt.opponentPassed ? 1 : 0;
	expand(root, g.cells, g, color, (move) => {
		// Superko: the real game rejects any move that recreates an earlier board.
		const next = g.cells.slice();
		if (!g.play(next, move, color)) return false;
		return !seen.has(g.toString(next));
	});

	const start = Date.now();
	let sliceStart = start;
	let playouts = 0;
	const cells = new Int8Array(g.size);
	while (playouts < opt.maxPlayouts && Date.now() - start < opt.timeMs) {
		cells.set(g.cells);
		simulate(root, cells, g, color);
		playouts++;
		if (pause && Date.now() - sliceStart > opt.sliceMs) {
			await pause();
			sliceStart = Date.now();
		}
	}

	let best = null;
	let passChild = null;
	for (const child of root.children) {
		if (child.move === PASS) passChild = child;
		if (!best || child.n > best.n) best = child;
	}
	const passValue = passChild && passChild.n ? passChild.w / passChild.n : 0;
	if (!best || best.move === PASS) {
		return { type: "pass", value: passValue, passValue, playouts };
	}
	const { x, y } = g.coords(best.move);
	return { type: "move", x, y, value: best.w / best.n, passValue, playouts };
}

const PASS = -1;

class Node {
	constructor(move, parent, player) {
		this.move = move; // move that led here
		this.parent = parent;
		this.player = player; // who played `move`
		this.children = null;
		this.n = 0; // visits
		this.w = 0; // reward for `player`
		this.rn = 0; // RAVE visits
		this.rw = 0; // RAVE reward for `player`
		this.passes = 0; // consecutive passes ending in this node
	}
}

// Add a child for every sensible move of `toMove` (not filling own eyes, not suicide) plus pass.
function expand(node, cells, g, toMove, filter = null) {
	node.children = [];
	for (let i = 0; i < g.size; i++) {
		if (cells[i] !== 0 || g.isOwnEye(cells, i, toMove)) continue;
		if (!g.isLegal(cells, i, toMove)) continue;
		if (filter && !filter(i)) continue;
		node.children.push(new Node(i, node, toMove));
	}
	const pass = new Node(PASS, node, toMove);
	pass.passes = node.passes + 1;
	node.children.push(pass);
}

// One iteration: walk down the tree, expand a leaf, play a random game to the end, back up the result.
function simulate(root, cells, g, rootColor) {
	let node = root;
	let toMove = rootColor;
	const path = [root];
	// played[i] = colour that first played on point i during this iteration (for RAVE)
	const played = new Int8Array(g.size);

	while (node.children && node.children.length && node.passes < 2) {
		node = select(node);
		if (node.move !== PASS) {
			g.play(cells, node.move, toMove);
			if (!played[node.move]) played[node.move] = toMove;
		}
		path.push(node);
		toMove = 3 - toMove;
	}

	let blackScore;
	if (node.passes >= 2) {
		blackScore = g.margin(cells);
	} else {
		if (node.n > 0 || node === root) expand(node, cells, g, toMove);
		blackScore = playout(cells, g, toMove, node.passes, played);
	}

	// Reward in [0, 1] for black: mostly win/loss, a little for the margin (nodes held add bonus power too).
	const win = blackScore >= 0 ? 1 : 0;
	const marginShare = Math.max(-1, Math.min(1, blackScore / g.points));
	const blackReward = (1 - MARGIN_WEIGHT) * win + MARGIN_WEIGHT * (marginShare + 1) / 2;

	for (const p of path) {
		const reward = p.player === BLACK ? blackReward : 1 - blackReward;
		p.n++;
		p.w += reward;
		if (!p.children) continue;
		// RAVE: credit every child whose move the same player made later in this game.
		for (const c of p.children) {
			if (c.move === PASS || played[c.move] !== c.player) continue;
			c.rn++;
			c.rw += c.player === BLACK ? blackReward : 1 - blackReward;
		}
	}
}

function select(node) {
	let best = null;
	let bestValue = -Infinity;
	const logN = Math.log(node.n + 1);
	for (const c of node.children) {
		let value;
		if (c.n === 0 && c.rn === 0) {
			value = c.move === PASS ? 0.5 : 1.0 + Math.random() * 0.01;
		} else {
			const q = c.n ? c.w / c.n : 0.5;
			const r = c.rn ? c.rw / c.rn : q;
			const beta = c.rn ? Math.sqrt(RAVE_K / (3 * c.n + RAVE_K)) : 0;
			value = (1 - beta) * q + beta * r + EXPLORE * Math.sqrt(logN / (c.n + 1));
		}
		if (value > bestValue) {
			bestValue = value;
			best = c;
		}
	}
	return best;
}

// Quick game to the end with simple tactics. Returns black's score minus white's (komi included).
function playout(cells, g, toMove, passes, played) {
	const limit = g.points * 3;
	const empties = new Int32Array(g.size);
	let last = -1;
	for (let turn = 0; turn < limit && passes < 2; turn++) {
		const move = playoutMove(cells, g, toMove, last, empties);
		if (move === PASS) {
			passes++;
		} else {
			g.play(cells, move, toMove);
			if (!played[move]) played[move] = toMove;
			passes = 0;
		}
		last = move;
		toMove = 3 - toMove;
	}
	return g.margin(cells);
}

function playoutMove(cells, g, color, last, empties) {
	const opp = 3 - color;
	// 1. Tactics around the last move: capture a group it left in atari, or rescue our own.
	if (last >= 0) {
		for (const nb of g.nbs[last]) {
			const c = cells[nb];
			if (c === opp || c === color) {
				const libs = g.liberties(cells, nb, 2);
				if (libs.length === 1) {
					const lib = libs[0];
					if (c === opp && g.isLegal(cells, lib, color)) return lib;
					if (c === color && g.isLegal(cells, lib, color) && !g.isSelfAtari(cells, lib, color)) return lib;
				}
			}
		}
		// The last move itself in atari: capture it.
		if (cells[last] === opp) {
			const libs = g.liberties(cells, last, 2);
			if (libs.length === 1 && g.isLegal(cells, libs[0], color)) return libs[0];
		}
	}
	// 2. Random sensible move.
	let count = 0;
	for (let i = 0; i < g.size; i++) if (cells[i] === 0) empties[count++] = i;
	while (count > 0) {
		const k = (Math.random() * count) | 0;
		const i = empties[k];
		empties[k] = empties[--count];
		if (g.isOwnEye(cells, i, color)) continue;
		if (!g.isLegal(cells, i, color)) continue;
		if (g.isSelfAtari(cells, i, color, 2)) continue;
		return i;
	}
	return PASS;
}

// Board helpers on a flat Int8Array: index = x * n + y, 0 empty, 1 black, 2 white, 3 offline.
class Game {
	constructor(board, komi) {
		this.n = board.length;
		this.size = this.n * this.n;
		this.komi = komi;
		this.cells = new Int8Array(this.size);
		this.points = 0;
		for (let x = 0; x < this.n; x++) {
			for (let y = 0; y < this.n; y++) {
				const ch = board[x][y];
				this.cells[x * this.n + y] = ch === "X" ? BLACK : ch === "O" ? WHITE : ch === "#" ? WALL : 0;
				if (ch !== "#") this.points++;
			}
		}
		this.nbs = [];
		this.diags = [];
		for (let x = 0; x < this.n; x++) {
			for (let y = 0; y < this.n; y++) {
				const list = [];
				for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
					const nx = x + dx, ny = y + dy;
					if (nx >= 0 && nx < this.n && ny >= 0 && ny < this.n && board[nx][ny] !== "#") list.push(nx * this.n + ny);
				}
				this.nbs.push(list);
				const dl = [];
				for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
					const nx = x + dx, ny = y + dy;
					if (nx >= 0 && nx < this.n && ny >= 0 && ny < this.n && board[nx][ny] !== "#") dl.push(nx * this.n + ny);
				}
				this.diags.push(dl);
			}
		}
		this.mark = new Int32Array(this.size);
		this.stamp = 0;
		this.stack = new Int32Array(this.size);
	}

	coords(i) {
		return { x: Math.floor(i / this.n), y: i % this.n };
	}

	toString(cells) {
		let s = "";
		for (let i = 0; i < this.size; i++) s += cells[i] === BLACK ? "X" : cells[i] === WHITE ? "O" : cells[i] === WALL ? "#" : ".";
		return s;
	}

	// Liberties of the group at i, stopping once `max` are found.
	liberties(cells, i, max = Infinity) {
		const color = cells[i];
		const stamp = ++this.stamp;
		const mark = this.mark;
		const stack = this.stack;
		const libs = [];
		let top = 0;
		stack[top++] = i;
		mark[i] = stamp;
		while (top > 0) {
			const p = stack[--top];
			for (const nb of this.nbs[p]) {
				if (mark[nb] === stamp) continue;
				const c = cells[nb];
				if (c === 0) {
					mark[nb] = stamp;
					libs.push(nb);
					if (libs.length >= max) return libs;
				} else if (c === color) {
					mark[nb] = stamp;
					stack[top++] = nb;
				}
			}
		}
		return libs;
	}

	removeGroup(cells, i) {
		const color = cells[i];
		const stack = [i];
		cells[i] = 0;
		let count = 0;
		while (stack.length) {
			const p = stack.pop();
			count++;
			for (const nb of this.nbs[p]) {
				if (cells[nb] === color) {
					cells[nb] = 0;
					stack.push(nb);
				}
			}
		}
		return count;
	}

	// Place a stone and resolve captures. Returns false (board unchanged) for suicide.
	play(cells, i, color) {
		if (cells[i] !== 0) return false;
		const opp = 3 - color;
		cells[i] = color;
		let captured = false;
		for (const nb of this.nbs[i]) {
			if (cells[nb] === opp && this.liberties(cells, nb, 1).length === 0) {
				this.removeGroup(cells, nb);
				captured = true;
			}
		}
		if (!captured && this.liberties(cells, i, 1).length === 0) {
			cells[i] = 0;
			return false;
		}
		return true;
	}

	// Legal = empty and not suicide (superko is only checked at the root).
	isLegal(cells, i, color) {
		if (cells[i] !== 0) return false;
		const opp = 3 - color;
		for (const nb of this.nbs[i]) if (cells[nb] === 0) return true;
		cells[i] = color;
		let ok = false;
		for (const nb of this.nbs[i]) {
			const c = cells[nb];
			if (c === color && this.liberties(cells, nb, 1).length > 0) { ok = true; break; }
			if (c === opp && this.liberties(cells, nb, 1).length === 0) { ok = true; break; }
		}
		cells[i] = 0;
		return ok;
	}

	// Playing at i leaves our new group with one liberty and captures nothing.
	// Single-stone throw-ins (minSize 2) are allowed, since they are often useful.
	isSelfAtari(cells, i, color, minSize = 1) {
		const opp = 3 - color;
		cells[i] = color;
		let result = false;
		let captures = false;
		for (const nb of this.nbs[i]) {
			if (cells[nb] === opp && this.liberties(cells, nb, 1).length === 0) { captures = true; break; }
		}
		if (!captures && this.liberties(cells, i, 2).length === 1) {
			result = minSize <= 1 || this.groupSize(cells, i) >= minSize;
		}
		cells[i] = 0;
		return result;
	}

	groupSize(cells, i) {
		const color = cells[i];
		const stamp = ++this.stamp;
		const stack = this.stack;
		let top = 0, count = 0;
		stack[top++] = i;
		this.mark[i] = stamp;
		while (top > 0) {
			const p = stack[--top];
			count++;
			for (const nb of this.nbs[p]) {
				if (this.mark[nb] !== stamp && cells[nb] === color) {
					this.mark[nb] = stamp;
					stack[top++] = nb;
				}
			}
		}
		return count;
	}

	// An empty point whose neighbours are all ours, and enough diagonals are ours that it is a real eye.
	isOwnEye(cells, i, color) {
		const nbs = this.nbs[i];
		if (nbs.length === 0) return false;
		for (const nb of nbs) if (cells[nb] !== color) return false;
		const diags = this.diags[i];
		let bad = 0;
		for (const d of diags) if (cells[d] === 3 - color) bad++;
		const onEdge = nbs.length < 4 || diags.length < 4;
		return onEdge ? bad === 0 : bad <= 1;
	}

	// Black's score minus white's (with komi), using the game's rules.
	margin(cells) {
		let black = 0, white = 0;
		const stamp = ++this.stamp;
		const mark = this.mark;
		for (let i = 0; i < this.size; i++) {
			const c = cells[i];
			if (c === BLACK) black++;
			else if (c === WHITE) white++;
			else if (c === 0 && mark[i] !== stamp) {
				// flood the empty region and see which colours border it
				const stack = [i];
				mark[i] = stamp;
				let count = 0, borders = 0;
				while (stack.length) {
					const p = stack.pop();
					count++;
					for (const nb of this.nbs[p]) {
						const v = cells[nb];
						if (v === 0) {
							if (mark[nb] !== stamp) { mark[nb] = stamp; stack.push(nb); }
						} else if (v === BLACK) borders |= 1;
						else if (v === WHITE) borders |= 2;
					}
				}
				// The game ignores a region covering almost the whole board.
				if (count > this.size - 3) continue;
				if (borders === 1) black += count;
				else if (borders === 2) white += count;
			}
		}
		return black - (white + this.komi);
	}
}

/** Place a stone on a string[][] grid and resolve captures (kept for older callers). */
export function play(grid, x, y, color) {
	const board = toBoard(grid);
	const g = new Game(board, 0);
	const cells = g.cells.slice();
	const before = cells.reduce((s, c) => s + (c !== 0 ? 1 : 0), 0);
	if (!g.play(cells, x * g.n + y, color === "X" ? BLACK : WHITE)) return null;
	const after = cells.reduce((s, c) => s + (c !== 0 ? 1 : 0), 0);
	const text = g.toString(cells);
	const next = Array.from({ length: g.n }, (_, i) => text.slice(i * g.n, (i + 1) * g.n).split(""));
	return { grid: next, captured: before + 1 - after };
}

export function toGrid(board) {
	return board.map((col) => col.split(""));
}

export function toBoard(grid) {
	return grid.map((col) => col.join(""));
}
