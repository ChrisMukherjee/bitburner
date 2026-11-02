import { notify } from "/utils/notify.js";
/** @param {NS} ns **/
// One-shot: solves the contracts solve-contracts.js found, then exits so its ~22GB is freed.
// Arg: JSON list of [server, file] pairs. Wrong answers are added to FAILED_FILE so they're never retried.
const FAILED_FILE = "data/failed-contracts.txt";

export async function main(ns) {
  ns.disableLog("ALL");
  const contracts = JSON.parse(ns.args[0] ?? "[]");
  let solvedCount = 0;

  for (const [server, file] of contracts) {
    const type = ns.codingcontract.getContractType(file, server);
    const data = ns.codingcontract.getData(file, server);

    ns.print(`Found contract: [ ${type} ] on ${server}`);
    let solution = null;
    try {
      solution = solveContract(type, data);
    } catch (err) {
      notify(ns, "[contracts]", `solver for "${type}" on ${server} crashed: ${err}. Skipping it this run.`, "error", true);
      continue;
    }

    if (solution !== null) {
      let result = "";
      try {
        result = ns.codingcontract.attempt(solution, file, server);
      } catch (err) {
        // The game throws (instead of returning "") when the answer is in the wrong format
        notify(ns, "[contracts]", `game rejected the answer format for "${type}" on ${server}: ${err}`, "warning", true);
      }
      if (result) {
        notify(ns, "[contracts]", `solved "${type}" on ${server}. Reward: ${result}`, "success");
        solvedCount++;
      } else {
        notify(ns, "[contracts]", `wrong answer for "${type}" on ${server}. Won't retry it.`, "warning", true);
        ns.write(FAILED_FILE, `${server}:${file}\n`, "a");
      }
    } else {
      notify(ns, "[contracts]", `no solver written yet for "${type}" on ${server}`, "warning", true);
    }
  }

  ns.tprint(`Contract scan finished. Checked ${contracts.length} contracts, successfully solved ${solvedCount}.`);
}

// --- MASTER ROUTER ---
function solveContract(type, data) {
  switch (type) {
    case "Subarray with Maximum Sum":
      return maxSubarraySum(data);
    case "Unique Paths in a Grid I":
      return uniquePathsI(data);
    case "Unique Paths in a Grid II":
      return uniquePathsII(data);
    case "Array Jumping Game":
      return arrayJumpingGame(data);
    case "Merge Overlapping Intervals":
      return mergeIntervals(data);
    case "Find Largest Prime Factor":
      return largestPrimeFactor(data);
    case "Total Ways to Sum":
      return totalWaysToSum(data);
    case "Encryption I: Caesar Cipher":
      return caesarCipher(data);
    case "Algorithmic Stock Trader I":
      return algorithmicStockTraderI(data);
    case "Generate IP Addresses":
      return generateIPs(data);
    case "Encryption II: Vigenère Cipher":
      return vigenereCipher(data);
    case "Array Jumping Game II":
      return arrayJumpingGameII(data);
    case "Spiralize Matrix":
      return spiralizeMatrix(data);
    case "Total Ways to Sum II":
      return totalWaysToSumII(data);
    case "Total Number of Primes":
      return totalPrimesInRange(data);
    case "Compression I: RLE Compression":
      return rleCompression(data);
    case "Compression II: LZ Decompression":
      return lzDecompression(data);
    case "Compression III: LZ Compression":
      return lzCompression(data);
    case "Algorithmic Stock Trader II":
      return stockTraderK([Infinity, data]);
    case "Algorithmic Stock Trader III":
      return stockTraderK([2, data]);
    case "Algorithmic Stock Trader IV":
      return stockTraderK(data);
    case "Minimum Path Sum in a Triangle":
      return minPathTriangle(data);
    case "Shortest Path in a Grid":
      return shortestPathGrid(data);
    case "Sanitize Parentheses in Expression":
      return sanitizeParentheses(data);
    case "Find All Valid Math Expressions":
      return findMathExpressions(data);
    case "HammingCodes: Integer to Encoded Binary":
      return hammingEncodeInt(data);
    case "HammingCodes: Encoded Binary to Integer":
      return hammingDecodeBits(data);
    case "Proper 2-Coloring of a Graph":
      return twoColorGraph(data);
    case "Square Root":
      return bigIntSquareRoot(data);
    case "Largest Rectangle in a Matrix":
      return largestEmptyRectangle(data);
    default:
      return null;
  }
}

// --- INDIVIDUAL SOLVERS ---

