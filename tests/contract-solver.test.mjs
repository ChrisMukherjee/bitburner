// contracts/workers/contract-solver.js: every solver against an independent brute-force oracle or a worked example,
// and the one-shot main's handling of wrong answers (a wrong answer burns one of only a few tries).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNs } from "./support/fake-ns.mjs";
import { CONTRACT_PORT } from "/contracts/config.js";
import { solveContract as solve, main } from "/contracts/workers/contract-solver.js";

// Small deterministic random numbers so a failing case can be replayed.
function rng(seed) {
	let s = seed >>> 0;
	return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
const randInt = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const clone = (x) => JSON.parse(JSON.stringify(x));

test("unknown contract types return null so main reports them instead of guessing", () => {
	assert.equal(solve("Some New Contract", [1]), null);
});

test("Subarray with Maximum Sum equals the brute-force best contiguous sum, including all-negative arrays", () => {
	const r = rng(1);
	for (let t = 0; t < 200; t++) {
		const arr = Array.from({ length: randInt(r, 1, 10) }, () => randInt(r, -9, 9));
		let best = -Infinity;
		for (let i = 0; i < arr.length; i++) for (let j = i; j < arr.length; j++) best = Math.max(best, arr.slice(i, j + 1).reduce((a, b) => a + b, 0));
		assert.equal(solve("Subarray with Maximum Sum", arr), best, JSON.stringify(arr));
	}
});

test("Unique Paths I and II match a path-counting recursion; a blocked start or end gives 0", () => {
	const count = (grid, r = 0, c = 0) => {
		if (r >= grid.length || c >= grid[0].length || grid[r][c] === 1) return 0;
		if (r === grid.length - 1 && c === grid[0].length - 1) return 1;
		return count(grid, r + 1, c) + count(grid, r, c + 1);
	};
	const r = rng(2);
	for (let t = 0; t < 100; t++) {
		const rows = randInt(r, 1, 6), cols = randInt(r, 1, 6);
		const open = Array.from({ length: rows }, () => new Array(cols).fill(0));
		assert.equal(solve("Unique Paths in a Grid I", [rows, cols]), count(open), `${rows}x${cols}`);
		const grid = open.map((row) => row.map(() => (r() < 0.25 ? 1 : 0)));
		assert.equal(solve("Unique Paths in a Grid II", clone(grid)), count(grid), JSON.stringify(grid));
	}
	assert.equal(solve("Unique Paths in a Grid II", [[1, 0], [0, 0]]), 0, "blocked start");
});

test("Array Jumping Game: 1 only when the last index is reachable; Game II returns the minimum jumps or 0", () => {
	const minJumps = (arr) => {
		const best = new Array(arr.length).fill(Infinity);
		best[0] = 0;
		for (let i = 0; i < arr.length; i++) for (let j = 1; j <= arr[i] && i + j < arr.length; j++) best[i + j] = Math.min(best[i + j], best[i] + 1);
		return best[arr.length - 1];
	};
	const r = rng(3);
	for (let t = 0; t < 300; t++) {
		const arr = Array.from({ length: randInt(r, 1, 9) }, () => randInt(r, 0, 4));
		const m = minJumps(arr);
		assert.equal(solve("Array Jumping Game", arr), m === Infinity ? 0 : 1, JSON.stringify(arr));
		assert.equal(solve("Array Jumping Game II", arr), m === Infinity ? 0 : m, JSON.stringify(arr));
	}
});

test("Merge Overlapping Intervals merges touching and nested ranges and returns them sorted", () => {
	assert.deepEqual(solve("Merge Overlapping Intervals", [[1, 3], [8, 10], [2, 6], [10, 16]]), [[1, 6], [8, 16]]);
	assert.deepEqual(solve("Merge Overlapping Intervals", [[1, 10], [2, 3]]), [[1, 10]], "nested range keeps the outer end");
	assert.deepEqual(solve("Merge Overlapping Intervals", [[5, 6]]), [[5, 6]]);
});

test("Find Largest Prime Factor handles primes, prime powers and a large prime cofactor", () => {
	assert.equal(solve("Find Largest Prime Factor", 13195), 29);
	assert.equal(solve("Find Largest Prime Factor", 97), 97, "a prime is its own largest factor");
	assert.equal(solve("Find Largest Prime Factor", 1024), 2);
	assert.equal(solve("Find Largest Prime Factor", 2 * 999983), 999983);
});

test("Total Ways to Sum counts partitions with at least two parts; Sum II uses only the given numbers", () => {
	// p(n) - 1: A000041 is 1,1,2,3,5,7,11,15,22,30,42
	const p = [1, 1, 2, 3, 5, 7, 11, 15, 22, 30, 42];
	for (let n = 2; n <= 10; n++) assert.equal(solve("Total Ways to Sum", n), p[n] - 1, `n=${n}`);
	assert.equal(solve("Total Ways to Sum II", [4, [1, 2, 3]]), 4, "1111 112 22 13");
	assert.equal(solve("Total Ways to Sum II", [3, [2]]), 0);
});

test("Caesar cipher shifts letters left and leaves spaces; Vigenere adds the repeating key and leaves spaces", () => {
	assert.equal(solve("Encryption I: Caesar Cipher", ["ABC XYZ", 3]), "XYZ UVW", "wraps below A");
	assert.equal(solve("Encryption II: Vigenère Cipher", ["ATTACK", "LEMON"]), "LXFOPV", "textbook Vigenere example");
});

test("Stock traders I-IV match a brute-force best set of non-overlapping trades", () => {
	const brute = (prices, k) => {
		const memo = new Map();
		const go = (i, left, holding) => {
			if (i === prices.length) return 0;
			const key = `${i},${left},${holding}`;
			if (memo.has(key)) return memo.get(key);
			let best = go(i + 1, left, holding);
			if (holding) best = Math.max(best, prices[i] + go(i + 1, left, false));
			else if (left > 0) best = Math.max(best, -prices[i] + go(i + 1, left - 1, true));
			memo.set(key, best);
			return best;
		};
		return go(0, k, false);
	};
	const r = rng(4);
	for (let t = 0; t < 150; t++) {
		const prices = Array.from({ length: randInt(r, 1, 9) }, () => randInt(r, 1, 20));
		const k = randInt(r, 1, 4);
		assert.equal(solve("Algorithmic Stock Trader I", prices), brute(prices, 1), `I ${prices}`);
		assert.equal(solve("Algorithmic Stock Trader II", prices), brute(prices, 99), `II ${prices}`);
		assert.equal(solve("Algorithmic Stock Trader III", prices), brute(prices, 2), `III ${prices}`);
		assert.equal(solve("Algorithmic Stock Trader IV", [k, prices]), brute(prices, k), `IV k=${k} ${prices}`);
	}
	assert.equal(solve("Algorithmic Stock Trader IV", [0, [1, 5]]), 0, "zero transactions allowed");
});

test("Generate IP Addresses lists every valid split, rejecting leading zeros and octets over 255", () => {
	assert.deepEqual(solve("Generate IP Addresses", "25525511135").sort(), ["255.255.11.135", "255.255.111.35"]);
	assert.deepEqual(solve("Generate IP Addresses", "1938718066").sort(), ["193.87.180.66"], "18.066 has a leading zero");
	assert.deepEqual(solve("Generate IP Addresses", "010010").sort(), ["0.10.0.10", "0.100.1.0"]);
	assert.deepEqual(solve("Generate IP Addresses", "999999999999"), [], "no octet may exceed 255");
});

test("Spiralize Matrix walks clockwise for wide, tall, single-row and single-column matrices", () => {
	assert.deepEqual(solve("Spiralize Matrix", [[1, 2, 3], [4, 5, 6], [7, 8, 9]]), [1, 2, 3, 6, 9, 8, 7, 4, 5]);
	assert.deepEqual(solve("Spiralize Matrix", [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]]), [1, 2, 3, 4, 8, 12, 11, 10, 9, 5, 6, 7]);
	assert.deepEqual(solve("Spiralize Matrix", [[1], [2], [3]]), [1, 2, 3]);
	assert.deepEqual(solve("Spiralize Matrix", [[1, 2, 3]]), [1, 2, 3]);
	assert.deepEqual(solve("Spiralize Matrix", [[1, 2], [3, 4], [5, 6]]), [1, 2, 4, 6, 5, 3]);
});

