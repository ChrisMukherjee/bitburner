/** @param {NS} ns **/
import { getAllServers } from "/utils/get-all-servers.js"
import { notify } from "/utils/notify.js";

// Finds coding contracts every 15 minutes and hands them to contracts/workers/contract-solver.js, which solves
// them and exits. The solver needs ~22GB (the codingcontract calls are expensive), so this loop only
// holds ~3.5GB and the solver's RAM is only taken for a moment when there is something to solve.
const SOLVER = "contracts/workers/contract-solver.js";
const FAILED_FILE = "data/failed-contracts.txt"; // "server:file" keys the solver got wrong, one per line

export async function main(ns) {
  ns.disableLog("ALL");
  ns.print("Scanning network for Coding Contracts...");

  const checkInterval = 15 * 60 * 1000; // 15 minutes in milliseconds
  let lastNoRoomCount = 0; // waiting count last announced, so the warning toasts once

  while (true) {
    const failed = new Set(ns.read(FAILED_FILE).split("\n").filter(Boolean));
    const found = [];
    for (const server of getAllServers(ns)) {
      for (const file of ns.ls(server, ".cct")) {
        if (failed.has(`${server}:${file}`)) {
          ns.print(`Skipping ${file} on ${server}: already failed once.`);
          continue;
        }
        found.push([server, file]);
      }
    }

    if (found.length > 0) {
      const need = ns.getScriptRam(SOLVER, "home");
      const free = ns.getServerMaxRam("home") - ns.getServerUsedRam("home");
      if (need > free || ns.exec(SOLVER, "home", 1, JSON.stringify(found)) === 0) {
        const message = `${found.length} contracts waiting, but the solver needs ${need} GB and home has ${free.toFixed(1)} GB free. Retrying next scan.`;
        // Announce once per waiting count; repeats only go to the log.
        if (found.length !== lastNoRoomCount) notify(ns, "[contracts]", message, "warning", true);
        else ns.print(`[contracts] ${message}`);
        lastNoRoomCount = found.length;
      } else {
        lastNoRoomCount = 0;
      }
    } else {
      lastNoRoomCount = 0;
      ns.print("Contract scan finished. No new contracts.");
    }

    // Sleep for 15 minutes before checking again
    await ns.sleep(checkInterval);
  }
}
