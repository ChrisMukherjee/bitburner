import { loadVault, recordKey } from 'lib-intel.js';

// Factory-default passwords for "never changed it" models. Add more as you find them.
const DEFAULT_PASSWORDS = ["admin", "password", "0000", "1234", "12345", "123456", "root", "guest",
    "default", "letmein", "qwerty", "toor", "changeme", "administrator", "user", "login",
    "1111", "4321", "9999", "00000", "11111", "54321", "99999", "000000", "111111", "654321"];

const SOLVERS = {
    // ...your existing solvers unchanged...
    // Hint: "I never changed the password" -> factory default
    "FreshInstall_1.0": d => DEFAULT_PASSWORDS,
    // Data "13,113": the number 113 written in base 13 -> its base-10 value (185). Also tries the reverse reading.
    "OctantVoxel": d => {
        const [base, num] = String(d.data).split(",").map(s => s.trim());
        const b = Number(base);
        return [String(parseInt(num, b)), Number(num).toString(b)];
    },
    // "Type the numbers to prove you are human": data "4\\6*7" -> the digits in order, "467"
    "CloudBlare(tm)": d => [String(d.data).replace(/\D/g, "")],
    // "Did I set a code?" with length 0: no password at all
    "ZeroLogon": d => [""],
    // "Remember to use 556": the password is written in the hint; try every word in it
    "DeskMemo_3.1": d => String(d.passwordHint).match(/[A-Za-z0-9]+/g) || [],
    // "The value of the number 'CCCXXIII'": a Roman numeral -> 323
    "BellaCuore": d => [String(romanToNumber(String(d.data).trim()))],
};

// Factori-Os: the password is a product of primes. Each wrong guess replies data "true"/"false" = whether the password
// is divisible by what we sent, so we build it one prime factor at a time. Ported from ChrisMukherjee/bitburner darknet/feedback-solvers.js.
const SMALL_PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97];
const LARGE_PRIMES = [
    1069, 1409, 1471, 1567, 1597, 1601, 1697, 1747, 1801, 1889, 1979, 1999, 2063, 2207, 2371, 2503, 2539, 2693, 2741,
    2753, 2801, 2819, 2837, 2909, 2939, 3169, 3389, 3571, 3761, 3881, 4217, 4289, 4547, 4729, 4789, 4877, 4943, 4951,
    4957, 5393, 5417, 5419, 5441, 5519, 5527, 5647, 5779, 5881, 6007, 6089, 6133, 6389, 6451, 6469, 6547, 6661, 6719,
    6841, 7103, 7549, 7559, 7573, 7691, 7753, 7867, 8053, 8081, 8221, 8329, 8599, 8677, 8761, 8839, 8963, 9103, 9199,
    9343, 9467, 9551, 9601, 9739, 9749, 9859,
];

// NIL: probe once per run so the real reply format shows up in the terminal (the guessed format was wrong)
let nilProbed = false;

// Interactive solvers switched off for now. NIL never gets a "yes" back, so its sweep just wastes
// ~2 minutes a round; remove it from this set once the solver is fixed
const DISABLED_SOLVERS = new Set(["NIL"]);

/* Models that need back-and-forth with the server (reading each attempt's feedback) instead
 * of a fixed list of guesses. Each gets ({ ns, hostname, details, failed, tryAll, priorObs })
 * and returns true on success, recording the key itself. */