test("Total Number of Primes counts both ends of the range", () => {
	assert.equal(solve("Total Number of Primes", [1, 10]), 4);
	assert.equal(solve("Total Number of Primes", [2, 2]), 1, "an end that is prime is included");
	assert.equal(solve("Total Number of Primes", [0, 1]), 0);
	assert.equal(solve("Total Number of Primes", [90, 100]), 1);
});

test("RLE compression splits runs longer than 9", () => {
	assert.equal(solve("Compression I: RLE Compression", "aaaaabccc"), "5a1b3c");
	assert.equal(solve("Compression I: RLE Compression", "a".repeat(12)), "9a3a");
	assert.equal(solve("Compression I: RLE Compression", "a".repeat(9)), "9a");
	assert.equal(solve("Compression I: RLE Compression", "a".repeat(10) + "b"), "9a1a1b");
});

test("LZ decompression follows the game's worked example and a zero-length chunk", () => {
	assert.equal(solve("Compression II: LZ Decompression", "5aaabb450723abb"), "aaabbaaababababaabb");
	assert.equal(solve("Compression II: LZ Decompression", "5aaabb0"), "aaabb");
	assert.equal(solve("Compression II: LZ Decompression", "4abcd05"), "abcd", "a trailing 0 chunk adds nothing");
});