// Subarray with Maximum Sum (Kadane's Algorithm)
function maxSubarraySum(arr) {
  let maxSoFar = arr[0];
  let currMax = arr[0];
  for (let i = 1; i < arr.length; i++) {
    currMax = Math.max(arr[i], currMax + arr[i]);
    maxSoFar = Math.max(maxSoFar, currMax);
  }
  return maxSoFar;
}

// Unique Paths in a Grid I (Combinatorics)
function uniquePathsI(data) {
  let [m, n] = data;
  let N = m + n - 2;
  let k = Math.min(m - 1, n - 1);
  let res = 1;
  for (let i = 1; i <= k; i++) {
    res = res * (N - (k - i)) / i;
  }
  return Math.round(res);
}

// Unique Paths in a Grid II (Dynamic Programming with obstacles)
function uniquePathsII(grid) {
  let rows = grid.length;
  let cols = grid[0].length;
  let dp = Array(rows).fill(0).map(() => Array(cols).fill(0));

  if (grid[0][0] === 0) dp[0][0] = 1;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r][c] === 1) {
        dp[r][c] = 0;
      } else {
        if (r > 0) dp[r][c] += dp[r - 1][c];
        if (c > 0) dp[r][c] += dp[r][c - 1];
      }
    }
  }
  return dp[rows - 1][cols - 1];
}

// Array Jumping Game (Greedy Reachability)
function arrayJumpingGame(arr) {
  let reach = 0;
  for (let i = 0; i < arr.length; i++) {
    if (i > reach) return 0;
    reach = Math.max(reach, i + arr[i]);
    if (reach >= arr.length - 1) return 1;
  }
  return 1;
}

// Merge Overlapping Intervals
function mergeIntervals(intervals) {
  if (!intervals || intervals.length <= 1) return intervals;
  intervals.sort((a, b) => a[0] - b[0]);
  let merged = [intervals[0]];
  for (let i = 1; i < intervals.length; i++) {
    let currentInterval = intervals[i];
    let lastMerged = merged[merged.length - 1];
    if (currentInterval[0] <= lastMerged[1]) {
      lastMerged[1] = Math.max(lastMerged[1], currentInterval[1]);
    } else {
      merged.push(currentInterval);
    }
  }
  return merged;
}

// Find Largest Prime Factor
function largestPrimeFactor(num) {
  let n = num;
  let largest = 1;
  for (let factor = 2; factor * factor <= n; factor++) {
    while (n % factor === 0) {
      largest = factor;
      n /= factor;
    }
  }
  // Whatever is left above 1 is a prime bigger than any factor we divided out
  return n > 1 ? n : largest;
}

// Total Ways to Sum
function totalWaysToSum(n) {
  let ways = new Array(n + 1).fill(0);
  ways[0] = 1;
  for (let i = 1; i < n; i++) {
    for (let j = i; j <= n; j++) {
      ways[j] += ways[j - i];
    }
  }
  return ways[n];
}

// Encryption I: Caesar Cipher
function caesarCipher(data) {
  let [plainText, shift] = data;
  let result = "";
  for (let i = 0; i < plainText.length; i++) {
    let char = plainText[i];
    if (char === " ") {
      result += " ";
    } else {
      let code = plainText.charCodeAt(i);
      // Uppercase letters (A-Z: 65-90)
      if (code >= 65 && code <= 90) {
        result += String.fromCharCode(((code - 65 - shift + 26) % 26) + 65);
      } else {
        result += char;
      }
    }
  }
  return result;
}

// Algorithmic Stock Trader I
function algorithmicStockTraderI(prices) {
  let maxProfit = 0;
  let minPrice = prices[0];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] < minPrice) {
      minPrice = prices[i];
    } else {
      let profit = prices[i] - minPrice;
      if (profit > maxProfit) {
        maxProfit = profit;
      }
    }
  }
  return maxProfit;
}

// Generate IP Addresses (try every split into 4 parts, each 0-255 with no leading zeros)
function generateIPs(digits) {
  const str = String(digits);
  const isOctet = (s) => s.length > 0 && s.length <= 3 && (s === "0" || s[0] !== "0") && Number(s) <= 255;
  const results = [];
  for (let a = 1; a <= 3; a++) {
    for (let b = a + 1; b <= a + 3; b++) {
      for (let c = b + 1; c <= b + 3; c++) {
        if (c >= str.length) continue;
        const parts = [str.slice(0, a), str.slice(a, b), str.slice(b, c), str.slice(c)];
        if (parts.every(isOctet)) results.push(parts.join("."));
      }
    }
  }
  return results;
}

