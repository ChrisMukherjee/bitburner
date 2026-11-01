/** @param {NS} ns */
import { chooseMove } from "/go/choose-move.js"

// Bonus each faction's win streak gives (from the IPvGO subnet tab).
// Netburners: hacknet production | Slum Snakes: crime success | The Black Hand: hacking money
// Tetrads: str/def/dex/agi | Daedalus: reputation gain | Illuminati: hack/grow/weaken speed
const OPPONENTS = ["Netburners", "Slum Snakes", "The Black Hand", "Tetrads", "Daedalus", "Illuminati", "????????????"];

// Who to move on to once the focus opponent levels off, most useful first for a hacking run.
const ROTATION = ["The Black Hand", "Daedalus", "Illuminati", "Netburners", "Tetrads", "Slum Snakes"];

// Per-opponent bonus history, kept across restarts and aug installs (startup.js restarts the bot per stage).
const DATA_FILE = "/data/go-bonus.json";
const HISTORY = 60; // games kept per opponent

/*
 * Usage: run go/ipvgo-bot.js [--opponent "The Black Hand"] [--size 7] [--illuminati-size 5] [--think 400]
 *        [--games 0] [--debug] [--no-rotate] [--span 10] [--level-off 0.25] [--min-win-rate 0.2] [--status] [--reset]
 *
 * Plays the --opponent (the focus) until its bonus levels off, then the next opponent in ROTATION
 * that hasn't. "Levels off" is measured from ns.go.analysis.getStats(): after every game the bot records
 * how much that opponent's bonusPercent went up. Once it has 2 windows of games, an opponent counts as
 * levelled off when the average gain over the last --span games is below --level-off times the best
 * window average it ever had (the bonus grows roughly like log(power) * power^0.3, so gains per game
 * keep shrinking). An opponent we win less than --min-win-rate of the last window against is skipped
 * too (it barely pays). When every opponent has levelled off, it goes back to the focus.
 *
 * Illuminati is played on --illuminati-size (default 5): the game gives a x8 difficulty multiplier for
 * Illuminati on 5x5 versus x2 on 7x7, and on 5x5 the bot wins far more often. Use 0 to play it on --size.
 * --think is the move search time in ms (choose-move.js runs a Monte Carlo search; more = stronger, slower).
 */
export async function main(ns) {
	ns.disableLog("ALL");
	const flags = ns.flags([
		["opponent", "Netburners"],
		["size", 7],
		["illuminati-size", 5], // 0 = same as --size
		["think", 400], // ms of search per move
		["games", 0], // 0 = play forever
		["debug", false],
		["no-rotate", false],
		["span", 10],
		["level-off", 0.25],
		["min-win-rate", 0.2],
		["status", false], // print each opponent's progress and exit
		["reset", false], // forget the saved bonus history
	]);
	const focus = flags.opponent;
	const size = flags.size;

	if (!OPPONENTS.includes(focus)) {
		ns.tprint(`ERROR: unknown opponent "${focus}". Choose one of: ${OPPONENTS.join(", ")}`);
		return;
	}
	const illuminatiSize = flags["illuminati-size"] || size;
	if (![5, 7, 9, 13].includes(size) || ![5, 7, 9, 13].includes(illuminatiSize)) {
		ns.tprint(`ERROR: board size must be 5, 7, 9 or 13`);
		return;
	}

	const settings = { span: flags.span, levelOff: flags["level-off"], minWinRate: flags["min-win-rate"] };
	const order = flags["no-rotate"] ? [focus] : [focus, ...ROTATION.filter((name) => name !== focus)];
	const data = flags.reset ? {} : loadData(ns);

	if (flags.status) {
		for (const name of order) ns.tprint(describe(ns, name, data, settings));
		return;
	}

	const sizeFor = (name) => (name === "Illuminati" ? illuminatiSize : size);
	ns.print(`=== IPvGO bot: focus ${focus} on ${size}x${size}${flags["no-rotate"] ? " (no rotation)" : ""} ===`);
	for (const name of order) ns.print(describe(ns, name, data, settings));

	let played = 0;
	let current = null;
	while (flags.games === 0 || played < flags.games) {
		// A game already in progress is always finished first (a reset mid-game costs the win streak).
		const inProgress = ns.go.getCurrentPlayer() !== "None" ? ns.go.getOpponent() : null;
		const resuming = inProgress !== null && order.includes(inProgress);
		const opponent = resuming ? inProgress : pickOpponent(order, data, settings);

		if (opponent !== current) {
			if (current !== null) ns.print(`Switching ${current} -> ${opponent}: ${reasonFor(current, data, settings)}`);
			current = opponent;
		}

		const before = bonusOf(ns, opponent);
		if (!resuming) {
			ns.go.resetBoardState(opponent, sizeFor(opponent));
		} else {
			ns.print(`Resuming game in progress vs ${opponent}`);
			if (ns.go.getCurrentPlayer() === "White") await ns.go.opponentNextTurn(false);
		}

		await playGame(ns, flags.debug, flags.think);
		played++;

		const state = ns.go.getGameState();
		const won = state.blackScore > state.whiteScore;
		const stats = ns.go.analysis.getStats()[opponent];
		const after = stats?.bonusPercent ?? 0;
		record(ns, data, opponent, after - before, won, after, settings.span);

		const entry = data[opponent];
		const recent = recentGain(entry, settings.span);
		ns.print(`${won ? "WIN " : "LOSS"} vs ${opponent} ${state.blackScore} - ${state.whiteScore} | ` +
			`${stats?.wins ?? 0}W ${stats?.losses ?? 0}L, streak ${stats?.winStreak ?? 0}, ` +
			`bonus ${ns.format.number(after, 3)}% (+${ns.format.number(after - before, 4)}), ` +
			`avg gain ${recent === null ? "n/a" : ns.format.number(recent, 4)} / peak ${ns.format.number(entry.peak, 4)}`);

		await ns.sleep(200);
	}
}

