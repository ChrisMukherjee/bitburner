// Removes files from home by folder prefix or all at once. Dry run unless --yes.
// Usage: run /tools/clean-home.js /tools/exploits/        (dry run, lists what would go)
//        run /tools/clean-home.js /tools/exploits/ --yes  (deletes)
//        run /tools/clean-home.js --all --yes             (everything except protected files)
// A name with an extension (e.g. /old.js) matches that one file; anything else is a folder prefix.
// Protected unless --include-data: everything under data/ (saved config and state). The script itself is always kept.

/** @param {NS} ns */
export async function main(ns) {
  const flags = ns.flags([
    ["all", false],
    ["yes", false],
    ["include-data", false],
  ]);
  const targets = flags._.map(String);
  if (!flags.all && targets.length === 0) {
    ns.tprint("Usage: run /tools/clean-home.js <folder/ or file> [more ...] [--yes]");
    ns.tprint("       run /tools/clean-home.js --all [--yes] [--include-data]");
    ns.tprint("Dry run by default: lists what would be deleted. Add --yes to delete.");
    ns.tprint("data/ is kept unless you pass --include-data.");
    return;
  }

  const self = stripSlash(ns.getScriptName());
  const matchers = targets.map(toMatcher);
  const all = ns.ls("home").map(stripSlash);

  const picked = [];
  let keptData = 0;
  for (const file of all) {
    if (file === self) continue;
    if (!flags.all && !matchers.some((m) => m(file))) continue;
    if (file.startsWith("data/") && !flags["include-data"]) {
      keptData++;
      continue;
    }
    picked.push(file);
  }

  if (picked.length === 0) {
    ns.tprint("Nothing to delete." + (keptData ? ` (${keptData} file(s) under data/ kept; add --include-data to remove them)` : ""));
    return;
  }

  picked.sort();
  const verb = flags.yes ? "Deleting" : "Would delete";
  ns.tprint(`${verb} ${picked.length} file(s):`);
  for (const file of picked) ns.tprint("  /" + file);
  if (keptData) ns.tprint(`Kept ${keptData} file(s) under data/ (add --include-data to remove them).`);

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
