// A darknet server that answers like the game does (bitburner-src v3.0.1): ns.dnet.authenticate resolves a wrong password with
// only { success: false, code: 401, message: "Unauthorized" } (NetscriptFunctions/Darknet.ts returns the model's data for
// labyrinth servers only), and the model's reply ({ code, message, data, passwordAttempted }) is written to the front of the
// server's log (DarkNet/effects/authentication.ts getAuthResult -> logPasswordAttempt), where ns.dnet.heartbleed reads it
// as JSON strings, newest first.
//
//   const { ns, tried } = darknetServer("12345", (password, guess) => ({ message: "...", data: "..." }));
//
// `reply(password, guess)` is the model's answer to a wrong guess, copied from authentication.ts checkPassword.
import { fakeNs } from "./fake-ns.mjs";

/**
 * @param {string} password
 * @param {(password: string, guess: string) => { message?: string, data?: string }} reply
 * @param {{ noise?: () => string|undefined, files?: Record<string, string> }} [options] noise: a log line added before each reply
 */
export function darknetServer(password, reply, { noise, files } = {}) {
	const tried = [];
	const log = [];
	const ns = fakeNs({ files, overrides: { dnet: {
		authenticate: async (_host, guess) => {
			tried.push(guess);
			if (guess === password) {
				log.unshift(JSON.stringify({ code: 200, message: "Success", passwordAttempted: guess }));
				return { success: true, code: 200, message: "Success" };
			}
			const extra = noise?.();
			if (extra !== undefined) log.unshift(extra);
			log.unshift(JSON.stringify({ code: 401, ...reply(password, guess), passwordAttempted: guess }));
			return { success: false, code: 401, message: "Unauthorized" };
		},
		heartbleed: async (_host, options = {}) => ({ success: true, code: 200, message: "Success", logs: log.slice(0, options.logsToCapture ?? 1) }),
	} } });
	return { ns, tried, log };
}
