// Design: docs/bladeburner.md
// Pure models (no ns calls, 0GB) used by bladeburner/node-eta.js to estimate how long each way out of a BitNode takes.
// Both models are multi-run: augmentations stay installed across resets, income and multipliers compound, and every
// reset restarts skill exp. Game constants come from bitburner-src v3.0.1 (Bladeburner action table, skill formula,
// augmentation price step). Every projection reports its own sanity check: callers print a number only when the model
// reproduces what was measured. Ported unchanged from the other player's node-eta.js (renamed identifiers only: the
// static RAM check charges names like `rm`, `hack` and `share`).

const AUG_STEP = 1.9;                       // price multiplier per augmentation bought in one run, without Source-File 11 (cfg.augStep)
const GYM_EXP_PER_SECOND = 5;               // per stat, Powerhouse Gym, BitNode 4 (measured)
const skillAt = (exp, mult) => Math.max(1, mult * (32 * Math.log(exp + 534.5) - 200));   // game formula
const expFor = (level, mult) => Math.max(0, Math.exp((level / mult + 200) / 32) - 534.5);

/**
 * The level multiplier the game applied beyond `mult`, read back from a skill's level and exp: level / (mult x formula). The game
 * multiplies the player's own mults by the BitNode's level multiplier (HackingLevelMultiplier 0.35 in BitNode 6, the combat ones in
 * others), which `player.mults` leaves out; without this the models would see levels the player can't reach. Needs no Source-File 5.
 * 1 when the level is too low to read it through the game's rounding down, or the reading makes no sense.
 */
function levelFactor(level, exp, mult) {
    if (!(level >= 50) || !(exp > 0) || !(mult > 0)) return 1;
    const factor = level / (mult * (32 * Math.log(exp + 534.5) - 200));
    return Number.isFinite(factor) && factor > 0.01 && factor < 100 ? factor : 1;
}

/** The multipliers the route models use: the player's own mults times the level multiplier the game applies on top (levelFactor). */
function modelMults(player) {
    const own = (key) => player.mults?.[key] || 1;
    const effective = (key) => own(key) * levelFactor(player.skills?.[key], player.exp?.[key], own(key));
    return { hacking: effective("hacking"), combat: ["strength", "defense", "dexterity", "agility"].map(effective) };
}

const STATS = ["hacking", "strength", "defense", "dexterity", "agility", "charisma", "intelligence"];
// [type, name, baseDifficulty, difficultyFac, rewardFac, rankGain, avg count growth per 480 s, weights[STATS], decays[STATS], isContract]
const ACTIONS = [
    ["Contracts", "Tracking", 125, 1.02, 1.041, 0.3, 4.0, [0, 0.05, 0.05, 0.35, 0.35, 0.1, 0.05], [0, 0.91, 0.91, 0.91, 0.91, 0.9, 1.0], 1],
    ["Contracts", "Bounty Hunter", 250, 1.04, 1.085, 0.9, 4.0, [0, 0.15, 0.15, 0.25, 0.25, 0.1, 0.1], [0, 0.91, 0.91, 0.91, 0.91, 0.8, 0.9], 1],
    ["Contracts", "Retirement", 200, 1.03, 1.065, 0.6, 4.0, [0, 0.2, 0.2, 0.2, 0.2, 0.1, 0.1], [0, 0.91, 0.91, 0.91, 0.91, 0.8, 0.9], 1],
    ["Operations", "Investigation", 400, 1.03, 1.07, 2.2, 2.5, [0.25, 0.05, 0.05, 0.2, 0.1, 0.25, 0.1], [0.85, 0.9, 0.9, 0.9, 0.9, 0.7, 0.9], 0],
    ["Operations", "Undercover Operation", 500, 1.04, 1.09, 4.4, 2.5, [0.2, 0.05, 0.05, 0.2, 0.2, 0.2, 0.1], [0.8, 0.9, 0.9, 0.9, 0.9, 0.7, 0.9], 0],
    ["Operations", "Sting Operation", 650, 1.04, 1.095, 5.5, 2.15, [0.25, 0.05, 0.05, 0.25, 0.1, 0.2, 0.1], [0.8, 0.85, 0.85, 0.85, 0.85, 0.7, 0.9], 0],
    ["Operations", "Raid", 800, 1.045, 1.1, 55, 2.1, [0.1, 0.2, 0.2, 0.2, 0.2, 0, 0.1], [0.7, 0.8, 0.8, 0.8, 0.8, 0, 0.9], 0],
    ["Operations", "Stealth Retirement Operation", 1000, 1.05, 1.11, 22, 1.05, [0.1, 0.1, 0.1, 0.3, 0.3, 0, 0.1], [0.7, 0.8, 0.8, 0.8, 0.8, 0, 0.9], 0],
    ["Operations", "Assassination", 1500, 1.06, 1.14, 44, 1.05, [0.1, 0.1, 0.1, 0.3, 0.3, 0, 0.1], [0.6, 0.8, 0.8, 0.8, 0.8, 0, 0.8], 0],
].map(([type, name, base, dfac, rfac, rank, growth, w, dc, contract]) => ({ type, name, base, dfac, rfac, rank, growth, w, dc, contract: !!contract }));
const BY_NAME = new Map(ACTIONS.map(a => [a.name, a]));

