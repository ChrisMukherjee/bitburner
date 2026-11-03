// Description: Runs your gang for you. Recruits members, trains them, ascends them at the right time,
// buys their gear, and keeps them on the best tasks. Works for both hacking and combat gangs
// (it asks the game which kind you have, every cycle). Start it with `run gang.js`, or let orchestrator.js do it.
//
// What it does every gang cycle (about every 2 seconds, faster during bonus time):
//   1. RECRUIT   - recruits a member whenever you have enough respect (up to 12). New members start training.
//   2. ASCEND    - ascends one member if it would boost their skills enough (see ASCEND_FACTOR).
//   3. SHOP      - buys gear for every member, cheapest first, without spending the reserve.
//   4. WAR       - turns territory clashes on only when you are very likely to win them, and off again if not.
//   5. TASKS     - trainees train; the rest are split between earning respect/money, cleaning the wanted
//                  level (vigilante-style tasks) and building power for territory warfare.
//
// A gang can't switch between hacking and combat: the type is decided by the faction you made the gang with.
// You can only change it by starting a new gang (after a BitNode reset), so this script simply follows what
// ns.gang.getGangInformation() says.

// --- SETTINGS ---------------------------------------------------------------------------------------------
// Money
const RESERVE_SHARE = 0.1;       // Same rule as hacknet.js: never spend below this share of your peak money (read from PEAK_FILE)
const PEAK_FILE = "money-peak.txt"; // hacknet.js keeps this up to date; this script only reads it
const SPEND_SHARE = 0.25;        // One purchase may use at most this share of the money above the reserve
const BUY_EVERY = 5;             // Shop every N gang cycles (also right after a recruit or an ascension)

// Training and ascension
const TRAIN_UNTIL = 80;          // Members whose average main skill is below this keep training (combat: str/def/dex/agi, hacking: hack)
const ASCEND_FACTOR = 1.3;       // Ascend when the main skill multipliers would grow by this factor on average (1.3 = +30%)
const ASCEND_MAX_RESPECT_SHARE = 0.35; // ...but not if it would cost more than this share of the gang's total respect

// Wanted level (too much wanted level cuts your respect and money income)
const PENALTY_LOW = 0.95;        // Start putting members on wanted-reducing tasks when respect/(respect+wanted) drops below this
const PENALTY_HIGH = 0.99;       // ...and take them off again once it climbs back above this
const WANTED_MIN = 1.5;          // Don't bother cleaning while the wanted level is this low

// Task split
const MAX_MEMBERS = 12;          // The game's limit
const EARLY_MONEY_SHARE = 0.3;   // While you have fewer than 12 members: this share of workers earns money (for gear), the rest earns respect
                                 // With a full gang everybody earns money

// Territory warfare
const WAR_MIN_MEMBERS = 12;      // No warfare until you have a full gang
const WAR_SHARE = 0.3;           // Share of workers (the weakest ones) sent to "Territory Warfare" to build power while territory < 100%
const ENGAGE_CHANCE = 0.65;      // Turn clashes on when you'd win against EVERY other gang at least this often
const DISENGAGE_CHANCE = 0.55;   // ...and turn them off again if it falls below this
// -----------------------------------------------------------------------------------------------------------

const HACKING = { train: "Train Hacking", skill: ["hack"], gear: ["hack", "cha"], hackingTasks: true };
const COMBAT = { train: "Train Combat", skill: ["str", "def", "dex", "agi"], gear: ["str", "def", "dex", "agi"], hackingTasks: false };
const WAR_TASK = "Territory Warfare";
// Which task field says how much a skill counts towards a task
const WEIGHT = { hack: "hackWeight", str: "strWeight", def: "defWeight", dex: "dexWeight", agi: "agiWeight", cha: "chaWeight" };

