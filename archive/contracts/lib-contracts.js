// Solvers for every coding contract type in the game.
// Each solver takes the contract's data (from ns.codingcontract.getData) and returns the answer.
// SOLVERS maps the exact contract type name to its solver; contracts.js looks types up here.
// This file uses no ns functions, so importing it costs no RAM.

export function solveLargestPrimeFactor(data) {
    let n = data;
    let factor = 2;
    while (factor * factor <= n) {
        if (n % factor === 0) {
            n = n / factor;
        } else {
            factor++;
        }
    }
    return n;
}

export function solveSubarrayMaxSum(data) {
    let best = data[0];
    let current = data[0];
    for (let i = 1; i < data.length; i++) {
        current = Math.max(data[i], current + data[i]);
        best = Math.max(best, current);
    }
    return best;
}

// Ways to write n as a sum of at least two positive integers
export function solveTotalWaysToSum(data) {
    let dp = new Array(data + 1).fill(0);
    dp[0] = 1;
    for (let i = 1; i < data; i++) {
        for (let j = i; j <= data; j++) {
            dp[j] += dp[j - i];
        }
    }
    return dp[data];
}

export function solveTotalWaysToSumII(data) {
    let [n, nums] = data;
    let dp = new Array(n + 1).fill(0);
    dp[0] = 1;
    for (let num of nums) {
        for (let j = num; j <= n; j++) {
            dp[j] += dp[j - num];
        }
    }
    return dp[n];
}

export function solveSpiralizeMatrix(data) {
    let result = [];
    if (data.length === 0) return result;
    let top = 0, bottom = data.length - 1, left = 0, right = data[0].length - 1;
    while (top <= bottom && left <= right) {
        for (let c = left; c <= right; c++) result.push(data[top][c]);
        top++;
        for (let r = top; r <= bottom; r++) result.push(data[r][right]);
        right--;
        if (top <= bottom) {
            for (let c = right; c >= left; c--) result.push(data[bottom][c]);
            bottom--;
        }
        if (left <= right) {
            for (let r = bottom; r >= top; r--) result.push(data[r][left]);
            left++;
        }
    }
    return result;
}

export function solveArrayJumpingGame(data) {
    let reach = 0;
    for (let i = 0; i < data.length && i <= reach; i++) {
        reach = Math.max(reach, i + data[i]);
    }
    return reach >= data.length - 1 ? 1 : 0;
}

// Fewest jumps to reach the last index, or 0 if it can't be reached
export function solveArrayJumpingGameII(data) {
    let n = data.length;
    if (n <= 1) return 0;
    let jumps = 0, currentEnd = 0, farthest = 0;
    for (let i = 0; i < n - 1; i++) {
        if (i > currentEnd) return 0;
        farthest = Math.max(farthest, i + data[i]);
        if (i === currentEnd) {
            if (farthest <= i) return 0;
            jumps++;
            currentEnd = farthest;
            if (currentEnd >= n - 1) return jumps;
        }
    }
    return currentEnd >= n - 1 ? jumps : 0;
}

export function solveMergeIntervals(data) {
    let intervals = data.map((x) => [x[0], x[1]]).sort((a, b) => a[0] - b[0]);
    let result = [];
    for (let interval of intervals) {
        let last = result[result.length - 1];
        if (last && interval[0] <= last[1]) {
            last[1] = Math.max(last[1], interval[1]);
        } else {
            result.push(interval);
        }
    }
    return result;
}

export function solveGenerateIPs(data) {
    let result = [];
    let validOctet = (s) => s.length > 0 && s.length <= 3 && (s === "0" || s[0] !== "0") && Number(s) <= 255;
    for (let a = 1; a <= 3; a++) {
        for (let b = 1; b <= 3; b++) {
            for (let c = 1; c <= 3; c++) {
                let d = data.length - a - b - c;
                if (d < 1 || d > 3) continue;
                let parts = [
                    data.slice(0, a),
                    data.slice(a, a + b),
                    data.slice(a + b, a + b + c),
                    data.slice(a + b + c),
                ];
                if (parts.every(validOctet)) result.push(parts.join("."));
            }
        }
    }
    return result;
}

export function solveStockTraderI(data) {
    return maxProfitWithTrades(1, data);
}

export function solveStockTraderII(data) {
    let profit = 0;
    for (let i = 1; i < data.length; i++) {
        profit += Math.max(0, data[i] - data[i - 1]);
    }
    return profit;
}

export function solveStockTraderIII(data) {
    return maxProfitWithTrades(2, data);
}

