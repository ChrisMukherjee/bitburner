// Design: docs/darknet.md
// @ts-check
// Reads a neighbour's logs (heartbleed) and turns them into password knowledge, before any guessing. The logs hold other
// logins' attempts on that server: a code-200 entry is a password that worked, a code-401 entry one that did not (with the
// reply data, for Mastermind servers), and some models write the passcode into a message. Ported from the other player's
// lib-auth.js, which has run in game.
const LOGS_TO_READ = 12; // peek: the lines stay on the server
export const MAX_LOGS = 200; // the game keeps at most this many lines per server

/**
 * Mastermind reply (DeepGreen) as { exact, misplaced }, or undefined. The game sends data "1,2" and the message
 * "Hint: 1 symbol is match exactly,  and 2 symbols match but are in the wrong place."; we accept the data as a
 * string "a,b" or a pair [a, b], and fall back to the message in case the data is missing.
 * @param {any} data
 * @param {any} [message]
 */
export function parseMastermindReply(data, message) {
	if (Array.isArray(data) && data.length === 2 && data.every((value) => Number.isInteger(Number(value)))) {
		return { exact: Number(data[0]), misplaced: Number(data[1]) };
	}
	const pair = String(data ?? "").match(/^\s*(\d+)\s*,\s*(\d+)\s*$/);
	if (pair) return { exact: Number(pair[1]), misplaced: Number(pair[2]) };
	const text = String(message ?? "");
	const exact = text.match(/(\d+)\s+symbols?\s+(?:is|are)\s+match\s+exactly/i);
	const misplaced = text.match(/(\d+)\s+symbols?\s+match\s+but/i);
	return exact && misplaced ? { exact: Number(exact[1]), misplaced: Number(misplaced[1]) } : undefined;
}

// The "I can see a 8 and a 6" noise lines every darknet server writes into its log: two characters that really are
// in its password (bitburner-src DarkNet/models/packetSniffing.ts, getRandomCharsInPassword).
const CLUE_PATTERNS = [
	/definitely a (\S) and a (\S)\.\.\./i, /I can see a (\S) and a (\S)\./i, /I must use (\S) & (\S)!/i,
	/Did it have a (\S) and a (\S)\?/i, /Note to self: (\S) and (\S) are important\./i, /I think (\S) with (\S) is key\./i,
	/I need to remember (\S) 'n (\S)\./i, /Theres a (\S), and maybe a (\S)\.\.\./i,
];

/** The two characters a clue line names ([a, b]; they may be equal, meaning two of that character), or undefined. */
export function parseClue(message) {
	const text = String(message ?? "");
	for (const pattern of CLUE_PATTERNS) {
		const match = text.match(pattern);
		if (match) return [match[1], match[2]];
	}
	return undefined;
}

/**
 * What the neighbour's logs say, or the empty result when they can't be read.
 *   winners   passwords that logged in (try first)
 *   leaked    passcodes written into a log message or data ("passcode: 3739", "<host>:3739")
 *   wrong     passwords known to be wrong (don't spend an attempt on them)
 *   observed  Mastermind replies from earlier wrong attempts: { guess, exact, misplaced }
 *   clues     character pairs the server's own noise lines say are in its password: [a, b]
 * Costs 0.6GB (heartbleed); needs a direct connection to `host`, which the crawler has while it cracks a neighbour.
 * @param {NS} ns
 */
export async function readLogs(ns, host, lines = LOGS_TO_READ) {
	const result = { winners: [], leaked: [], wrong: new Set(), observed: [], clues: [] };
	let reply;
	try {
		reply = await ns.dnet.heartbleed(host, { peek: true, logsToCapture: lines });
	} catch {
		return result;
	}
	for (const entry of parseLogs(reply)) {
		const attempted = entry.passwordAttempted;
		if (entry.code === 200 && attempted !== undefined) result.winners.push(String(attempted));
		if (entry.code === 401 && attempted !== undefined) {
			result.wrong.add(String(attempted));
			const reply = parseMastermindReply(entry.data, entry.message);
			if (reply) result.observed.push({ guess: String(attempted), ...reply });
		}
		const clue = parseClue(entry.message);
		if (clue) result.clues.push(clue);
		const fromMessage = String(entry.message ?? "").match(/passcode:\s*([A-Za-z0-9]+)/i)?.[1];
		if (fromMessage) result.leaked.push(fromMessage);
		const data = String(entry.data ?? "");
		const at = data.indexOf(host + ":");
		const fromData = at >= 0 ? data.slice(at + host.length + 1).match(/^[A-Za-z0-9]+/)?.[0] : null;
		if (fromData) result.leaked.push(fromData);
	}
	return result;
}

/** Normalises heartbleed output into [{ message, passwordAttempted, code, data }]. */
function parseLogs(reply) {
	const raw = Array.isArray(reply) ? reply : (reply?.logs ?? []);
	return raw.map((line) => {
		let entry;
		if (typeof line !== "string") entry = line ?? {};
		else { try { entry = JSON.parse(line) ?? {}; } catch { entry = { message: line }; } }
		// The game logs an attempt as { message: { code, message, data, passwordAttempted }, pid }: lift it up.
		return entry.message && typeof entry.message === "object" ? { ...entry.message, pid: entry.pid } : entry;
	});
}
