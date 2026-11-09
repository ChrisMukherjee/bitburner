// @ts-check
// Shared constants for the darknet scripts. No ns calls, so importing this costs no RAM.

/** Port crawlers send reports to; the manager on home reads it. */
export const REPORT_PORT = 20;

export const CRAWLER_SCRIPT = "darknet/crawler.js";
/** The dedicated phishing worker a crawler launches on each opened server, with as many threads as fit. */
export const PHISH_SCRIPT = "darknet/phish.js";
/** One-shot stasis-link script, run on a server to pin it and allow remote exec. Only with --stasis. */
export const STASIS_SCRIPT = "darknet/stasis.js";
/** Worker that pushes one neighbour until it moves (induceServerMigration). Started by crawlers when the map stalls. */
export const MIGRATE_SCRIPT = "darknet/migrate.js";
/** Hostnames the manager wants pushed to move; crawlers next to one run the migrate worker on it. */
export const MIGRATE_TARGET_FILE = "darknet/migrate-targets.txt";
/** Migration timing. Pushing is for reaching air-gapped parts of the darknet, so it only starts when mapping has stalled. */
export const MIGRATE = {
	stallMs: 10 * 60 * 1000, // no new server mapped for this long: start pushing
	maxTargets: 2, // servers pushed at once
	pushMs: 3 * 60 * 1000, // one worker gives up on its target after this long
	retryMs: 2 * 60 * 1000, // a crawler waits this long before pushing the same target again
	cooldownMs: 15 * 60 * 1000, // the manager leaves a server alone this long after it was pushed
	giveUpAfter: 4, // pushes in a row that did not move a server before it is left alone until the map grows
};
/** Program in the darknet that scrambles the whole network when run (ns.dnet.unleashStormSeed). */
export const STORM_PROGRAM = "STORM_SEED.exe";
/** The manager's order to unleash the seed: { host, at }. Only the crawler on `host` acts on it. */
export const STORM_TARGET_FILE = "darknet/storm-target.txt";
/**
 * Storm rule inputs (see storm-rule.js). The decision itself is a break-even comparison from live data; these are the
 * game's own rules (a new seed spawns at most every 30 minutes, a storm deletes about 60% of movable servers) and
 * measurement windows, so nothing here depends on how much a player earns.
 */
export const STORM = {
	cooldownMs: 30 * 60 * 1000, // after a storm we fired
	minHistoryMs: 30 * 60 * 1000, // income history needed before judging at all
	minSamples: 20,
	historyMs: 3 * 60 * 60 * 1000, // how far back "best income" looks
	rateWindowMs: 10 * 60 * 1000, // averaging window for "current" and "best" income
	stallFloorMs: 10 * 60 * 1000, // no discovery for at least this long
	stallGapFactor: 4, // ... and for this many times the usual gap between discoveries
	gapSamples: 30, // recent gaps used for the usual gap
	rampMinMs: 5 * 60 * 1000, // bounds on the estimated time to refill the map
	rampMaxMs: 60 * 60 * 1000,
	horizonMs: 60 * 60 * 1000, // how long an income recovery is counted
	deleteShare: 0.6, // the game deletes about this share of movable servers
	sampleMs: 30 * 1000, // manager samples income this often
};
/** Every file a crawler needs on the server it runs on. */
export const CRAWLER_FILES = [
	"darknet/crawler.js", "darknet/hint-interpreter.js", "darknet/config.js",
	"darknet/phish.js", "darknet/stasis.js", "darknet/feedback-solvers.js", "darknet/auth.js", "darknet/heartbleed.js",
	"darknet/migrate.js",
];
/** Known passwords ({ host: password }), copied along with the crawler so it can re-open sessions. */
export const PASSWORD_FILE = "darknet/passwords.txt";

/** Hostnames the manager wants stasis-linked (top servers by RAM); crawlers read their copy to link self. */
export const STASIS_TARGET_FILE = "darknet/stasis-targets.txt";

// Files the manager keeps on home
export const MAP_FILE = "data/darknet-map.txt";
export const HOME_PASSWORD_FILE = "data/darknet-passwords.txt";
export const MODEL_SUMMARY_FILE = "data/darknet-models.txt";