export function solveStockTraderIV(data) {
    return maxProfitWithTrades(data[0], data[1]);
}

// Best profit using at most k buy-then-sell trades
function maxProfitWithTrades(k, prices) {
    if (prices.length < 2 || k <= 0) return 0;
    if (k >= prices.length / 2) return solveStockTraderII(prices);
    let hold = new Array(k + 1).fill(-Infinity);
    let sold = new Array(k + 1).fill(0);
    for (let price of prices) {
        for (let j = k; j >= 1; j--) {
            sold[j] = Math.max(sold[j], hold[j] + price);
            hold[j] = Math.max(hold[j], sold[j - 1] - price);
        }
    }
    return sold[k];
}

export function solveTriangleMinPath(data) {
    let dp = data[data.length - 1].slice();
    for (let row = data.length - 2; row >= 0; row--) {
        for (let i = 0; i < data[row].length; i++) {
            dp[i] = data[row][i] + Math.min(dp[i], dp[i + 1]);
        }
    }
    return dp[0];
}

export function solveUniquePathsI(data) {
    let [rows, cols] = data;
    let dp = new Array(cols).fill(1);
    for (let r = 1; r < rows; r++) {
        for (let c = 1; c < cols; c++) {
            dp[c] += dp[c - 1];
        }
    }
    return dp[cols - 1];
}

export function solveUniquePathsII(data) {
    let cols = data[0].length;
    let dp = new Array(cols).fill(0);
    dp[0] = data[0][0] === 1 ? 0 : 1;
    for (let r = 0; r < data.length; r++) {
        for (let c = 0; c < cols; c++) {
            if (data[r][c] === 1) {
                dp[c] = 0;
            } else if (c > 0) {
                dp[c] += dp[c - 1];
            }
        }
    }
    return dp[cols - 1];
}

// Breadth-first search; returns a string of U/D/L/R moves, or "" if there is no path
export function solveShortestPath(data) {
    let rows = data.length, cols = data[0].length;
    if (data[0][0] === 1 || data[rows - 1][cols - 1] === 1) return "";
    let moves = [[-1, 0, "U"], [1, 0, "D"], [0, -1, "L"], [0, 1, "R"]];
    let prev = data.map((row) => row.map(() => null));
    prev[0][0] = "start";
    let queue = [[0, 0]];
    for (let head = 0; head < queue.length; head++) {
        let [r, c] = queue[head];
        if (r === rows - 1 && c === cols - 1) break;
        for (let [dr, dc, letter] of moves) {
            let nr = r + dr, nc = c + dc;
            if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
            if (data[nr][nc] === 1 || prev[nr][nc] !== null) continue;
            prev[nr][nc] = [r, c, letter];
            queue.push([nr, nc]);
        }
    }
    if (prev[rows - 1][cols - 1] === null) return "";
    let path = [];
    let r = rows - 1, c = cols - 1;
    while (!(r === 0 && c === 0)) {
        let [pr, pc, letter] = prev[r][c];
        path.push(letter);
        r = pr;
        c = pc;
    }
    return path.reverse().join("");
}

// Remove the fewest parentheses to make the string valid; returns every distinct result
export function solveSanitizeParentheses(data) {
    let isValid = (s) => {
        let depth = 0;
        for (let ch of s) {
            if (ch === "(") depth++;
            else if (ch === ")" && --depth < 0) return false;
        }
        return depth === 0;
    };
    let level = new Set([data]);
    while (level.size > 0) {
        let valid = [...level].filter(isValid);
        if (valid.length > 0) return valid;
        let next = new Set();
        for (let s of level) {
            for (let i = 0; i < s.length; i++) {
                if (s[i] === "(" || s[i] === ")") next.add(s.slice(0, i) + s.slice(i + 1));
            }
        }
        level = next;
    }
    return [""];
}

export function solveMathExpressions(data) {
    let [digits, target] = data;
    let result = [];
    // value: total so far; last: the last term, kept so * can be applied before + and -
    let search = (pos, expr, value, last) => {
        if (pos === digits.length) {
            if (value === target) result.push(expr);
            return;
        }
        for (let end = pos + 1; end <= digits.length; end++) {
            if (end > pos + 1 && digits[pos] === "0") break;
            let numStr = digits.slice(pos, end);
            let num = Number(numStr);
            if (pos === 0) {
                search(end, numStr, num, num);
            } else {
                search(end, expr + "+" + numStr, value + num, num);
                search(end, expr + "-" + numStr, value - num, -num);
                search(end, expr + "*" + numStr, value - last + last * num, last * num);
            }
        }
    };
    search(0, "", 0, 0);
    return result;
}

