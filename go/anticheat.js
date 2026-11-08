// @ts-check
/**
 * One-shot, for the "IPvGO anticheat" achievement: keeps playing cheat moves until the game ejects you from
 * the subnet (a failed cheat has a ~10% chance of it, after the first attempt). Needs Source-File 14.2.
 *
 *   run go/anticheat.js --yes        stop the IPvGO bot first (kill it), then run this
 *   run go/anticheat.js              dry run: says what it would do
 *
 * It starts a fresh small game against Netburners (the current game is lost), then destroys empty nodes with
 * ns.go.cheat.destroyNode until the API refuses to play (ejected). Do it in a BitNode where you aren't
 * chasing the BN14 challenge (that one forbids cheating). Win streaks and bonuses are not touched: the game
 * that is thrown away doesn't count as a loss against a real opponent's history file, but the bot's streak
 * for Netburners may reset. Afterwards start go/go-bot.js again.
 */
/** @param {NS} ns */
export async function main(ns) {
	ns.disableLog("ALL");
	const flags = ns.flags([["yes", false]]);
	// @ts-expect-error probe: only exists once SF14.2 is owned
	const ready = (() => { try { return ns.go.getCheatSuccessChance(0) >= 0; } catch { return false; } })();
	if (!ready) {
		ns.tprint("[anticheat] ns.go.cheat needs Source-File 14.2; nothing to do.");
		return;
	}
	if (!flags.yes) {
		ns.tprint("[anticheat] would start a new 5x5 game against Netburners and cheat until ejected. Kill go/go-bot.js, then run with --yes.");
		return;
	}
	let tries = 0;
	ns.go.resetBoardState("Netburners", 5);
	while (true) {
		const board = ns.go.getBoardState();
		let spot = null;
		for (let x = 0; x < board.length && !spot; x++) {
			for (let y = 0; y < board[x].length; y++) {
				if (board[x][y] === ".") { spot = [x, y]; break; }
			}
		}
		if (!spot) {
			ns.go.resetBoardState("Netburners", 5);
			continue;
		}
		try {
			const result = await ns.go.cheat.destroyNode(spot[0], spot[1]);
			tries++;
			if (result.type === "gameOver") ns.go.resetBoardState("Netburners", 5);
		} catch (error) {
			ns.tprint(`[anticheat] stopped after ${tries} cheat moves: ${String(error).slice(0, 200)}. If this is the ejection, the achievement is unlocked (check ns.getUnlockedAchievements()).`);
			return;
		}
		await ns.sleep(50);
	}
}