test("LZ compression round-trips through decompression and is a shortest encoding", () => {
	// Shortest encoding by exhaustive search over chunk choices.
	const shortest = (s) => {
		const memo = new Map();
		// Cheapest finish when the next chunk is of this type (no "0" skip chunk here).
		const chunk = (i, type) => {
			let best = Infinity;
			if (type === 0) for (let len = 1; len <= 9 && i + len <= s.length; len++) best = Math.min(best, 1 + len + go(i + len, 1));
			else for (let back = 1; back <= 9 && back <= i; back++) for (let len = 1; len <= 9 && i + len <= s.length; len++) {
				if (s[i + len - 1] !== s[i + len - 1 - back]) break;
				best = Math.min(best, 2 + go(i + len, 0));
			}
			return best;
		};
		const go = (i, type) => {
			if (i === s.length) return 0;
			const key = `${i},${type}`;
			if (!memo.has(key)) memo.set(key, Math.min(chunk(i, type), 1 + chunk(i, 1 - type))); // a "0" chunk switches type
			return memo.get(key);
		};
		return go(0, 0);
	};
	const r = rng(5);
	for (let t = 0; t < 120; t++) {
		const s = Array.from({ length: randInt(r, 1, 14) }, () => "ab"[randInt(r, 0, 1)]).join("");
		const packed = solve("Compression III: LZ Compression", s);
		assert.equal(solve("Compression II: LZ Decompression", packed), s, `round trip of ${s}`);
		assert.equal(packed.length, shortest(s), `${s} -> ${packed} should be a shortest encoding`);
	}
});

test("Minimum Path Sum in a Triangle matches the minimum over all top-to-bottom paths", () => {
	const r = rng(6);
	for (let t = 0; t < 60; t++) {
		const rows = randInt(r, 1, 6);
		const tri = Array.from({ length: rows }, (_, i) => Array.from({ length: i + 1 }, () => randInt(r, -5, 9)));
		const walk = (row, col) => tri[row][col] + (row === rows - 1 ? 0 : Math.min(walk(row + 1, col), walk(row + 1, col + 1)));
		assert.equal(solve("Minimum Path Sum in a Triangle", tri), walk(0, 0), JSON.stringify(tri));
	}
});