// Encryption II: Vigenère Cipher (key letter advances on every character, spaces left as-is)
function vigenereCipher(data) {
  const [plainText, key] = data;
  let result = "";
  for (let i = 0; i < plainText.length; i++) {
    const char = plainText[i];
    if (char === " ") {
      result += " ";
    } else {
      const shifted = (plainText.charCodeAt(i) - 65 + key.charCodeAt(i % key.length) - 65) % 26;
      result += String.fromCharCode(shifted + 65);
    }
  }
  return result;
}

// Array Jumping Game II (Greedy BFS by reach; 0 if the end can't be reached)
function arrayJumpingGameII(arr) {
  if (arr.length <= 1) return 0;
  let jumps = 0;
  let currentEnd = 0;
  let farthest = 0;
  for (let i = 0; i < arr.length - 1; i++) {
    farthest = Math.max(farthest, i + arr[i]);
    if (i === currentEnd) {
      if (farthest <= i) return 0;
      jumps++;
      currentEnd = farthest;
      if (currentEnd >= arr.length - 1) return jumps;
    }
  }
  return currentEnd >= arr.length - 1 ? jumps : 0;
}

// Spiralize Matrix (walk the outer ring clockwise, then shrink the bounds)
function spiralizeMatrix(matrix) {
  const result = [];
  if (matrix.length === 0) return result;
  let top = 0, bottom = matrix.length - 1;
  let left = 0, right = matrix[0].length - 1;
  while (top <= bottom && left <= right) {
    for (let c = left; c <= right; c++) result.push(matrix[top][c]);
    top++;
    for (let r = top; r <= bottom; r++) result.push(matrix[r][right]);
    right--;
    if (top <= bottom) {
      for (let c = right; c >= left; c--) result.push(matrix[bottom][c]);
      bottom--;
    }
    if (left <= right) {
      for (let r = bottom; r >= top; r--) result.push(matrix[r][left]);
      left++;
    }
  }
  return result;
}

// Total Ways to Sum II (coin-change count using only the given numbers)
function totalWaysToSumII(data) {
  const [n, nums] = data;
  const ways = new Array(n + 1).fill(0);
  ways[0] = 1;
  for (const num of nums) {
    for (let j = num; j <= n; j++) {
      ways[j] += ways[j - num];
    }
  }
  return ways[n];
}

// Total Number of Primes (Sieve of Eratosthenes up to the high end, then count the range; both ends included)
function totalPrimesInRange(data) {
  const [low, high] = data;
  const composite = new Uint8Array(high + 1);
  for (let i = 2; i * i <= high; i++) {
    if (!composite[i]) {
      for (let m = i * i; m <= high; m += i) composite[m] = 1;
    }
  }
  let count = 0;
  for (let n = Math.max(2, low); n <= high; n++) {
    if (!composite[n]) count++;
  }
  return count;
}

// Compression I: RLE Compression (runs longer than 9 are split, e.g. 12 a's -> "9a3a")
function rleCompression(str) {
  let result = "";
  let i = 0;
  while (i < str.length) {
    let runLen = 1;
    while (runLen < 9 && i + runLen < str.length && str[i + runLen] === str[i]) runLen++;
    result += runLen + str[i];
    i += runLen;
  }
  return result;
}

// Compression II: LZ Decompression (chunks alternate: literal "L + L chars", then reference "L + X")
function lzDecompression(compressed) {
  let out = "";
  let i = 0;
  let literal = true;
  while (i < compressed.length) {
    const len = Number(compressed[i]);
    if (len === 0) {
      i++;
    } else if (literal) {
      out += compressed.substr(i + 1, len);
      i += 1 + len;
    } else {
      const back = Number(compressed[i + 1]);
      for (let k = 0; k < len; k++) out += out[out.length - back];
      i += 2;
    }
    literal = !literal;
  }
  return out;
}

