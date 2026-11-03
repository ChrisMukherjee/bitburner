// Design: docs/aug-reset.md
// Run by hand: a readable table of EVERY augmentation across ALL factions, from live game state: who sells it, price, rep
// needed, rep time at the game's rep formula for your skills, what it does, its value under the current settings, and what the
// planner does with it (and why). Written to data/aug-dataset.txt (`cat data/aug-dataset.txt`); also printed with --print.
// Ported from the other player's aug-dataset.js, which ran every 10 minutes.
import { singularityInfo } from "/utils/singularity.js";
import { loadConfig } from "/utils/config.js";
import { wantedBoosts, augValue } from "/utils/aug-filter.js";
import { readIncomeRate } from "/utils/income.js";

const NEUROFLUX = "NeuroFlux Governor";
const ALL_FACTIONS = ["CyberSec", "NiteSec", "The Black Hand", "BitRunners", "Daedalus", "The Covenant", "Illuminati", "ECorp", "MegaCorp",
    "Bachman & Associates", "Blade Industries", "NWO", "Clarke Incorporated", "OmniTek Incorporated", "Four Sigma", "KuaiGong International",
    "Fulcrum Secret Technologies", "Tian Di Hui", "Netburners", "Sector-12", "Aevum", "Chongqing", "New Tokyo", "Ishima", "Volhaven",
    "Slum Snakes", "Tetrads", "Silhouette", "Speakers for the Dead", "The Dark Army", "The Syndicate", "Bladeburners"];