test("Shortest Path in a Grid returns a walkable path of minimum length, or an empty string", () => {
	const walk = (grid, path) => {
		let r = 0, c = 0;
		for (const ch of path) {
			if (ch === "U") r--; else if (ch === "D") r++; else if (ch === "L") c--; else c++;
			if (grid[r]?.[c] !== 0) return false;
		}
		return r === grid.length - 1 && c === grid[0].length - 1;
	};
	const dist = (grid) => {
		const rows = grid.length, cols = grid[0].length;
		if (grid[0][0] || grid[rows - 1][cols - 1]) return Infinity;
		const d = grid.map((row) => row.map(() => Infinity));
		d[0][0] = 0;
		const q = [[0, 0]];
		for (const [r, c] of q) for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
			const nr = r + dr, nc = c + dc;
			if (grid[nr]?.[nc] === 0 && d[nr][nc] === Infinity) { d[nr][nc] = d[r][c] + 1; q.push([nr, nc]); }
		}
		return d[rows - 1][cols - 1];
	};
	const r = rng(7);
	for (let t = 0; t < 120; t++) {
		const grid = Array.from({ length: randInt(r, 1, 6) }, () => Array.from({ length: randInt(r, 1, 1) * 5 }, () => (r() < 0.3 ? 1 : 0)));
		const path = solve("Shortest Path in a Grid", grid);
		const best = dist(grid);
		if (best === Infinity) assert.equal(path, "", JSON.stringify(grid));
		else { assert.equal(path.length, best, JSON.stringify(grid)); assert.ok(walk(grid, path), `${path} must be walkable on ${JSON.stringify(grid)}`); }
	}
	assert.equal(solve("Shortest Path in a Grid", [[0]]), "", "start equals end needs no moves");
});

test("Sanitize Parentheses removes the fewest characters and lists every distinct result", () => {
	assert.deepEqual(solve("Sanitize Parentheses in Expression", "()())()").sort(), ["(())()", "()()()"]);
	assert.deepEqual(solve("Sanitize Parentheses in Expression", "(a)())()").sort(), ["(a())()", "(a)()()"]);
	assert.deepEqual(solve("Sanitize Parentheses in Expression", ")("), [""], "nothing balanced is left but the empty string");
	assert.deepEqual(solve("Sanitize Parentheses in Expression", "()"), ["()"], "already valid stays untouched");
});

test("Find All Valid Math Expressions follows operator precedence and rejects leading zeros", () => {
	assert.deepEqual(solve("Find All Valid Math Expressions", ["123", 6]).sort(), ["1*2*3", "1+2+3"]);
	assert.deepEqual(solve("Find All Valid Math Expressions", ["105", 5]).sort(), ["1*0+5", "10-5"]);
	assert.deepEqual(solve("Find All Valid Math Expressions", ["00", 0]).sort(), ["0*0", "0+0", "0-0"], "00 as one number is not allowed");
	assert.deepEqual(solve("Find All Valid Math Expressions", ["9", 3]), [], "no expression reaches the target");
});

test("Hamming encode matches the game's example and decode undoes it, fixing one flipped bit anywhere", () => {
	assert.equal(solve("HammingCodes: Integer to Encoded Binary", 8), "11110000", "the game's own example");
	assert.equal(solve("HammingCodes: Integer to Encoded Binary", 21), "1001101011");
	for (const value of [1, 2, 5, 8, 21, 100, 255, 1234, 65535]) {
		const code = solve("HammingCodes: Integer to Encoded Binary", value);
		assert.equal(solve("HammingCodes: Encoded Binary to Integer", code), value, `clean ${value}`);
		for (let flip = 1; flip < code.length; flip++) {
			const bad = code.slice(0, flip) + (code[flip] === "0" ? "1" : "0") + code.slice(flip + 1);
			assert.equal(solve("HammingCodes: Encoded Binary to Integer", bad), value, `${value} with bit ${flip} flipped`);
		}
	}
});

test("Proper 2-Coloring returns a valid coloring, covers disconnected vertices, and [] for an odd cycle", () => {
	const valid = (n, edges, colors) => colors.length === n && edges.every(([u, v]) => colors[u] !== colors[v]) && colors.every((c) => c === 0 || c === 1);
	const path = [4, [[0, 1], [1, 2], [2, 3]]];
	assert.ok(valid(...path, solve("Proper 2-Coloring of a Graph", path)));
	const split = [5, [[0, 1], [3, 4]]];
	const c = solve("Proper 2-Coloring of a Graph", split);
	assert.ok(valid(...split, c), "vertex 2 has no edges but still needs a color");
	assert.deepEqual(solve("Proper 2-Coloring of a Graph", [3, [[0, 1], [1, 2], [2, 0]]]), []);
});