const competence = (a, lv) => STATS.reduce((t, s, i) => t + a.w[i] * Math.pow(Math.max(1, lv[s] ?? 1), a.dc[i]), 0);
const timeFactor = (lv) => 0.5 * (Math.pow(lv.agility, 0.04) + Math.pow(lv.dexterity, 0.035) + lv.agility / 1e4 + lv.dexterity / 1e4);

/**
 * Bladeburner rank model. `rows` are the live readings written by bb-pass.js (bb-actions.json): per action the chance, level, count,
 * seconds and rank gain, plus `lv` = the skill levels at that moment. The chance of an action at other skill levels / action levels is
 * scaled from the live reading with the game's own formula (competence = sum of weight x level^decay; difficulty = base x fac^(level-1)),
 * so everything not modelled (skill points, city population, stamina) stays as measured.
 */
function makeBladeburner(rows) {
    const acts = [];
    for (const r of rows) {
        const a = BY_NAME.get(r.name); if (!a) continue;
        const lvl = Math.max(1, r.level || 1), maxLevel = Math.max(lvl, r.maxLevel || lvl);
        const need = (m) => Math.ceil(0.5 * m * (2 * (a.contract ? 3 : 2.5) + m - 1));
        acts.push({ a, ref: r, level: maxLevel, maxLevel, succ: need(maxLevel - 1), count: Math.max(0, r.count ?? 1), cap: a.contract ? 150 : 100,
            compRef: competence(a, r.lv), tfRef: timeFactor(r.lv), need });
    }
    return acts;
}
const bladeburnerClone = (acts) => acts.map(x => ({ ...x }));

function actionNow(x, lv) {
    const { a, ref } = x;
    const dRatio = Math.pow(a.dfac, x.level - Math.max(1, ref.level || 1));
    const chance = Math.min(1, ref.chance * (competence(a, lv) / x.compRef) / dRatio);
    const secs = Math.max(1, ref.secs * dRatio * timeFactor(ref.lv) / timeFactor(lv));
    const gain = ref.gain * Math.pow(a.rfac, x.level - Math.max(1, ref.level || 1));
    return { chance, secs, gain };
}

/** Advance the model `hours` at skill levels `lv`; policy as bb-pass.js: best chance x gain / seconds among actions with a safe-ish chance. */
function bladeburnerAdvance(acts, state, lv, hours, duty, minChance = 0.4, dt = 0.25) {
    for (let t = 0; t < hours - 1e-9; t += dt) {
        const h = Math.min(dt, hours - t);
        let best = null;
        for (const x of acts) {
            if (x.count < 1) continue;
            const n = actionNow(x, lv);
            if (n.chance < minChance) continue;
            const score = n.chance * n.gain / n.secs;
            if (!best || score > best.score) best = { x, n, score };
        }
        for (const x of acts) x.count = Math.min(x.cap, x.count + x.a.growth * h * 3600 / 480);
        if (!best) continue;
        const { x, n } = best;
        const attempts = Math.min(x.count, h * 3600 * duty / n.secs);
        x.count -= attempts;
        const wins = attempts * n.chance;
        x.succ += wins; state.rank += wins * n.gain;
        while (x.succ >= x.need(x.maxLevel)) { x.maxLevel++; x.level = x.maxLevel; }
    }
}

