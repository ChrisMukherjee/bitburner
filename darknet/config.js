// Shared constants for the darknet scripts. No ns calls, so importing this costs no RAM.

/** Port crawlers send reports to; the manager on home reads it. */
export const REPORT_PORT = 20;

export const CRAWLER_SCRIPT = "darknet/crawler.js";
/** The dedicated phishing worker a crawler launches on each opened server, with as many threads as fit. */
export const PHISH_SCRIPT = "darknet/phish.js";
/** One-shot stasis-link script, run on a server to pin it and allow remote exec. Only with --stasis. */
export const STASIS_SCRIPT = "darknet/stasis.js";
/** Every file a crawler needs on the server it runs on. */
export const CRAWLER_FILES = [
	"darknet/crawler.js", "darknet/hint-interpreter.js", "darknet/config.js",
	"darknet/phish.js", "darknet/stasis.js", "darknet/feedback-solvers.js", "darknet/auth.js", "darknet/heartbleed.js",
];
/** Known passwords ({ host: password }), copied along with the crawler so it can re-open sessions. */
export const PASSWORD_FILE = "darknet/passwords.txt";

/** Hostnames the manager wants stasis-linked (top servers by RAM); crawlers read their copy to link self. */
export const STASIS_TARGET_FILE = "darknet/stasis-targets.txt";

// Files the manager keeps on home
export const MAP_FILE = "data/darknet-map.txt";
export const HOME_PASSWORD_FILE = "data/darknet-passwords.txt";
export const MODEL_SUMMARY_FILE = "data/darknet-models.txt";