// The game's format: bit 0 is overall parity, powers of two are parity bits,
// data bits fill the other positions most significant bit first, and the code is only as long as the data needs.
export function solveHammingEncode(data) {
    let bits = data.toString(2).split("").map(Number);
    let code = [0];
    let next = 0;
    for (let i = 1; next < bits.length; i++) {
        code[i] = (i & (i - 1)) === 0 ? 0 : bits[next++];
    }
    let syndrome = 0;
    for (let i = 0; i < code.length; i++) {
        if (code[i]) syndrome ^= i;
    }
    for (let p = 1; p < code.length; p *= 2) {
        code[p] = (syndrome & p) ? 1 : 0;
    }
    code[0] = code.reduce((sum, b) => sum + b, 0) % 2;
    return code.join("");
}

export function solveHammingDecode(data) {
    let bits = data.split("").map(Number);
    let syndrome = 0;
    for (let i = 0; i < bits.length; i++) {
        if (bits[i]) syndrome ^= i;
    }
    if (syndrome) bits[syndrome] ^= 1;
    let dataBits = "";
    for (let i = 1; i < bits.length; i++) {
        if ((i & (i - 1)) !== 0) dataBits += bits[i];
    }
    return parseInt(dataBits, 2);
}

// Returns a 0/1 color per vertex, or [] if the graph can't be 2-colored
export function solveTwoColoring(data) {
    let [n, edges] = data;
    let neighbours = Array.from({ length: n }, () => []);
    for (let [a, b] of edges) {
        neighbours[a].push(b);
        neighbours[b].push(a);
    }
    let colors = new Array(n).fill(-1);
    for (let start = 0; start < n; start++) {
        if (colors[start] !== -1) continue;
        colors[start] = 0;
        let queue = [start];
        for (let head = 0; head < queue.length; head++) {
            let v = queue[head];
            for (let u of neighbours[v]) {
                if (colors[u] === -1) {
                    colors[u] = 1 - colors[v];
                    queue.push(u);
                } else if (colors[u] === colors[v]) {
                    return [];
                }
            }
        }
    }
    return colors;
}

// Runs of up to 9 characters, written as count then character
export function solveRLE(data) {
    let out = "";
    let i = 0;
    while (i < data.length) {
        let run = 1;
        while (run < 9 && data[i + run] === data[i]) run++;
        out += run + data[i];
        i += run;
    }
    return out;
}

export function solveLZDecompress(data) {
    let out = "";
    let i = 0;
    let literal = true;
    while (i < data.length) {
        let len = Number(data[i]);
        if (len === 0) {
            i++;
        } else if (literal) {
            out += data.slice(i + 1, i + 1 + len);
            i += 1 + len;
        } else {
            let offset = Number(data[i + 1]);
            for (let k = 0; k < len; k++) out += out[out.length - offset];
            i += 2;
        }
        literal = !literal;
    }
    return out;
}

// Shortest LZ encoding, found by dynamic programming over (position, which chunk type comes next).
export function solveLZCompress(data) {
    let n = data.length;
    // best[i][t]: shortest encoding of data.slice(i) when the next chunk is type t (0 = literal, 1 = back-reference)
    let best = Array.from({ length: n + 1 }, () => [null, null]);
    best[n] = ["", ""];
    for (let i = n - 1; i >= 0; i--) {
        let options = [null, null];
        for (let len = 1; len <= 9 && i + len <= n; len++) {
            let rest = best[i + len][1];
            let candidate = len + data.slice(i, i + len) + rest;
            if (options[0] === null || candidate.length < options[0].length) options[0] = candidate;
        }
        for (let offset = 1; offset <= 9 && offset <= i; offset++) {
            for (let len = 1; len <= 9 && i + len <= n; len++) {
                if (data[i + len - 1] !== data[i + len - 1 - offset]) break;
                let rest = best[i + len][0];
                let candidate = String(len) + offset + rest;
                if (options[1] === null || candidate.length < options[1].length) options[1] = candidate;
            }
        }
        // A "0" chunk skips a turn and hands over to the other chunk type
        let lit = options[0];
        let ref = options[1];
        if (ref !== null && (lit === null || 1 + ref.length < lit.length)) lit = "0" + ref;
        if (options[0] !== null && (ref === null || 1 + options[0].length < ref.length)) ref = "0" + options[0];
        best[i] = [lit, ref];
    }
    return best[0][0];
}