/** @param {import(".").NS } ns */
export async function main(ns) {
    ns.disableLog("ALL");
    while (!ns.gang.inGang()) {
        ns.print("[Wait] You're not in a gang yet. Checking again in a minute.");
        await ns.sleep(60000);
    }
    ns.print("=== Gang Automation Script Started ===");

    // Tasks and gear never change, so look them up once
    const tasks = ns.gang.getTaskNames().map(n => ns.gang.getTaskStats(n));
    const gear = ns.gang.getEquipmentNames().map(n => ({ name: n, stats: ns.gang.getEquipmentStats(n) }));
    const st = { vig: 0, cycle: 0 }; // vig = how many members are currently on wanted-reducing tasks

    while (true) {
        const info = ns.gang.getGangInformation();
        const kind = info.isHacking ? HACKING : COMBAT;
        st.cycle++;

        const recruited = recruit(ns);
        const ascended = ascendBest(ns, info, kind);
        const members = ns.gang.getMemberNames().map(n => ns.gang.getMemberInformation(n));

        if (recruited || ascended || st.cycle % BUY_EVERY === 1) shop(ns, members, gear, kind);
        manageWar(ns, info, members.length);
        assign(ns, info, members, tasks, kind, st);

        if (st.cycle % 15 === 1) {
            const penalty = info.respect / (info.respect + info.wantedLevel);
            ns.print(`[Status] ${kind === HACKING ? "hacking" : "combat"} gang, ${members.length} members, $${ns.format.number(info.moneyGainRate * 5)}/s, ` +
                `respect ${ns.format.number(info.respect)}, wanted penalty ${(penalty * 100).toFixed(1)}%, ` +
                `territory ${(info.territory * 100).toFixed(1)}%, clashes ${info.territoryWarfareEngaged ? "ON" : "off"}, cleaning ${st.vig}`);
        }
        await ns.gang.nextUpdate();
    }
}

/** Recruits as many members as your respect allows. Returns how many were recruited. */
function recruit(ns) {
    let count = 0;
    while (ns.gang.canRecruitMember()) {
        const taken = new Set(ns.gang.getMemberNames());
        let n = taken.size + 1;
        while (taken.has(`gang-${n}`)) n++;
        if (!ns.gang.recruitMember(`gang-${n}`)) break;
        ns.tprint(`[Gang] Recruited gang-${n}.`);
        count++;
    }
    return count;
}

/** Average of the given skills (members and ascension results both use the same short names). */
function avg(obj, keys) {
    let sum = 0;
    for (const k of keys) sum += obj[k];
    return sum / keys.length;
}

/**
 * Ascending resets a member's levels and (non-augmentation) gear but makes them permanently stronger.
 * Ascends the member with the biggest boost, but only one per cycle and only if the boost is worth it.
 */
function ascendBest(ns, info, kind) {
    let bestName = null, bestGain = 0;
    for (const name of ns.gang.getMemberNames()) {
        const result = ns.gang.getAscensionResult(name);
        if (!result) continue;
        const gain = avg(result, kind.skill);
        if (gain < ASCEND_FACTOR || gain <= bestGain) continue;
        if (result.respect > info.respect * ASCEND_MAX_RESPECT_SHARE) continue;
        bestName = name;
        bestGain = gain;
    }
    if (!bestName) return false;
    ns.gang.ascendMember(bestName);
    ns.tprint(`[Gang] Ascended ${bestName}: main skills x${bestGain.toFixed(2)}.`);
    return true;
}

/** Money above the reserve (same idea as hacknet.js: a share of your peak money is kept back). */
function spendable(ns) {
    let reserve = 0;
    try { reserve = RESERVE_SHARE * JSON.parse(ns.read(PEAK_FILE)).peak; } catch { } // no file yet = no reserve
    return ns.getServerMoneyAvailable("home") - (reserve || 0);
}

/** Buys gear that helps this gang type, cheapest first, for every member who doesn't own it yet. */
function shop(ns, members, gear, kind) {
    const useful = gear.filter(g => kind.gear.some(k => g.stats[k]));
    const priced = useful.map(g => ({ name: g.name, cost: ns.gang.getEquipmentCost(g.name) })).sort((a, b) => a.cost - b.cost);
    const owned = new Map(members.map(m => [m.name, new Set([...m.upgrades, ...m.augmentations])]));
    let cash = spendable(ns);

    for (const item of priced) {
        if (item.cost > cash * SPEND_SHARE) break; // everything after this is dearer
        for (const m of members) {
            if (owned.get(m.name).has(item.name)) continue;
            if (item.cost > cash * SPEND_SHARE) break;
            if (ns.gang.purchaseEquipment(m.name, item.name)) {
                cash -= item.cost;
                ns.print(`[Buy] ${item.name} for ${m.name} ($${ns.format.number(item.cost)})`);
            }
        }
    }
}