const CITY_FACTIONS = new Set(["Sector-12", "Aevum", "Volhaven", "Chongqing", "New Tokyo", "Ishima"]);
const BN_FACTION_REP = { 2: 0.5, 4: 0.75, 13: 0.6, 14: 0.2 };   // FactionWorkRepGain per BitNode (v3.0.1 source)
const fmt = (s) => !Number.isFinite(s) ? "n/a" : s < 90 ? `${Math.ceil(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 48 * 3600 ? `${(s / 3600).toFixed(1)}h` : `${(s / 86400).toFixed(1)}d`;
const usd = (n) => !Number.isFinite(n) ? "n/a" : n === 0 ? "$0" : "$" + Number(n).toExponential(1).replace("e+", "e");
const pad = (s, n) => String(s).length >= n ? String(s).slice(0, n) : String(s) + " ".repeat(n - String(s).length);

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");
    if (!singularityInfo(ns).available) { ns.tprint("aug-dataset: needs the Singularity API (BitNode 4 or Source-File 4)."); return; }
    const flags = ns.flags([["print", false]]);
    const sing = ns.singularity, cfg = loadConfig(ns), augCfg = cfg.augments;
    const player = ns.getPlayer(), joined = new Set(player.factions), node = ns.getResetInfo().currentNode;
    const owned = new Set(sing.getOwnedAugmentations(true)), installed = new Set(sing.getOwnedAugmentations(false));
    const cash = ns.getServerMoneyAvailable("home"), income = readIncomeRate(ns).perSecond;
    let invited = []; try { invited = sing.checkFactionInvitations(); } catch { }
    let plan = null; try { plan = JSON.parse(ns.read("data/aug-plan.json")); } catch { }
    const chosen = new Set(plan?.affordable ?? []);
    const karma = ns.heart.break(), s = player.skills, repMult = (player.mults.faction_rep || 1) * (BN_FACTION_REP[node] ?? 1);

    // Rep per second while working (v3.0.1 formulas, per cycle x 5 cycles/s): the best work type for the player's skills
    const rateFor = (favor) => {
        const fm = (1 + favor / 100) * repMult;
        const hackRate = 5 * (s.hacking + s.intelligence / 3) / 975 * fm;
        const sec = 5 * 0.9 * (s.strength + s.defense + s.dexterity + s.agility + (s.hacking + s.intelligence) * 1) / 975 / 4.5 * fm;
        const field = 5 * 0.9 * (s.strength + s.defense + s.dexterity + s.agility + s.charisma + (s.hacking + s.intelligence)) / 975 / 5.5 * fm;
        return Math.max(hackRate, sec, field);
    };

    // Unmet invite requirements as text ([] = all met)
    const unmet = (r) => {
        switch (r.type) {
            case "money": return cash >= r.money ? [] : [`$${ns.format.number(r.money)}`];
            case "skills": return Object.entries(r.skills).filter(([k, v]) => (s[k] ?? 0) < v).map(([k, v]) => `${k} ${Math.floor(s[k])}/${v}`);
            case "karma": return (r.karma < 0 ? karma <= r.karma : karma >= r.karma) ? [] : [`karma ${karma.toFixed(0)}/${r.karma}`];
            case "numPeopleKilled": return (player.numPeopleKilled ?? 0) >= r.numPeopleKilled ? [] : [`${r.numPeopleKilled} kills`];
            case "file": return ns.fileExists(r.file, "home") ? [] : [`file ${r.file}`];
            case "numAugmentations": return installed.size >= r.numAugmentations ? [] : [`${installed.size}/${r.numAugmentations} augs installed`];
            case "city": return player.city === r.city ? [] : [`be in ${r.city}`];
            case "location": return player.location === r.location ? [] : [`be at ${r.location}`];
            case "backdoorInstalled": { let ok = false; try { ok = ns.getServer(r.server).backdoorInstalled; } catch { } return ok ? [] : [`backdoor ${r.server}`]; }
            case "bitNodeN": return node === r.bitNodeN ? [] : [`BitNode ${r.bitNodeN}`];
            case "sourceFile": return ns.getResetInfo().ownedSF.has(r.sourceFile) ? [] : [`SF${r.sourceFile}`];
            case "bladeburnerRank": return [`Bladeburner rank ${r.bladeburnerRank}`];
            case "not": return unmet(r.condition).length === 0 ? [`must NOT ${r.condition.type}${r.condition.company ? " " + r.condition.company : ""}`] : [];
            case "someCondition": { const sets = r.conditions.map(unmet); return sets.some(x => x.length === 0) ? [] : [sets.map(x => x.join(" + ")).join(" OR ")]; }
            case "everyCondition": return r.conditions.flatMap(unmet);
            default: return [`${r.type}${r.company ? " " + r.company : ""}${r.reputation ? " " + r.reputation : ""}`];   // employedBy, jobTitle, companyReputation, hacknet*, numInfiltrations
        }
    };
    const factionNames = [...new Set([...ALL_FACTIONS, ...joined])];
    const fac = {};   // name -> { joined, rep, favor, rate, need: [unmet], invited }
    for (const f of factionNames) {
        const isJoined = joined.has(f);
        let need = [];
        if (!isJoined) { try { need = sing.getFactionInviteRequirements(f).flatMap(unmet); } catch { need = ["requirements unreadable"]; } }
        if (!isJoined) { let en = []; try { en = sing.getFactionEnemies(f); } catch { } const bar = [...joined].find(j => en.includes(j)); if (bar) need = [`BARRED by ${bar} (enemy faction joined this run)`]; }
        const favor = isJoined ? sing.getFactionFavor(f) : 0;
        fac[f] = { joined: isJoined, rep: isJoined ? sing.getFactionRep(f) : 0, favor, rate: rateFor(favor), need, invited: invited.includes(f) };
    }

    // One row per augmentation
    const rows = new Map();
    for (const f of factionNames) {
        let list = []; try { list = sing.getAugmentationsFromFaction(f); } catch { continue; }
        for (const a of list) {
            let r = rows.get(a);
            if (!r) {
                const st = sing.getAugmentationStats(a);
                const raw = Object.entries(st).filter(([k, v]) => typeof v === "number" && v !== 1 && !/^(crime|work_money|company_rep|hacknet|dnet|bladeburner_)/.test(k) || (typeof v === "number" && v !== 1 && /bladeburner_success_chance|bladeburner_max_stamina/.test(k)))
                    .map(([k, v]) => ({ k, v })).sort((x, y) => Math.abs(Math.log(y.v)) - Math.abs(Math.log(x.v))).slice(0, 4)
                    .map(({ k, v }) => `${k.replace(/_mult$/, "")} x${v.toFixed(2)}`).join(", ");
                r = { aug: a, price: sing.getAugmentationPrice(a), rep: sing.getAugmentationRepReq(a), impact: raw || "(no stat change)", wants: wantedBoosts(a, st, augCfg), value: augValue(a, st, augCfg), sellers: [] };
                rows.set(a, r);
            }
            r.sellers.push(f);
        }
    }

    // Status of each: the cheapest way to get it (a joined faction first, otherwise the one with the least left to do)
    const out = [];
    for (const r of rows.values()) {
        const opts = r.sellers.map(f => {
            const x = fac[f], missing = Math.max(0, r.rep - x.rep), t = x.rate > 0 ? missing / x.rate : Infinity;
            return { f, x, missing, t, joined: x.joined };
        }).sort((a, b) => (b.joined - a.joined) || (a.x.need.length - b.x.need.length) || (a.t - b.t));
        const best = opts[0];
        const isNF = r.aug === NEUROFLUX;
        let status;
        if (isNF) status = "NeuroFlux: bought with leftover money after the others (levels cost x1.14 more each)";
        else if (installed.has(r.aug)) status = "INSTALLED";
        else if (owned.has(r.aug)) status = "BOUGHT, installs at the next reset";
        else if (r.value <= 0 && !r.wants) status = "SKIPPED: nothing it boosts counts under the current route (stat groups: " + augCfg.wantStats.join("/") + ")";
        else if (!best.joined) status = `NOT AVAILABLE: ${best.f} not joined${best.x.invited ? " (invite waiting" + (CITY_FACTIONS.has(best.f) ? ": joining a city faction bars its rivals, player-work.js decides which" : "") + ")" : best.x.need.length ? ": needs " + best.x.need.join("; ") : ": no invite yet"}`;
        else if (best.missing > 0) status = `REP: ${best.f} needs ${Math.round(best.missing)} more rep (~${fmt(best.t)} at ${best.x.rate.toFixed(1)}/s)`;
        else if (chosen.has(r.aug)) status = `CHOSEN: in the current buy plan (${best.f})`;
        else status = `BUYABLE at ${best.f}: ${r.price > cash ? "not affordable yet (needs " + usd(r.price) + ", have " + usd(cash) + ")" : "affordable, waiting for the plan/reset rule"}`;
        out.push({ ...r, best, status, perB: r.price > 0 ? r.value / (r.price / 1e9) : 0 });
    }
    const rank = (o) => /^CHOSEN/.test(o.status) ? 0 : /^BUYABLE/.test(o.status) ? 1 : /^REP/.test(o.status) ? 2 : /^NOT AVAILABLE/.test(o.status) ? 3 : /^SKIPPED/.test(o.status) ? 4 : 5;
    out.sort((a, b) => rank(a) - rank(b) || b.perB - a.perB);

    const L = [];
    L.push(`${new Date().toLocaleTimeString()}  augmentation dataset, BitNode ${node}; cash ${usd(cash)}, income ${usd(income)}/s, karma ${karma.toFixed(0)}`);
    L.push(`How augments are ranked: value = sum of weight x ln(multiplier) over the stat groups the config wants (${augCfg.wantStats.join(", ")}); the planner buys the most expensive affordable ones first because each purchase makes the rest x1.9 dearer, then NeuroFlux. It only sees JOINED factions with enough rep.`);
    L.push(`Rep rates below are the game's formula for your skills (best of hacking/field/security work, x${repMult.toFixed(2)} rep multiplier, favour included); not measured.`);
    L.push("");
    L.push("FACTIONS (joined first; wanted = augs with value on this route not yet owned)");
    const fl = factionNames.map(f => ({ f, ...fac[f], aug: out.filter(o => o.sellers.includes(f) && o.value > 0 && !installed.has(o.aug) && !owned.has(o.aug)) }))
        .sort((a, b) => (b.joined - a.joined) || (b.aug.length - a.aug.length));
    for (const x of fl) {
        if (!x.joined && x.aug.length === 0) continue;
        const inOrder = cfg.factionWork.order.includes(x.f);
        L.push(`${pad(x.f, 28)} ${x.joined ? "JOINED " : x.invited ? "INVITED" : "       "} rep ${pad(Math.round(x.rep), 8)} favour ${pad(x.favor.toFixed(0), 4)} ${pad(x.aug.length + " wanted", 10)} ${x.joined ? (inOrder ? "worked in config order" : "joined; not in config order (not worked for)") : x.need.length ? "to join: " + x.need.join("; ") : "no invite requirement unmet but not invited yet"}`);
    }
    L.push("");
    L.push(`${pad("AUGMENTATION", 40)} ${pad("PRICE", 8)} ${pad("REP", 8)} ${pad("VALUE", 6)} ${pad("V/$B", 6)} ${pad("SOLD BY (J=joined)", 36)} IMPACT  ->  STATUS`);
    for (const o of out) {
        L.push(`${pad(o.aug, 40)} ${pad(usd(o.price), 8)} ${pad(Math.round(o.rep), 8)} ${pad(o.value.toFixed(2), 6)} ${pad(o.perB.toFixed(2), 6)} ${pad(o.sellers.slice(0, 3).map(f => (fac[f].joined ? "J:" : "") + f).join(", ") + (o.sellers.length > 3 ? ` +${o.sellers.length - 3}` : ""), 36)} ${o.impact}  ->  ${o.status}`);
    }
    ns.write("data/aug-dataset.txt", L.join("\n") + "\n", "w");
    if (flags.print) ns.tprint("\n" + L.join("\n"));
    else ns.tprint(`aug-dataset: ${out.length} augmentations written to data/aug-dataset.txt (cat it, or run with --print)`);
}
