// --- SETTINGS ---
const RESERVE_SHARE = 0.1;   // Never spend below this share of the most money you've had since installing augmentations (0.5 = half, 0 = spend everything)
const PEAK_FILE = "money-peak.txt"; // Where that highest amount is remembered

/** @param {NS} ns */
export async function main(ns) {
    let targetRam = 8;
    const maxServers = ns.cloud.getServerLimit(); // v3.0.0 API
    const prefix = "cloud-serv-";

    ns.disableLog("sleep");
    ns.disableLog("getServerMoneyAvailable");
    ns.disableLog("getServerMaxRam");
    ns.disableLog("getServerUsedRam");
    ns.clearLog();

    ns.print(`[Cloud Manager] Active. Target Tier: ${targetRam}GB | Limit: ${maxServers} | Keeping ${RESERVE_SHARE * 100}% of peak money`);

    // Money we may spend: everything above the reserve
    const spendable = () => ns.getServerMoneyAvailable("home") - reserve(ns);

    while (true) {
        let purchasedServers = ns.cloud.getServerNames(); // v3.0.0 API

        // Buy as many servers as we can afford in a single cycle up to the limit
        while (purchasedServers.length < maxServers) {
            let cost = ns.cloud.getServerCost(targetRam); // v3.0.0 API

            if (spendable() >= cost) {
                let id = 1;
                while (purchasedServers.includes(prefix + id)) {
                    id++;
                }

                let hostname = prefix + id;
                let serverName = ns.cloud.purchaseServer(hostname, targetRam); // v3.0.0 API
                if (serverName) {
                    ns.print(`[Purchased] ${serverName} (${targetRam}GB) [${purchasedServers.length + 1}/${maxServers}]`);
                    purchasedServers = ns.cloud.getServerNames(); // Refresh list
                } else {
                    break;
                }
            } else {
                break;
            }
        }

        // Upgrade tier check
        let nextRam = targetRam * 2;
        let nextTierCost = ns.cloud.getServerCost(nextRam) * maxServers;
        if (spendable() >= nextTierCost) {
            targetRam = nextRam;
            ns.print(`[Tier Up] Upgrading target server RAM tier to ${targetRam}GB!`);
        }

        // Upgrade existing servers if they are below the current target RAM tier
        for (let i = 0; i < purchasedServers.length; i++) {
            let serv = purchasedServers[i];
            let currentRam = ns.getServerMaxRam(serv);

            if (currentRam < targetRam) {
                let upgradeCost = ns.cloud.getServerUpgradeCost(serv, targetRam); // Fixed method name
                if (spendable() >= upgradeCost) {
                    ns.cloud.upgradeServer(serv, targetRam); // v3.0.0 API
                    ns.print(`[Upgraded] ${serv} -> ${targetRam}GB RAM.`);
                }
            }
        }

        await ns.sleep(1000);
    }
}

/**
 * Money to keep: RESERVE_SHARE of the most money you've had since installing augmentations.
 * The peak is saved in PEAK_FILE (shared by the scripts that use it) and starts over after each install.
 */
function reserve(ns) {
    const reset = readReset(ns);
    let data = { reset, peak: 0 };
    try {
        const saved = JSON.parse(ns.read(PEAK_FILE));
        if (saved.reset === reset) data = saved;
    } catch { } // no file yet
    const money = ns.getServerMoneyAvailable("home");
    if (money > data.peak) {
        data.peak = money;
        ns.write(PEAK_FILE, JSON.stringify(data), "w");
    }
    return RESERVE_SHARE * data.peak;
}

/** Time of the last augmentation install, written by reset-marker.js (the orchestrator runs it). Reading a file is free; getResetInfo costs 1 GB. */
function readReset(ns) {
    return Number(ns.read("reset-info.txt")) || Date.now();
}