// First opponent in priority order that is still worth playing; the focus once all have levelled off.
function pickOpponent(order, data, settings) {
	return order.find((name) => progressOf(data[name], settings) === "climbing") ?? order[0];
}

// "climbing" while still worth playing, "levelled" once gains dropped off, "losing" if we rarely win.
function progressOf(entry, settings) {
	if (!entry || entry.gains.length < settings.span * 2) return "climbing";
	const results = entry.wins.slice(-settings.span);
	if (results.filter(Boolean).length / results.length < settings.minWinRate) return "losing";
	const recent = recentGain(entry, settings.span);
	return recent < entry.peak * settings.levelOff ? "levelled" : "climbing";
}

function reasonFor(name, data, settings) {
	const entry = data[name];
	const result = progressOf(entry, settings);
	if (result === "losing") return `win rate under ${settings.minWinRate * 100}% over the last ${settings.span} games`;
	if (result === "levelled") return `bonus gain per game fell to ${(recentGain(entry, settings.span) / entry.peak * 100).toFixed(0)}% of its peak`;
	return "resumed a game in progress";
}

function describe(ns, name, data, settings) {
	const entry = data[name];
	if (!entry) return `  ${name}: no games recorded yet`;
	const recent = recentGain(entry, settings.span);
	return `  ${name}: ${progressOf(entry, settings)}, bonus ${ns.format.number(entry.bonus, 3)}%, ` +
		`${entry.games} games recorded, avg gain ${recent === null ? "n/a" : ns.format.number(recent, 4)} ` +
		`(peak ${ns.format.number(entry.peak, 4)})`;
}

// Average bonusPercent gain per game over the last `span` games, or null with fewer games.
function recentGain(entry, span) {
	if (!entry || entry.gains.length < span) return null;
	const last = entry.gains.slice(-span);
	return last.reduce((sum, gain) => sum + gain, 0) / span;
}

function record(ns, data, name, gain, won, bonus, span) {
	const entry = data[name] ??= { gains: [], wins: [], peak: 0, games: 0, bonus: 0 };
	entry.gains.push(Math.max(0, gain));
	entry.wins.push(won);
	entry.games++;
	entry.bonus = bonus;
	if (entry.gains.length > HISTORY) entry.gains.shift();
	if (entry.wins.length > HISTORY) entry.wins.shift();
	const recent = recentGain(entry, span);
	if (recent !== null) entry.peak = Math.max(entry.peak, recent);
	ns.write(DATA_FILE, JSON.stringify(data), "w");
}

function bonusOf(ns, name) {
	return ns.go.analysis.getStats()[name]?.bonusPercent ?? 0;
}

function loadData(ns) {
	let data = {};
	try {
		data = JSON.parse(ns.read(DATA_FILE) || "{}");
	} catch {
		data = {};
	}
	// A bonus lower than the one we saved means a new BitNode wiped Go progress: start that opponent over.
	const stats = ns.go.analysis.getStats();
	for (const name of Object.keys(data)) {
		if ((stats[name]?.bonusPercent ?? 0) + 1e-9 < data[name].bonus) delete data[name];
	}
	return data;
}

// Play until the game ends. We are always black ("X") against an AI faction.
async function playGame(ns, debug, think) {
	while (ns.go.getCurrentPlayer() === "Black") {
		const board = ns.go.getBoardState();
		const state = ns.go.getGameState();
		const behind = state.blackScore <= state.whiteScore;
		const opponentPassed = state.previousMove === null && ns.go.getMoveHistory().length > 0;

		// The opponent passed and we are ahead on the real score: pass to end the game and take the win.
		if (opponentPassed && !behind) {
			ns.print(`Opponent passed, we lead ${state.blackScore} - ${state.whiteScore}. Passing to win.`);
			const result = await ns.go.passTurn();
			if (result.type === "gameOver") return;
			continue;
		}

		const move = await chooseMove(board, "X", ns.go.getMoveHistory(), behind, () => ns.sleep(0),
			{ komi: state.komi, opponentPassed, timeMs: think });

		if (debug && move.type === "move") {
			ns.go.analysis.highlightPoint(move.x, move.y, "hack", `${Math.round(move.value * 100)}%`);
		}

		let result;
		if (move.type === "move") {
			try {
				result = await ns.go.makeMove(move.x, move.y);
			} catch (e) {
				// Should not happen since chooseMove checks legality, but never get stuck on it.
				ns.print(`WARN: move [${move.x},${move.y}] rejected (${e}). Passing.`);
				result = await ns.go.passTurn();
			}
		} else {
			ns.print(`Passing (estimated win chance ${Math.round(move.passValue * 100)}%).`);
			result = await ns.go.passTurn();
		}

		if (result.type === "gameOver") return;
	}
}
