// @ts-check
/**
 * For startup.js: true when darknet/dnet-manager.js can run, i.e. DarkscapeNavigator.exe is on home.
 * Without it the manager exits at once, so startup.js would keep restarting it for nothing.
 */
/** @param {NS} ns */
export function dnetReady(ns) {
	return ns.fileExists("DarkscapeNavigator.exe", "home");
}