// Compression III: LZ Compression (DP over [position][next chunk type] for the shortest encoding)
function lzCompression(str) {
  const n = str.length;
  // best[t][i] = shortest encoding of str.slice(i) when the next chunk is type t (0 literal, 1 reference)
  const best = [new Array(n + 1).fill(Infinity), new Array(n + 1).fill(Infinity)];
  const choice = [new Array(n + 1), new Array(n + 1)];
  best[0][n] = 0;
  best[1][n] = 0;
  for (let i = n - 1; i >= 0; i--) {
    let lit = Infinity, litChoice = null;
    for (let len = 1; len <= 9 && i + len <= n; len++) {
      const cost = 1 + len + best[1][i + len];
      if (cost < lit) { lit = cost; litChoice = { len }; }
    }
    let ref = Infinity, refChoice = null;
    for (let back = 1; back <= 9 && back <= i; back++) {
      for (let len = 1; len <= 9 && i + len <= n; len++) {
        if (str[i + len - 1] !== str[i + len - 1 - back]) break;
        const cost = 2 + best[0][i + len];
        if (cost < ref) { ref = cost; refChoice = { len, back }; }
      }
    }
    // A "0" chunk skips to the other type for 1 character
    best[0][i] = Math.min(lit, 1 + ref);
    choice[0][i] = lit <= 1 + ref ? litChoice : { skip: true };
    best[1][i] = Math.min(ref, 1 + lit);
    choice[1][i] = ref <= 1 + lit ? refChoice : { skip: true };
  }
  let out = "";
  let i = 0;
  let t = 0;
  while (i < n) {
    const c = choice[t][i];
    if (c.skip) {
      out += "0";
    } else if (t === 0) {
      out += c.len + str.substr(i, c.len);
      i += c.len;
    } else {
      out += String(c.len) + c.back;
      i += c.len;
    }
    t = 1 - t;
  }
  return out;
}

// Algorithmic Stock Trader II/III/IV: max profit with at most k transactions (k = Infinity for II)
function stockTraderK(data) {
  const [k, prices] = data;
  if (prices.length < 2) return 0;
  if (k >= prices.length / 2) {
    let profit = 0;
    for (let i = 1; i < prices.length; i++) profit += Math.max(0, prices[i] - prices[i - 1]);
    return profit;
  }
  const holding = new Array(k + 1).fill(-Infinity);
  const free = new Array(k + 1).fill(0);
  for (const price of prices) {
    for (let j = k; j >= 1; j--) {
      free[j] = Math.max(free[j], holding[j] + price);
      holding[j] = Math.max(holding[j], free[j - 1] - price);
    }
  }
  return free[k];
}

// Minimum Path Sum in a Triangle (bottom-up DP)
function minPathTriangle(triangle) {
  let row = triangle[triangle.length - 1].slice();
  for (let r = triangle.length - 2; r >= 0; r--) {
    row = triangle[r].map((v, c) => v + Math.min(row[c], row[c + 1]));
  }
  return row[0];
}

// Shortest Path in a Grid (BFS; "" if no path)
function shortestPathGrid(grid) {
  const rows = grid.length;
  const cols = grid[0].length;
  if (grid[0][0] === 1 || grid[rows - 1][cols - 1] === 1) return "";
  const moves = [[-1, 0, "U"], [1, 0, "D"], [0, -1, "L"], [0, 1, "R"]];
  const from = grid.map((line) => line.map(() => null));
  from[0][0] = "";
  const queue = [[0, 0]];
  for (let q = 0; q < queue.length; q++) {
    const [r, c] = queue[q];
    if (r === rows - 1 && c === cols - 1) break;
    for (const [dr, dc, dir] of moves) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
      if (grid[nr][nc] === 1 || from[nr][nc] !== null) continue;
      from[nr][nc] = dir;
      queue.push([nr, nc]);
    }
  }
  if (from[rows - 1][cols - 1] === null) return "";
  let path = "";
  let r = rows - 1, c = cols - 1;
  while (r !== 0 || c !== 0) {
    const dir = from[r][c];
    path = dir + path;
    if (dir === "U") r++;
    else if (dir === "D") r--;
    else if (dir === "L") c++;
    else c--;
  }
  return path;
}

// Sanitize Parentheses in Expression (BFS: remove one char per level, stop at the first level with valid strings)
function sanitizeParentheses(str) {
  const isBalanced = (s) => {
    let depth = 0;
    for (const ch of s) {
      if (ch === "(") depth++;
      else if (ch === ")" && --depth < 0) return false;
    }
    return depth === 0;
  };
  let level = new Set([str]);
  while (level.size > 0) {
    const valid = [...level].filter(isBalanced);
    if (valid.length > 0) return valid;
    const next = new Set();
    for (const s of level) {
      for (let i = 0; i < s.length; i++) {
        if (s[i] === "(" || s[i] === ")") next.add(s.slice(0, i) + s.slice(i + 1));
      }
    }
    level = next;
  }
  return [""];
}