const INTERACTIVE_SOLVERS = {
    // NIL -- per-position feedback. Each failed authenticate() returns data like
    //   "yes,yesn't,yesn't,yesn't,yesn't": one entry per digit, "yes" = that digit is correct in
    //   that position, anything else = wrong. So lock one position at a time: hold a working guess,
    //   sweep digits 0-9 at each unsolved position, and keep whatever the server marks "yes".
    "NIL": async ({ ns, hostname, details, failed }) => {
        const len = details.passwordLength;
        if (!len || details.passwordFormat !== "numeric") return false;
        const guess = Array(len).fill("0");       // current best guess
        const solved = Array(len).fill(false);    // positions the server has confirmed

        const tryGuess = async () => {
            const pwd = guess.join("");
            const res = await ns.dnet.authenticate(hostname, pwd);
            if (res.success) {
                ns.print(`[Auth Success] NIL on ${hostname}: "${pwd}"`);
                recordKey(ns, hostname, pwd);
                return true;
            }
            failed.add(pwd);
            // Mark every position the server says is already correct (so we never disturb it)
            String(res.data ?? "").split(",").forEach((m, i) => {
                if (m.trim().toLowerCase() === "yes") solved[i] = true;
            });
            return false;
        };

        // Initial probe reads feedback for the all-zero guess (and catches a lucky all-zero password)
        if (await tryGuess()) return true;
        for (let pos = 0; pos < len; pos++) {
            if (solved[pos]) continue;
            for (let d = 0; d <= 9; d++) {
                guess[pos] = String(d);
                if (await tryGuess()) return true;
                if (solved[pos]) break;           // this digit was confirmed -> next position
            }
        }
        return false;
    },

    // Factori-Os -- divisibility feedback (see the constants above). A guess equal to the password simply succeeds.
    "Factori-Os": async ({ ns, hostname, failed }) => {
        // "later" replies (timeout, server moved) carry no divisibility data; stop instead of dropping a factor
        const tryValue = async (value) => {
            const res = await ns.dnet.authenticate(hostname, String(value));
            if (res.success) { recordKey(ns, hostname, String(value)); return "match"; }
            if (res.data !== "true" && res.data !== "false") return "later";
            failed.add(String(value));
            return res.data === "true" ? "divides" : "no";
        };
        let found = 1;
        const first = await tryValue(found);
        if (first === "match") { ns.print(`[Auth Success] Factori-Os on ${hostname}: "1"`); return true; }
        if (first === "later") return false;
        for (const prime of SMALL_PRIMES.concat(LARGE_PRIMES)) {
            while (true) {   // a prime can appear more than once
                const outcome = await tryValue(found * prime);
                if (outcome === "match") { ns.print(`[Auth Success] Factori-Os on ${hostname}: "${found * prime}"`); return true; }
                if (outcome === "later") return false;
                if (outcome !== "divides") break;
                found *= prime;
            }
        }
        return false;
    },

    // DeepGreen -- classic Mastermind. Each failed authenticate() returns data "exact,misplaced"
    //   (digits in the right place / right digit wrong place). Start with every numeric string of
    //   the right length and, after each guess, keep only the candidates that would have produced
    //   the same feedback. Seeded with any past attempts already in the heartbleed logs.
    "DeepGreen": async ({ ns, hostname, details, failed, priorObs }) => {
        const len = details.passwordLength;
        if (!len || details.passwordFormat !== "numeric" || len > 6) return false;
        let candidates = [];
        for (let n = 0, total = 10 ** len; n < total; n++) candidates.push(String(n).padStart(len, "0"));

        for (const o of (priorObs || [])) {
            candidates = candidates.filter(c => {
                const [e, m] = mastermindScore(o.guess, c);
                return e === o.exact && m === o.misplaced;
            });
        }

        while (candidates.length) {
            const guess = candidates[0];
            const res = await ns.dnet.authenticate(hostname, guess);
            if (res.success) {
                ns.print(`[Auth Success] DeepGreen on ${hostname}: "${guess}"`);
                recordKey(ns, hostname, guess);
                return true;
            }
            failed.add(guess);
            const [exact, misplaced] = String(res.data).split(",").map(Number);
            candidates = candidates.filter(c => {
                const [e, m] = mastermindScore(guess, c);
                return e === exact && m === misplaced;
            });
        }
        return false;
    },
};

/** Cracks a neighbour. Easy mode (default) tries every quick source and skips the slow
 * interactive solvers; hard mode runs only those slow solvers (NIL, DeepGreen), so the scout
 * can crack all the easy neighbours first and get to the hard ones last.
 * @param {NS} ns
 * @param {string} hostname
 * @param {boolean} [hard]
 */