export function solveCaesar(data) {
    let [text, shift] = data;
    return text
        .split("")
        .map((ch) => (ch === " " ? ch : String.fromCharCode(((ch.charCodeAt(0) - 65 - shift + 26 * 10) % 26) + 65)))
        .join("");
}

export function solveVigenere(data) {
    let [text, key] = data;
    return text
        .split("")
        .map((ch, i) => {
            if (ch === " ") return ch;
            let shift = key.charCodeAt(i % key.length) - 65;
            return String.fromCharCode(((ch.charCodeAt(0) - 65 + shift) % 26) + 65);
        })
        .join("");
}

// Nearest integer to the square root of a big number, using Newton's method on BigInt
export function solveSquareRoot(data) {
    let n = BigInt(data);
    if (n < 2n) return n.toString();
    let x = BigInt(Math.floor(Math.sqrt(Number(n))));
    if (x <= 0n) x = 1n;
    while (true) {
        let y = (x + n / x) / 2n;
        if (y === x || y === x + 1n) break;
        x = y;
    }
    while (x * x > n) x--;
    while ((x + 1n) * (x + 1n) <= n) x++;
    // x is now floor(sqrt(n)); round up when n is past the halfway point (x + 0.5)^2 = x^2 + x + 0.25
    if (n - x * x > x) x++;
    return x.toString();
}

export function solveTotalPrimes(data) {
    let low = Math.max(2, data[0]);
    let high = data[1];
    if (high < low) return 0;
    let composite = new Uint8Array(high + 1);
    let count = 0;
    for (let i = 2; i <= high; i++) {
        if (composite[i]) continue;
        if (i >= low) count++;
        for (let j = i * i; j <= high; j += i) composite[j] = 1;
    }
    return count;
}

// Largest all-zero rectangle, returned as [[topRow, leftCol], [bottomRow, rightCol]]
export function solveLargestRectangle(data) {
    let rows = data.length, cols = data[0].length;
    let heights = new Array(cols).fill(0);
    let bestArea = 0;
    let best = [[0, 0], [0, 0]];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) heights[c] = data[r][c] === 0 ? heights[c] + 1 : 0;
        for (let c = 0; c < cols; c++) {
            if (heights[c] === 0) continue;
            let left = c, right = c;
            while (left > 0 && heights[left - 1] >= heights[c]) left--;
            while (right < cols - 1 && heights[right + 1] >= heights[c]) right++;
            let area = (right - left + 1) * heights[c];
            if (area > bestArea) {
                bestArea = area;
                best = [[r - heights[c] + 1, left], [r, right]];
            }
        }
    }
    return best;
}

export const SOLVERS = {
    "Find Largest Prime Factor": solveLargestPrimeFactor,
    "Subarray with Maximum Sum": solveSubarrayMaxSum,
    "Total Ways to Sum": solveTotalWaysToSum,
    "Total Ways to Sum II": solveTotalWaysToSumII,
    "Spiralize Matrix": solveSpiralizeMatrix,
    "Array Jumping Game": solveArrayJumpingGame,
    "Array Jumping Game II": solveArrayJumpingGameII,
    "Merge Overlapping Intervals": solveMergeIntervals,
    "Generate IP Addresses": solveGenerateIPs,
    "Algorithmic Stock Trader I": solveStockTraderI,
    "Algorithmic Stock Trader II": solveStockTraderII,
    "Algorithmic Stock Trader III": solveStockTraderIII,
    "Algorithmic Stock Trader IV": solveStockTraderIV,
    "Minimum Path Sum in a Triangle": solveTriangleMinPath,
    "Unique Paths in a Grid I": solveUniquePathsI,
    "Unique Paths in a Grid II": solveUniquePathsII,
    "Shortest Path in a Grid": solveShortestPath,
    "Sanitize Parentheses in Expression": solveSanitizeParentheses,
    "Find All Valid Math Expressions": solveMathExpressions,
    "HammingCodes: Integer to Encoded Binary": solveHammingEncode,
    "HammingCodes: Encoded Binary to Integer": solveHammingDecode,
    "Proper 2-Coloring of a Graph": solveTwoColoring,
    "Compression I: RLE Compression": solveRLE,
    "Compression II: LZ Decompression": solveLZDecompress,
    "Compression III: LZ Compression": solveLZCompress,
    "Encryption I: Caesar Cipher": solveCaesar,
    "Encryption II: Vigenère Cipher": solveVigenere,
    "Square Root": solveSquareRoot,
    "Total Number of Primes": solveTotalPrimes,
    "Largest Rectangle in a Matrix": solveLargestRectangle,
};