// Find All Valid Math Expressions (backtracking, tracking the last multiplied term for precedence)
function findMathExpressions(data) {
  const [digits, target] = data;
  const results = [];
  const search = (pos, expr, value, lastTerm) => {
    if (pos === digits.length) {
      if (value === target) results.push(expr);
      return;
    }
    for (let end = pos + 1; end <= digits.length; end++) {
      const part = digits.slice(pos, end);
      if (part.length > 1 && part[0] === "0") break;
      const num = Number(part);
      if (pos === 0) {
        search(end, part, num, num);
      } else {
        search(end, expr + "+" + part, value + num, num);
        search(end, expr + "-" + part, value - num, -num);
        search(end, expr + "*" + part, value - lastTerm + lastTerm * num, lastTerm * num);
      }
    }
  };
  search(0, "", 0, 0);
  return results;
}

// HammingCodes: Integer to Encoded Binary (extended Hamming: parity at powers of 2, overall parity at 0)
function hammingEncodeInt(value) {
  const dataBits = value.toString(2).split("").map(Number);
  let parityCount = 0;
  while (2 ** parityCount < parityCount + dataBits.length + 1) parityCount++;
  const bits = new Array(dataBits.length + parityCount + 1).fill(0);
  let d = 0;
  for (let pos = 1; pos < bits.length; pos++) {
    if ((pos & (pos - 1)) !== 0) bits[pos] = dataBits[d++];
  }
  for (let p = 1; p < bits.length; p *= 2) {
    let parity = 0;
    for (let pos = 1; pos < bits.length; pos++) if (pos & p) parity ^= bits[pos];
    bits[p] = parity;
  }
  bits[0] = bits.reduce((a, b) => a ^ b, 0);
  return bits.join("");
}

// HammingCodes: Encoded Binary to Integer (the syndrome is the position of a single flipped bit)
function hammingDecodeBits(encoded) {
  const bits = encoded.split("").map(Number);
  let syndrome = 0;
  for (let pos = 1; pos < bits.length; pos++) if (bits[pos]) syndrome ^= pos;
  if (syndrome !== 0 && syndrome < bits.length) bits[syndrome] ^= 1;
  let dataBits = "";
  for (let pos = 1; pos < bits.length; pos++) {
    if ((pos & (pos - 1)) !== 0) dataBits += bits[pos];
  }
  return parseInt(dataBits, 2);
}

// Proper 2-Coloring of a Graph (BFS from each uncolored vertex; [] if an edge joins two same colors)
function twoColorGraph(data) {
  const [count, edges] = data;
  const adjacent = Array.from({ length: count }, () => []);
  for (const [u, v] of edges) {
    adjacent[u].push(v);
    adjacent[v].push(u);
  }
  const colors = new Array(count).fill(-1);
  for (let start = 0; start < count; start++) {
    if (colors[start] !== -1) continue;
    colors[start] = 0;
    const queue = [start];
    for (let q = 0; q < queue.length; q++) {
      const u = queue[q];
      for (const v of adjacent[u]) {
        if (colors[v] === -1) {
          colors[v] = 1 - colors[u];
          queue.push(v);
        } else if (colors[v] === colors[u]) {
          return [];
        }
      }
    }
  }
  return colors;
}

// Square Root (BigInt Newton's method, rounded to the nearest integer; answer as a string)
function bigIntSquareRoot(value) {
  const n = BigInt(value);
  if (n < 2n) return n.toString();
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  if (x === 0n) x = 1n;
  while (true) {
    const next = (x + n / x) / 2n;
    if (next === x || next === x + 1n) break;
    x = next;
  }
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  // round(sqrt(n)) is x + 1 when n - x^2 > x
  return (n - x * x > x ? x + 1n : x).toString();
}

// Largest Rectangle in a Matrix (largest all-zero rectangle, as [[r1,c1],[r2,c2]])
function largestEmptyRectangle(grid) {
  const rows = grid.length;
  const cols = grid[0].length;
  // heights[c] = run of zeros ending at the current row in column c
  const heights = new Array(cols).fill(0);
  let bestArea = 0;
  let answer = [[0, 0], [0, 0]];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) heights[c] = grid[r][c] === 0 ? heights[c] + 1 : 0;
    for (let c1 = 0; c1 < cols; c1++) {
      let minHeight = Infinity;
      for (let c2 = c1; c2 < cols && heights[c2] > 0; c2++) {
        minHeight = Math.min(minHeight, heights[c2]);
        const area = minHeight * (c2 - c1 + 1);
        if (area > bestArea) {
          bestArea = area;
          answer = [[r - minHeight + 1, c1], [r, c2]];
        }
      }
    }
  }
  return answer;
}