/** Best action's chance now (the live "run is worth it" figure), from the live rows rescaled to the current skill levels. */
function bestChanceNow(acts, lv) {
    let best = 0, name = null;
    for (const x of acts) { const n = actionNow(x, lv); if (n.chance > best) { best = n.chance; name = x.a.name; } }
    return { chance: best, name };
}

/** Rank per hour the model predicts at skill levels `lv` for `hours` of play (duty 1), used to calibrate against the measured rate. */
function predictRankPerHour(acts, lv, hours = 1, minChance = 0.4) {
    const c = bladeburnerClone(acts), st = { rank: 0 };
    bladeburnerAdvance(c, st, lv, hours, 1, minChance);
    return st.rank / hours;
}

/**
 * Multi-run projection. goal "combat": buy combat augs each run, retrain the combat stats in the gym, then play Bladeburner until rank 400000.
 * goal "hacking": buy hacking augs each run until Daedalus/The Red Pill and then 9000 hacking within one run are reachable.
 * Scenarios differ only in how income and exp rate grow with the hacking multiplier (low: not at all; high: income x mult, exp x sqrt(mult)).
 *
 * Faction rep (v3.0.1 formulas): hacking work gives 5 cycles/s x (hacking level / 975) x faction_rep mult x BitNode rep mult per second, so it
 * grows with the level reached in the run. Rep persists across installs per faction. An augmentation needs rep with a faction that sells it. Once a
 * faction's favour is 150 (cumulative rep 25000 x (1.02^150 - 1), about 450k) rep can also be bought: $1e6 per rep / (faction_rep x BitNode mult).
 *
 * cfg: { augs: [{ name, price, rep, f: [factions], h, e, cs[4] }], nf, mult: {hacking, hackExp, combat[4], combatExp}, income, expRate, installed,
 *        runHours, overheadHours, rep: { facMult, bn, timeShare }, scenario: {income, exp}, maxRuns, bb: { acts, rank, lv, duty, gymHours } | null,
 *        hackRoute: { required, daedalusAugs, daedalusMoney, daedalusHack, rpRep, rpPrice, rpHeld, startStage },
 *        augStep: the price step per augmentation bought (AUG_STEP when left out; less with Source-File 11, utils/aug-price.js),
 *        gates: { faction: inviteGate(...) } for the factions not joined yet (their augs count only once a run meets the gate),
 *        combatLevel: today's lowest combat stat, for the gates }
 */
/**
 * A faction's invite requirements (getFactionInviteRequirements) as the levels the route models can check: a list of alternatives
 * { hacking, combat, augs } (combat = the highest of the four combat stats asked for), any one of which opens the faction.
 * Daedalus is hacking 2500 OR every combat stat 1500, so it has two. Everything else (money, karma, backdoors, companies, cities)
 * is left out: the models assume the player meets it, so they stay optimistic there.
 */
function inviteGate(requirements) {
    const none = { hacking: 0, combat: 0, augs: 0 };
    const both = (lists) => lists.reduce((acc, alts) => acc.flatMap((x) => alts.map((y) => ({
        hacking: Math.max(x.hacking, y.hacking), combat: Math.max(x.combat, y.combat), augs: Math.max(x.augs, y.augs) }))).slice(0, 16), [none]);
    const gate = (req) => {
        if (!req || typeof req !== "object") return [none];
        if (req.type === "skills") {
            const sk = req.skills ?? {};
            return [{ ...none, hacking: sk.hacking ?? 0, combat: Math.max(0, ...["strength", "defense", "dexterity", "agility"].map((k) => sk[k] ?? 0)) }];
        }
        if (req.type === "numAugmentations") return [{ ...none, augs: req.numAugmentations ?? 0 }];
        if (req.type === "someCondition") return (req.conditions ?? []).flatMap(gate).slice(0, 16);
        if (req.type === "everyCondition") return both((req.conditions ?? []).map(gate));
        return [none];
    };
    const alts = both((Array.isArray(requirements) ? requirements : []).map(gate));
    return alts.length ? alts : [none];
}
/** True when `levels` ({ hacking, combat, installed }) meet one of the gate's alternatives (no gate = open). */
function gateOpen(alts, levels) {
    if (!Array.isArray(alts) || alts.length === 0) return true;
    return alts.some((g) => levels.hacking >= g.hacking && levels.combat >= g.combat && levels.installed >= g.augs);
}

