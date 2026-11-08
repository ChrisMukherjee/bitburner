// @ts-check
/** @param {NS} ns **/
import { getAllServers } from "/utils/get-all-servers.js"
import { notify } from "/utils/notify.js";
import { MAP_FILE } from "/darknet/config.js";
import { CONTRACT_PORT, FAILED_FILE } from "/contracts/config.js";

// Finds coding contracts every 15 minutes and hands them to contracts/workers/contract-solver.js, which solves
// them and exits. The solver needs ~22GB (the codingcontract calls are expensive), so this loop stays small and
// the solver's RAM is only taken for a moment when there is something to solve.
//
// Besides the normal network it checks every darknet server in the darknet manager's map: opening a darknet
// .cache file can leave contracts on that server, and ns.scan from home never reaches them.
// The solver runs on home when there is room, otherwise on any rooted server with enough free RAM.
// It reports wrong answers on CONTRACT_PORT; this loop keeps FAILED_FILE (contracts never to retry) on home.
const SOLVER = "contracts/workers/contract-solver.js";
const SOLVER_FILES = [SOLVER, "contracts/config.js", "utils/notify.js", "utils/find-path.js"];

export async function main(ns) {
  ns.disableLog("ALL");
  ns.print("Scanning network for Coding Contracts...");

  const checkInterval = 15 * 60 * 1000; // 15 minutes in milliseconds
  let lastNoRoomCount = 0; // waiting count last announced, so the warning toasts once

  while (true) {
    drainFailures(ns); // in case a solver finished after this loop was last stopped
    const failed = readFailed(ns);
    const network = getAllServers(ns);
    const darknet = darknetHosts(ns, new Set(network));

    const found = [];
    const seen = new Set();     // every contract on a server we could read
    const unreadable = new Set(); // servers we couldn't list (darknet servers go offline and come back)
    for (const server of [...network, ...darknet]) {
      let files;
      try {
        files = ns.ls(server, ".cct");
      } catch {
        unreadable.add(server);
        continue;
      }
      for (const file of files) {
        const key = `${server}:${file}`;
        seen.add(key);
        if (failed.has(key)) {
          ns.print(`Skipping ${file} on ${server}: already failed once.`);
          continue;
        }
        found.push([server, file]);
      }
    }

    // Forget failures whose contract is gone (solved by hand or expired). Keep the ones on servers we couldn't
    // read this time, so a darknet server that comes back online doesn't get a second wrong try.
    for (const key of failed) {
      const server = key.slice(0, key.indexOf(":"));
      if (!seen.has(key) && !unreadable.has(server)) failed.delete(key);
    }
    writeFailed(ns, failed);

    if (found.length > 0) {
      const need = ns.getScriptRam(SOLVER, "home");
      const host = pickHost(ns, network, need);
      let pid = 0;
      if (host !== null) {
        if (host !== "home") ns.scp(SOLVER_FILES, host, "home");
        pid = ns.exec(SOLVER, host, 1, JSON.stringify(found));
      }
      if (pid === 0) {
        const free = ns.getServerMaxRam("home") - ns.getServerUsedRam("home");
        const message = `${found.length} contracts waiting, but the solver needs ${need} GB and no server has that free (home has ${free.toFixed(1)} GB). Retrying next scan.`;
        // Announce once per waiting count; repeats only go to the log.
        if (found.length !== lastNoRoomCount) notify(ns, "[contracts]", message, "warning", true);
        else ns.print(`[contracts] ${message}`);
        lastNoRoomCount = found.length;
      } else {
        lastNoRoomCount = 0;
        if (host !== "home") ns.print(`Home is short on RAM, so the solver runs on ${host}.`);
        // The solver finishes in moments; collect its wrong answers now rather than 15 minutes from now.
        while (ns.isRunning(pid)) await ns.sleep(1000);
      }
    } else {
      lastNoRoomCount = 0;
      ns.print("Contract scan finished. No new contracts.");
    }
    drainFailures(ns);

    // Sleep for 15 minutes before checking again
    await ns.sleep(checkInterval);
  }
}

/** Darknet hostnames from the darknet manager's map (empty when it hasn't run), minus ones already scanned. */
function darknetHosts(ns, skip) {
  let map = {};
  try {
    map = JSON.parse(ns.read(MAP_FILE) || "{}");
  } catch {
    return [];
  }
  return Object.keys(map).filter((host) => !skip.has(host));
}

/** Home if the solver fits there, otherwise the rooted server with the most free RAM that fits it. */
function pickHost(ns, network, need) {
  const free = (host) => ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
  if (free("home") >= need) return "home";
  let best = null;
  for (const host of network) {
    if (host === "home" || !ns.hasRootAccess(host) || free(host) < need) continue;
    if (best === null || free(host) > free(best)) best = host;
  }
  return best;
}

function readFailed(ns) {
  return new Set(ns.read(FAILED_FILE).split("\n").filter(Boolean));
}

function writeFailed(ns, failed) {
  ns.write(FAILED_FILE, [...failed].join("\n") + (failed.size ? "\n" : ""), "w");
}

/** Move the solver's wrong answers from the port into FAILED_FILE. */
function drainFailures(ns) {
  const port = ns.getPortHandle(CONTRACT_PORT);
  if (port.empty()) return;
  const failed = readFailed(ns);
  while (!port.empty()) failed.add(String(port.read()));
  writeFailed(ns, failed);
}
