/**
 * Slim IPvGO bot. Same strategy as IPvGOV2.js, but valid moves, liberties and chains are worked out
 * here from the board instead of the ns.go.analysis calls, which cost most of V2's RAM.
 * The orchestrator already stops older copies, so no ps/kill at startup.
 * @param {NS} ns
 */
export async function main(ns) {
  ns.disableLog("ALL");
  ns.print("Starting IPvGO-lite...");
  const targetMap = new Map([
    ["Netburners", { currentSize: 5, maxSize: 7 }],
    ["Slum Snakes", { currentSize: 5, maxSize: 7 }],
    ["The Black Hand", { currentSize: 5, maxSize: 5 }],
    ["Tetrads", { currentSize: 5, maxSize: 5 }],
    ["Daedalus", { currentSize: 5, maxSize: 5 }],
    ["Illuminati", { currentSize: 5, maxSize: 5 }]
  ]);

  while (true) {
    for (const [faction, config] of targetMap.entries()) {
      try {
        ns.go.resetBoardState(faction, config.currentSize);
      } catch (err) {
        continue;
      }
      ns.print(`=== Targeting ${faction} at ${config.currentSize}x${config.currentSize} ===`);

      let gamesPlayed = 0;
      let wins = 0;
      while (gamesPlayed < 5) {
        let result;
        do {
          const board = ns.go.getBoardState();
          const { liberties, validMoves } = analyse(board);
          const [x, y] = selectSmartMove(board, validMoves, liberties);
          if (x === undefined || y === undefined) {
            result = await ns.go.passTurn();
          } else {
            try {
              result = await ns.go.makeMove(x, y);
            } catch (e) {
              result = await ns.go.passTurn();   // our rules check missed something (e.g. ko): pass instead
            }
          }
          await ns.go.opponentNextTurn();
          await ns.sleep(50);
        } while (result?.type !== "gameOver");

        const gameState = ns.go.getGameState();
        gamesPlayed++;
        if (gameState.blackScore > gameState.whiteScore) wins++;
        ns.print(`[${gameState.blackScore > gameState.whiteScore ? "WIN" : "LOSS"}] Game ${gamesPlayed}/5 vs ${faction}`);

        if (gamesPlayed < 5) {
          try { ns.go.resetBoardState(faction, config.currentSize); } catch (e) { break; }
        }
        await ns.sleep(500);
      }

      const winRate = wins / gamesPlayed;
      if (winRate >= 0.8 && config.currentSize < config.maxSize) config.currentSize += 2;
      else if (winRate < 0.4 && config.currentSize > 5) config.currentSize -= 2;
    }
  }
}

/** Liberties of every stone's chain, and which empty points can be played (not suicide). Ko is not checked. */
function analyse(board) {
  const size = board.length;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const at = (x, y) => (x >= 0 && y >= 0 && x < size && y < size ? board[x][y] : null);
  const liberties = Array.from({ length: size }, () => Array(size).fill(-1));
  const chainOf = Array.from({ length: size }, () => Array(size).fill(null));

  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      const c = board[x][y];
      if ((c !== "X" && c !== "O") || chainOf[x][y]) continue;
      const stones = [[x, y]];
      const libs = new Set();
      const chain = { stones, libs };
      chainOf[x][y] = chain;
      for (let i = 0; i < stones.length; i++) {
        const [sx, sy] = stones[i];
        for (const [dx, dy] of dirs) {
          const nx = sx + dx, ny = sy + dy;
          const n = at(nx, ny);
          if (n === ".") libs.add(nx * size + ny);
          else if (n === c && !chainOf[nx][ny]) { chainOf[nx][ny] = chain; stones.push([nx, ny]); }
        }
      }
      for (const [sx, sy] of stones) liberties[sx][sy] = libs.size;
    }
  }

  const validMoves = Array.from({ length: size }, () => Array(size).fill(false));
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      if (board[x][y] !== ".") continue;
      let ok = false;
      for (const [dx, dy] of dirs) {
        const n = at(x + dx, y + dy);
        if (n === ".") { ok = true; break; }
        if (n === "X" && liberties[x + dx][y + dy] > 1) { ok = true; break; }   // joins a chain that keeps a liberty
        if (n === "O" && liberties[x + dx][y + dy] === 1) { ok = true; break; } // captures
      }
      validMoves[x][y] = ok;
    }
  }
  return { liberties, validMoves };
}

const selectSmartMove = (board, validMoves, liberties) => {
  const size = board.length;
  let bestStrategicMove = null;
  let highestScore = 5;

  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      if (!validMoves[x]?.[y]) continue;
      const neighbors = [
        { nx: x + 1, ny: y }, { nx: x - 1, ny: y }, { nx: x, ny: y + 1 }, { nx: x, ny: y - 1 }
      ];
      const emptyAdjacent = neighbors.filter(n => board[n.nx]?.[n.ny] === ".");
      const friendlyNeighbors = neighbors.filter(n => board[n.nx]?.[n.ny] === "X");
      const enemyNeighbors = neighbors.filter(n => board[n.nx]?.[n.ny] === "O");
      const hasStrongFriendlyNeighbor = friendlyNeighbors.some(n => (liberties[n.nx]?.[n.ny] ?? 0) >= 3);
      const isSafeMove = (emptyAdjacent.length >= 2) || hasStrongFriendlyNeighbor;

      for (const { nx, ny } of neighbors) {
        const piece = board[nx]?.[ny];
        const lib = liberties[nx]?.[ny] ?? 0;
        if (!piece) continue;
        if (piece === "X" && lib === 1 && isSafeMove) return [x, y];
        if (piece === "O" && lib === 1) return [x, y];
      }

      const isNotReservedSpace = (x % 2 === 1 || y % 2 === 1);
      if (!isSafeMove || !isNotReservedSpace) continue;

      let score = friendlyNeighbors.length * 5 + enemyNeighbors.length * 6;
      let near = 0;
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          if (x + dx >= 0 && x + dx < size && y + dy >= 0 && y + dy < size && board[x + dx][y + dy] === "X") near++;
        }
      }
      score += Math.min(near, 4) * 2 + emptyAdjacent.length * 2;
      if (score > highestScore) { highestScore = score; bestStrategicMove = [x, y]; }
    }
  }
  return bestStrategicMove ?? [undefined, undefined];
};
