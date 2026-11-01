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
    const solution = solveContract(type, data);

    if (solution !== null) {
      const result = ns.codingcontract.attempt(solution, file, server);
      if (result) {
        ns.tprint(`[SUCCESS] Solved "${type}" on ${server}! Reward: ${result}`);
        solvedCount++;
      } else {
        ns.tprint(`[FAILED] Incorrect solution submitted for "${type}" on ${server}. Won't retry it.`);
        ns.write(FAILED_FILE, `${server}:${file}\n`, "a");
      }
    } else {
      ns.tprint(`[UNKNOWN] No solver written yet for contract type: "${type}" on ${server}`);
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