/** Switches territory clashes on/off depending on your chance to win against every gang that still owns land. */
function manageWar(ns, info, memberCount) {
    let lowest = Infinity;
    for (const [other, data] of Object.entries(ns.gang.getAllGangInformation())) {
        if (other === info.faction || data.territory <= 0) continue;
        lowest = Math.min(lowest, ns.gang.getChanceToWinClash(other));
    }
    let want = false;
    if (lowest !== Infinity && info.territory < 1 && memberCount >= WAR_MIN_MEMBERS) {
        want = lowest >= (info.territoryWarfareEngaged ? DISENGAGE_CHANCE : ENGAGE_CHANCE);
    }
    if (want !== info.territoryWarfareEngaged) {
        ns.gang.setTerritoryWarfare(want);
        ns.tprint(`[Gang] Territory clashes ${want ? "ON" : "OFF"} (worst win chance ${lowest === Infinity ? "n/a" : (lowest * 100).toFixed(0) + "%"}).`);
    }
}

/** How much a member's skills are worth on a task (the game's stat weight formula). 0 or less = too hard for them. */
function skillWeight(task, m) {
    let sum = 0;
    for (const k in WEIGHT) sum += task[WEIGHT[k]] * m[k];
    return sum / 100 - 4 * task.difficulty;
}

/** Territory scaling of a task's payout (the more land you own, the more the land-dependent tasks pay). */
function landMult(task, field, territory) {
    const w = task.territory[field];
    return w <= 0 ? 1 : Math.max(0.005, Math.pow(territory * 100, w) / 100);
}

/** Name of the task that scores highest for this member, or null if none scores above 0. */
function bestTask(tasks, m, kind, territory, scoreOf) {
    let top = null, topScore = 0;
    for (const t of tasks) {
        if (kind.hackingTasks ? !t.isHacking : !t.isCombat) continue;
        const weight = skillWeight(t, m);
        if (weight <= 0) continue;
        const score = scoreOf(t, weight, territory);
        if (score > topScore) { top = t.name; topScore = score; }
    }
    return top;
}

// Ways to rate a task. Tasks that lower the wanted level are kept out of the respect/money ones.
const BY_RESPECT = (t, w, land) => t.baseWanted < 0 ? 0 : t.baseRespect * w * landMult(t, "respect", land) + 1e-6 * t.baseMoney * w;
const BY_MONEY = (t, w, land) => t.baseWanted < 0 ? 0 : t.baseMoney * w * landMult(t, "money", land) + 1e-6 * t.baseRespect * w;
const BY_CLEANING = (t, w) => t.baseWanted < 0 ? -t.baseWanted * w : 0;

/** Decides every member's task and applies it (only when it changes, so progress isn't reset). */
function assign(ns, info, members, tasks, kind, st) {
    const plan = [];  // [member, task name]
    const land = info.territory;

    // 1. Trainees: anyone whose main skills are still low
    const pool = [];
    for (const m of members) {
        if (avg(m, kind.skill) < TRAIN_UNTIL) plan.push([m, kind.train]);
        else pool.push(m);
    }
    pool.sort((a, b) => avg(b, kind.skill) - avg(a, kind.skill)); // strongest first

    // 2. Territory warfare: the weakest workers build power while there is still land to take
    if (members.length >= WAR_MIN_MEMBERS && land < 0.999 && pool.length > 1) {
        const n = Math.min(Math.ceil(WAR_SHARE * pool.length), pool.length - 1);
        for (const m of pool.splice(pool.length - n, n)) plan.push([m, WAR_TASK]);
    }

    // 3. Wanted level: add a cleaner when the penalty is high and still growing, remove one when it's fine again
    const penalty = info.respect / (info.respect + info.wantedLevel);
    if (penalty < PENALTY_LOW && info.wantedLevel > WANTED_MIN && info.wantedLevelGainRate >= 0) st.vig++;
    else if (penalty > PENALTY_HIGH || info.wantedLevel < 1.1) st.vig--;
    st.vig = Math.max(0, Math.min(st.vig, Math.ceil(pool.length / 2)));
    for (const m of pool.splice(pool.length - st.vig, st.vig)) {
        plan.push([m, bestTask(tasks, m, kind, land, BY_CLEANING) ?? kind.train]);
    }

    // 4. Everyone else earns: with a full gang all money; before that the strongest earn respect (to recruit)
    const moneyCount = members.length >= MAX_MEMBERS ? pool.length : Math.round(EARLY_MONEY_SHARE * pool.length);
    pool.forEach((m, i) => {
        const [first, second] = i >= pool.length - moneyCount ? [BY_MONEY, BY_RESPECT] : [BY_RESPECT, BY_MONEY];
        plan.push([m, bestTask(tasks, m, kind, land, first) ?? bestTask(tasks, m, kind, land, second) ?? kind.train]);
    });

    for (const [m, task] of plan) {
        if (m.task !== task) ns.gang.setMemberTask(m.name, task);
    }
}
