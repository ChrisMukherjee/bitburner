// Design: docs/startup.md
import { readGates } from "/singularity/ready.js";

// pserv-manager.js posts { done: true } under this key on port 33 (the one-shot gates) once every
// purchased server is at the RAM limit and every slot is filled. startup.js clears the port when it
// starts (after each reset, on a new BitNode, or `run /startup.js --restart`), so the manager checks
// again once in every new run, when the servers are gone.
export const PSERV_GATE = "pserv";

/** For startup.js: false once pserv-manager.js has posted that the fleet is maxed this run. */
export function pservReady(ns) {
	return !readGates(ns)[PSERV_GATE]?.done;
}
