// Removes files from home by folder prefix or all at once. Dry run unless --yes.
// Usage: run /tools/clean-home.js /tools/exploits/        (dry run, lists what would go)
//        run /tools/clean-home.js /tools/exploits/ --yes  (deletes)
//        run /tools/clean-home.js --all --yes             (everything except protected files)
// A name with an extension (e.g. /old.js) matches that one file; anything else is a folder prefix.
// Kept unless you pass a flag:
//   data/ (saved config and state)            --include-data
//   .txt .lit .msg .exe files                 --include-misc
//   /startup.js, only when using --all        --include-startup
// The script itself is always kept.

/** @param {NS} ns */
export async function main(ns) {
  const flags = ns.flags([
    ["all", false],
    ["yes", false],
    ["include-data", false],
    ["include-misc", false],
    ["include-startup", false],
  ]);
  const targets = flags._.map(String);
  if (!flags.all && targets.length === 0) {
    ns.tprint("Usage: run /tools/clean-home.js <folder/ or file> [more ...] [--yes]");
    ns.tprint("       run /tools/clean-home.js --all [--yes] [--include-data]");
    ns.tprint("Dry run by default: lists what would be deleted. Add --yes to delete.");
    ns.tprint("Kept unless you pass the flag: data/ (--include-data), .txt .lit .msg .exe files (--include-misc),");
    ns.tprint("and startup.js when using --all (--include-startup).");
    return;
  }

  const self = stripSlash(ns.getScriptName());
  const matchers = targets.map(toMatcher);
  const all = ns.ls("home").map(stripSlash);

  const picked = [];
  const reportKept = () => {
    if (keptData) ns.tprint(`Kept ${keptData} file(s) under data/ (--include-data removes them).`);
    if (keptMisc) ns.tprint(`Kept ${keptMisc} .txt/.lit/.msg/.exe file(s) (--include-misc removes them).`);
    if (keptStartup) ns.tprint("Kept /startup.js (--include-startup removes it).");
  };
  let keptData = 0;
  let keptMisc = 0;
  let keptStartup = 0;
  for (const file of all) {
    if (file === self) continue;
    if (!flags.all && !matchers.some((m) => m(file))) continue;
    if (file.startsWith("data/") && !flags["include-data"]) {
      keptData++;
      continue;
    }
    if (MISC.test(file) && !flags["include-misc"]) {
      keptMisc++;
      continue;
    }
    if (flags.all && file === "startup.js" && !flags["include-startup"]) {
      keptStartup++;
      continue;
    }
    picked.push(file);
  }

  if (picked.length === 0) {
    ns.tprint("Nothing to delete.");
    reportKept();
    return;
  }

  picked.sort();
  const verb = flags.yes ? "Deleting" : "Would delete";
  ns.tprint(`${verb} ${picked.length} file(s):`);
  for (const file of picked) ns.tprint("  /" + file);
  reportKept();

  if (!flags.yes) {
    ns.tprint("Dry run only. Run again with --yes to delete.");
    return;
  }

  let removed = 0;
  const failed = [];
  for (const file of picked) {
    if (ns.rm("/" + file, "home")) removed++;
    else failed.push(file);
  }
  ns.tprint(`Removed ${removed} of ${picked.length} file(s).`);
  if (failed.length) {
    ns.tprint("Could not remove (a running script?): " + failed.map((f) => "/" + f).join(", "));
  }
}

const MISC = /\.(txt|lit|msg|exe)$/i;

function stripSlash(path) {
  return path.replace(/^\/+/, "");
}

// A name with an extension is one file; otherwise a folder prefix.
function toMatcher(target) {
  const clean = stripSlash(target);
  if (/\.[A-Za-z0-9]+$/.test(clean)) return (file) => file === clean;
  const folder = clean.endsWith("/") ? clean : clean + "/";
  return (file) => file.startsWith(folder);
}