test("Square Root rounds to the nearest integer for huge numbers and returns a string", () => {
	assert.equal(solve("Square Root", "16"), "4");
	assert.equal(solve("Square Root", "15"), "4", "sqrt(15)=3.87 rounds up to 4");
	assert.equal(solve("Square Root", "10"), "3", "sqrt(10)=3.16 rounds down");
	assert.equal(solve("Square Root", "0"), "0");
	const root = 123456789012345678901234567890n;
	assert.equal(solve("Square Root", (root * root).toString()), root.toString());
	assert.equal(solve("Square Root", (root * root + root).toString()), root.toString(), "root^2 + root is still closer to root");
	assert.equal(solve("Square Root", (root * root + root + 1n).toString()), (root + 1n).toString());
});

test("Largest Rectangle in a Matrix returns the corners of a maximum-area all-zero rectangle", () => {
	const r = rng(8);
	for (let t = 0; t < 80; t++) {
		const rows = randInt(r, 1, 5), cols = randInt(r, 1, 5);
		const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => (r() < 0.3 ? 1 : 0)));
		let best = 0;
		for (let r1 = 0; r1 < rows; r1++) for (let r2 = r1; r2 < rows; r2++) for (let c1 = 0; c1 < cols; c1++) for (let c2 = c1; c2 < cols; c2++) {
			let clear = true;
			for (let i = r1; i <= r2; i++) for (let j = c1; j <= c2; j++) if (grid[i][j]) clear = false;
			if (clear) best = Math.max(best, (r2 - r1 + 1) * (c2 - c1 + 1));
		}
		const [[r1, c1], [r2, c2]] = solve("Largest Rectangle in a Matrix", grid);
		if (best === 0) continue;
		assert.equal((r2 - r1 + 1) * (c2 - c1 + 1), best, JSON.stringify(grid));
		for (let i = r1; i <= r2; i++) for (let j = c1; j <= c2; j++) assert.equal(grid[i][j], 0, "rectangle must be all zeros");
	}
});

// --- main: what happens after the solver answers ---

function contractNs({ type, data, attempt, exists = true }) {
	const attempts = [];
	const ns = fakeNs({
		overrides: {
			args: [JSON.stringify([["n00dles", "c.cct"]])],
			codingcontract: {
				getContractType: () => type,
				getData: () => data,
				attempt: (answer) => { attempts.push(answer); return typeof attempt === "function" ? attempt(answer) : attempt; },
			},
			fileExists: () => exists,
			scan: () => [],
			getHostname: () => "home",
		},
	});
	return { ns, attempts };
}

test("a wrong answer with tries left is posted to the port so it is never retried", async () => {
	const { ns, attempts } = contractNs({ type: "Square Root", data: "16", attempt: "" });
	await main(ns);
	assert.deepEqual(attempts, ["4"]);
	assert.equal(ns.peek(CONTRACT_PORT), "n00dles:c.cct", "solve-contracts.js reads this to skip the contract next scan");
});

test("a wrong answer on the last try (contract gone) is not posted", async () => {
	const { ns } = contractNs({ type: "Square Root", data: "16", attempt: "", exists: false });
	await main(ns);
	assert.equal(ns.peek(CONTRACT_PORT), "NULL PORT DATA");
});

test("a solved contract posts nothing, and an attempt that throws (bad answer format) is posted as not to retry", async () => {
	const ok = contractNs({ type: "Square Root", data: "16", attempt: "10 money" });
	await main(ok.ns);
	assert.equal(ok.ns.peek(CONTRACT_PORT), "NULL PORT DATA");
	const bad = contractNs({ type: "Square Root", data: "16", attempt: () => { throw new Error("bad format"); } });
	await main(bad.ns);
	assert.equal(bad.ns.peek(CONTRACT_PORT), "n00dles:c.cct");
});

test("a type with no solver never calls attempt, so no try is spent", async () => {
	const { ns, attempts } = contractNs({ type: "Brand New Type", data: 1, attempt: "x" });
	await main(ns);
	assert.deepEqual(attempts, []);
});