const DONATE_REP = 25000 * (Math.pow(1.02, 150) - 1);
function projectRoute(goal, cfg) {
    const maxRuns = cfg.maxRuns ?? 60, T = cfg.runHours, over = cfg.overheadHours ?? 0.25, step = cfg.augStep ?? AUG_STEP;
    const m = { hacking: cfg.mult.hacking, hackExp: cfg.mult.hackExp, combat: [...cfg.mult.combat] };
    const mult0 = { ...m };
    const repMult = (cfg.rep?.facMult ?? 1) * (cfg.rep?.bn ?? 1), repShare = cfg.rep?.timeShare ?? 0.7;
    const pool = cfg.augs.map(a => ({ ...a, f: a.f && a.f.length ? a.f : ["?"] }));
    const Rf = {};                                   // faction -> cumulative rep (persists across installs)
    // Factions the player can join (cfg.gates: invite gates of the factions not joined yet, see inviteGate); once open, open for good
    const gates = cfg.gates ?? {}, opened = new Set();
    const open = (f) => !gates[f] || opened.has(f);
    const sellers = (a) => a.f.filter(open);
    const R = (f) => Rf[f] ?? 0, maxR = (a) => Math.max(0, ...sellers(a).map(R)), allMax = () => Math.max(0, ...Object.values(Rf));
    const topSeller = (a) => sellers(a).reduce((x, y) => R(y) > R(x) ? y : x, sellers(a)[0]);
    let hours = 0, installed = cfg.installed ?? 0, state = { rank: cfg.bb?.rank ?? 0 }, acts = cfg.bb ? bladeburnerClone(cfg.bb.acts) : null;
    let nfLevel = 0;
    let stage = cfg.hackRoute?.startStage ?? 0;           // hacking: 0 = before Daedalus, 1 = Red Pill rep/price, 2 = Red Pill installed
    const log = [];
    const value = (a) => goal === "combat" ? a.cs.reduce((t, v) => t + Math.log(Math.max(1, v)), 0) / 4 : Math.log(Math.max(1, a.h)) + 0.1 * Math.log(Math.max(1, a.e));
    for (let k = 1; k <= maxRuns; k++) {
        const income = cfg.income * Math.pow(Math.max(1, m.hacking / mult0.hacking), cfg.scenario.income);
        const budget = income * T * 3600 * 0.5;       // income ramps up during a run: about half of T x income is spendable
        const rate = cfg.expRate * (m.hackExp / mult0.hackExp) * Math.pow(Math.max(1, m.hacking / mult0.hacking), cfg.scenario.exp);   // hacking exp/s this run
        const levelAt = (hrs) => skillAt(rate * hrs * 3600, m.hacking);
        // Invites this run: the hacking level the run reaches, the combat level (today's, or the gym's on the Bladeburner route when higher)
        const gymExp = cfg.bb ? GYM_EXP_PER_SECOND * 3600 * (cfg.bb.gymHours / 4) * (cfg.mult.combatExp ?? 1) : 0;
        const combatLevel = Math.max(cfg.combatLevel ?? 1, cfg.bb ? Math.min(...m.combat.map((v) => skillAt(gymExp, v))) : 0);
        for (const f of Object.keys(gates)) if (!opened.has(f) && gateOpen(gates[f], { hacking: levelAt(T), combat: combatLevel, installed })) opened.add(f);
        // Rep earned this run: hacking work at the level reached a quarter of the way into the run
        const repRun = 5 * (levelAt(T * 0.25) / 975) * repMult * T * 3600 * repShare;
        let repLeft = repRun;
        if (goal === "hacking" && stage === 1) { Rf.Daedalus = R("Daedalus") + repRun; repLeft = 0; }
        for (let guard = 0; guard < 80 && repLeft > 1; guard++) {
            let best = null;
            for (const a of pool) {
                if (a.taken || value(a) <= 0.002 || sellers(a).length === 0 || maxR(a) >= a.rep) continue;
                const f = topSeller(a), deficit = a.rep - R(f);
                const sc = value(a) / deficit;
                if (!best || sc > best.sc) best = { a, f, deficit, sc };
            }
            if (!best) break;
            const give = Math.min(repLeft, best.deficit);
            Rf[best.f] = R(best.f) + give; repLeft -= give;
            if (give < best.deficit) break;
        }
        if (repLeft > 1) { const top = Object.keys(Rf).sort((x, y) => R(y) - R(x))[0] ?? "?"; Rf[top] = R(top) + repLeft; }
        let spent = 0, n = 0; const bought = [];
        const cands = pool.filter(a => !a.taken && value(a) > 0.002 && sellers(a).length > 0).map(a => {
            const f = topSeller(a), deficit = Math.max(0, a.rep - R(f));
            const donate = deficit > 0 && R(f) >= DONATE_REP;            // favour 150: rep can be bought
            return { a, f, deficit, donate, ok: deficit === 0 || donate, extra: donate ? deficit * 1e6 / repMult : 0 };
        }).filter(c => c.ok).sort((x, y) => value(y.a) / (y.a.price + y.extra) - value(x.a) / (x.a.price + x.extra));
        for (const c of cands) {
            const p = c.a.price * Math.pow(step, n) + c.extra;
            if (spent + p > budget) continue;
            spent += p; n++; c.a.taken = true; bought.push(c.a.name);
            if (c.deficit > 0) Rf[c.f] = c.a.rep;
            m.hacking *= Math.max(1, c.a.h); m.hackExp *= Math.max(1, c.a.e);
            for (let i = 0; i < 4; i++) m.combat[i] *= Math.max(1, c.a.cs[i]);
        }
        // NeuroFlux Governor: every level multiplies all skills a little (compounding), costs x1.14 more per level (price and rep), and counts in the price step
        if (cfg.nf) {
            for (let guard = 0; guard < 400; guard++) {
                const p = cfg.nf.price * Math.pow(1.14, nfLevel) * Math.pow(step, n), r = cfg.nf.rep * Math.pow(1.14, nfLevel);
                if (spent + p > budget || r > allMax()) break;
                spent += p; n++; nfLevel++; bought.push("NeuroFlux Governor");
                m.hacking *= Math.max(1, cfg.nf.h); m.hackExp *= Math.max(1, cfg.nf.e);
                for (let i = 0; i < 4; i++) m.combat[i] *= Math.max(1, cfg.nf.cs[i]);
            }
        }
        installed += bought.length;
        let runHours = T;
        const entry = { run: k, names: bought, bought: bought.length, hackMult: m.hacking, combat: [...m.combat], income, repRun, spent, topRep: allMax() };
        if (goal === "hacking") {
            const H = cfg.hackRoute;
            const rate2 = cfg.expRate * (m.hackExp / mult0.hackExp) * Math.pow(Math.max(1, m.hacking / mult0.hacking), cfg.scenario.exp);
            const level2 = (hrs) => skillAt(rate2 * hrs * 3600, m.hacking);
            if (stage === 0) {
                // Daedalus needs N augmentations installed, hacking level, and the money in hand at once: a long run if only the money is missing
                if (installed >= H.daedalusAugs && level2(T) >= H.daedalusHack) {
                    const needH = H.daedalusMoney / (income * 0.8) / 3600;
                    if (needH <= 36) { runHours = Math.max(T, needH); stage = 1; entry.note = "Daedalus invite"; }
                }
            } else if (stage === 1) {
                const d = R("Daedalus"), repOk = d >= H.rpRep || H.rpHeld, buyRep = !repOk && d >= DONATE_REP ? (H.rpRep - d) * 1e6 / repMult : (repOk ? 0 : Infinity);
                if (Number.isFinite(buyRep) && budget >= H.rpPrice + buyRep) { stage = 2; entry.note = "Red Pill bought"; }
            } else if (stage === 2) {
                // The Red Pill is installed at the start of this run: can this run reach the required level?
                const need = expFor(H.required, m.hacking) / rate2 / 3600;
                if (need <= 36) { runHours = Math.max(need, 0.5); hours += runHours; entry.note = "final run"; entry.hours = hours; log.push(entry); return { reached: true, hours, runs: k, log }; }
            }
            if (level2(T) >= H.required && stage < 2) entry.levelOnlyNote = "level reachable but The Red Pill is not installed yet";
        } else {
            // Gym retrain: the install reset all skill exp; the four combat stats share gymHours
            const gym = cfg.bb.gymHours, E = GYM_EXP_PER_SECOND * 3600 * (gym / 4) * (cfg.mult.combatExp ?? 1);
            const lv = { ...cfg.bb.lv, strength: skillAt(E, m.combat[0]), defense: skillAt(E, m.combat[1]), dexterity: skillAt(E, m.combat[2]), agility: skillAt(E, m.combat[3]) };
            entry.lv = lv;
            const rank0 = state.rank;
            bladeburnerAdvance(acts, state, lv, Math.max(0, T - gym), cfg.bb.duty);
            entry.rank = state.rank;
            if (state.rank >= 400000) {
                const frac = Math.min(1, Math.max(0, (400000 - rank0) / Math.max(1e-9, state.rank - rank0)));
                hours += gym + Math.max(0, T - gym) * frac; entry.hours = hours; log.push(entry); return { reached: true, hours, runs: k, log };
            }
        }
        hours += runHours + over; entry.hours = hours; log.push(entry);
    }
    return { reached: false, hours, runs: maxRuns, log };
}