export async function serverSolver(ns, hostname, hard = false) {
    const details = ns.dnet.getServerDetails(hostname);
    if (details.hasSession) return true;
    if (hard && details.modelId === "NIL" && DISABLED_SOLVERS.has("NIL") && !nilProbed && details.passwordLength) {
        // One cheap guess just to see what the server really answers; the reply goes to the terminal once per run
        nilProbed = true;
        const probe = await ns.dnet.authenticate(hostname, "0".repeat(details.passwordLength));
        if (probe.success) { recordKey(ns, hostname, "0".repeat(details.passwordLength)); return true; }
        ns.tprint(`[NIL] sample reply on ${hostname} (length ${details.passwordLength}, ${details.passwordFormat}): data=${JSON.stringify(probe.data)} code=${probe.code} message=${JSON.stringify(probe.message)} hint=${JSON.stringify(details.passwordHint)}`);
        return false;
    }
    if (hard && (!INTERACTIVE_SOLVERS[details.modelId] || DISABLED_SOLVERS.has(details.modelId))) return false;

    // Passwords already known to be wrong, so no attempt is wasted on them twice
    const failed = new Set();

    // Tries each candidate that fits the server's length/format; saves the key on success
    const tryAll = async (candidates, source) => {
        for (const pwd of new Set(candidates.filter(c => c != null).map(String))) {
            if (failed.has(pwd) || !fitsFormat(pwd, details)) continue;
            if ((await ns.dnet.authenticate(hostname, pwd)).success) {
                ns.print(`[Auth Success] ${source} on ${hostname}: "${pwd}"`);
                recordKey(ns, hostname, pwd);
                return true;
            }
            failed.add(pwd);
        }
        return false;
    };

    // Priority 1: saved key for this server
    let vault = loadVault(ns);
    if (hostname in vault.servers && await tryAll([vault.servers[hostname]], "Vault key")) return true;

    // Priority 2: heartbleed logs. code 200 = someone's successful login, code 401 = known-wrong password
    let priorObs = [];
    try {
        const logs = parseLogs(await ns.dnet.heartbleed(hostname));
        const winners = logs.filter(l => l.code === 200).map(l => l.passwordAttempted);
        logs.filter(l => l.code === 401).forEach(l => failed.add(String(l.passwordAttempted)));
        // Mastermind-style past attempts ("exact,misplaced" in data) feed the DeepGreen solver
        priorObs = logs
            .filter(l => l.code === 401 && /^\s*\d+\s*,\s*\d+\s*$/.test(String(l.data ?? "")))
            .map(l => {
                const [exact, misplaced] = String(l.data).split(",").map(Number);
                return { guess: String(l.passwordAttempted), exact, misplaced };
            });
        if (await tryAll(winners, "Heartbleed success log")) return true;

        // Some models (e.g. OpenWebAccessPoint) leak the passcode: "passcode: 3739" in a message,
        // or "<hostname>:3739" inside the log data
        const logged = [];
        for (const l of logs) {
            const fromMessage = String(l.message ?? "").match(/passcode:\s*([A-Za-z0-9]+)/i)?.[1];
            if (fromMessage) logged.push(fromMessage);
            const data = String(l.data ?? "");
            const at = data.indexOf(hostname + ":");
            const fromData = at >= 0 ? data.slice(at + hostname.length + 1).match(/^[A-Za-z0-9]+/)?.[0] : null;
            if (fromData) logged.push(fromData);
        }
        if (await tryAll(logged, "Logged passcode")) return true;
    } catch (e) {
        ns.print(`[Heartbleed error] ${hostname}: ${e}`);
    }

    // Priority 3 (hard pass only): interactive solvers that need many slow guesses
    const interactive = INTERACTIVE_SOLVERS[details.modelId];
    if (hard) {
        if (interactive && await interactive({ ns, hostname, details, failed, tryAll, priorObs })) return true;
        if (interactive) ns.print(`[Auth Failed] ${details.modelId} solver on ${hostname}`);
        return false;
    }

    // Priority 3: plain generator for this model
    const solver = SOLVERS[details.modelId];
    if (solver) {
        if (await tryAll(solver(details), details.modelId)) return true;
    } else if (!interactive) {
        ns.print(`[Unknown model] ${details.modelId} on ${hostname} | Hint: "${details.passwordHint}" | Data: "${details.data}" | Format: ${details.passwordFormat} x${details.passwordLength}`);
    }

    // Priority 4: dictionary + defaults, filtered by length/format
    if (await tryAll([...vault.dictionary, ...DEFAULT_PASSWORDS], "Dictionary")) return true;
    if (interactive) return false; // the hard pass comes back for it

    ns.print(`[Auth Failed] ${hostname} | Model: ${details.modelId} | Hint: "${details.passwordHint}" | Data: "${details.data}" | Format: ${details.passwordFormat} x${details.passwordLength}`);
    return false;
}

/** Mastermind scoring: [exact, misplaced] of guess against code (digit strings, repeats allowed) */
function mastermindScore(guess, code) {
    let exact = 0;
    const gCount = {}, cCount = {};
    for (let i = 0; i < guess.length; i++) {
        if (guess[i] === code[i]) exact++;
        else {
            gCount[guess[i]] = (gCount[guess[i]] || 0) + 1;
            cCount[code[i]] = (cCount[code[i]] || 0) + 1;
        }
    }
    let misplaced = 0;
    for (const d in gCount) misplaced += Math.min(gCount[d], cCount[d] || 0);
    return [exact, misplaced];
}

/** Converts a Roman numeral like "CCCXXIII" to a number (323). */
function romanToNumber(roman) {
    const values = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
    let total = 0;
    for (let i = 0; i < roman.length; i++) {
        const v = values[roman[i].toUpperCase()] ?? 0;
        const next = values[roman[i + 1]?.toUpperCase()] ?? 0;
        total += v < next ? -v : v;
    }
    return total;
}

/** True if pwd matches the server's advertised length and character format */
function fitsFormat(pwd, d) {
    if (d.passwordLength && pwd.length !== d.passwordLength) return false;
    if (pwd.length > 32) return false;
    switch (d.passwordFormat) {
        case "numeric": return /^\d*$/.test(pwd);
        case "alphabetic": return /^[a-z]*$/i.test(pwd);
        case "alphanumeric": return /^[a-z0-9]*$/i.test(pwd);
        default: return true;
    }
}

/** Normalises heartbleed output into [{ message, passwordAttempted, code }] */
function parseLogs(hbResult) {
    const raw = Array.isArray(hbResult) ? hbResult : (hbResult?.logs ?? []);
    return raw.map(l => {
        if (typeof l !== "string") return l;
        try { return JSON.parse(l); } catch { return { message: l }; }
    });
}
