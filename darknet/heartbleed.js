// Design: docs/darknet.md
// Reads a neighbour's logs (heartbleed) and turns them into password knowledge, before any guessing. The logs hold other
// logins' attempts on that server: a code-200 entry is a password that worked, a code-401 entry one that did not (with the
// reply data, for Mastermind servers), and some models write the passcode into a message. Ported from the other player's
// lib-auth.js, which has run in game.
const LOGS_TO_READ = 12; // peek: the lines stay on the server

/**
 * What the neighbour's logs say, or the empty result when they can't be read.
 *   winners   passwords that logged in (try first)
 *   leaked    passcodes written into a log message or data ("passcode: 3739", "<host>:3739")
 *   wrong     passwords known to be wrong (don't spend an attempt on them)
 *   observed  Mastermind replies from earlier wrong attempts: { guess, exact, misplaced }
 * Costs 0.6GB (heartbleed); needs a direct connection to `host`, which the crawler has while it cracks a neighbour.
 * @param {NS} ns
 */
export async function readLogs(ns, host) {
	const result = { winners: [], leaked: [], wrong: new Set(), observed: [] };
	let reply;
	try {
		reply = await ns.dnet.heartbleed(host, { peek: true, logsToCapture: LOGS_TO_READ });
	} catch {
		return result;
	}
	for (const entry of parseLogs(reply)) {
		const attempted = entry.passwordAttempted;
		if (entry.code === 200 && attempted !== undefined) result.winners.push(String(attempted));
		if (entry.code === 401 && attempted !== undefined) {
			result.wrong.add(String(attempted));
			const match = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(String(entry.data ?? ""));
			if (match) result.observed.push({ guess: String(attempted), exact: Number(match[1]), misplaced: Number(match[2]) });
		}
		const fromMessage = /passcode:\s*([A-Za-z0-9]+)/i.exec(String(entry.message ?? ""))?.[1];
		if (fromMessage) result.leaked.push(fromMessage);
		const data = String(entry.data ?? "");
		const at = data.indexOf(host + ":");
		const fromData = at >= 0 ? /^[A-Za-z0-9]+/.exec(data.slice(at + host.length + 1))?.[0] : null;
		if (fromData) result.leaked.push(fromData);
	}
	return result;
}

/** Normalises heartbleed output into [{ message, passwordAttempted, code, data }]. */
function parseLogs(reply) {
	const raw = Array.isArray(reply) ? reply : (reply?.logs ?? []);
	return raw.map((line) => {
		if (typeof line !== "string") return line ?? {};
		try { return JSON.parse(line) ?? {}; } catch { return { message: line }; }
	});
}