/** The game's chance before population, stamina, skill multipliers and the like: min(1, competence / difficulty) at an action level. */
function rawChance(name, lv, level = 1) {
    const a = BY_NAME.get(name); if (!a) return NaN;
    return Math.min(1, competence(a, lv) / (a.base * Math.pow(a.dfac, Math.max(1, level) - 1)));
}
/** Smallest income multiplier (1, 2, 4, ...) at which projectRoute(goal, cfg) reaches its goal within maxHours with flat income growth; Infinity if none up to 4096. */
function incomeNeeded(goal, cfg, maxHours = 100) {
    for (let k = 1; k <= 4096; k *= 2) {
        const r = projectRoute(goal, { ...cfg, income: cfg.income * k, scenario: { income: 0, exp: 0 } });
        if (r.reached && r.hours <= maxHours) return k;
    }
    return Infinity;
}

/**
 * Income growth with the hacking multiplier across runs: a log-log fit of `points` ({ mult, income }). Only a fit that explains
 * the data is used: it needs at least 3 runs spanning a 1.3x range of multipliers, an R-squared of at least 0.5, and a raw slope
 * under the cap. A slope at or past the cap means income grew by something other than the multiplier (more RAM, servers, a new
 * target...), which would be credited to the multiplier and make hacking look far better than it is.
 * Returns { exponent (capped 0..cap, NaN when there is no fit), raw, r2, reliable, runs }.
 */
function fitIncomeExponent(points, cap = 3) {
    const usable = (points || []).filter((p) => p && p.income > 0 && p.mult > 0);
    const none = { exponent: NaN, raw: NaN, r2: NaN, reliable: false, runs: usable.length };
    if (usable.length < 3) return none;
    const mults = usable.map((p) => p.mult);
    if (Math.max(...mults) / Math.min(...mults) <= 1.3) return none;
    const xs = usable.map((p) => Math.log(p.mult)), ys = usable.map((p) => Math.log(p.income));
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
    const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0), syy = ys.reduce((a, y) => a + (y - my) ** 2, 0);
    const sxy = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
    if (!(sxx > 0)) return none;
    const raw = sxy / sxx, r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
    return { exponent: Math.min(cap, Math.max(0, raw)), raw, r2, reliable: raw >= 0 && raw < cap && r2 >= 0.5, runs: usable.length };
}

export { levelFactor, modelMults, inviteGate, gateOpen, fitIncomeExponent, AUG_STEP, GYM_EXP_PER_SECOND, skillAt, expFor, ACTIONS, makeBladeburner, bladeburnerClone, bladeburnerAdvance, bestChanceNow, predictRankPerHour, DONATE_REP, projectRoute, rawChance, incomeNeeded };
