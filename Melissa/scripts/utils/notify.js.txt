/**
 * An important event: a line in the script log and a toast (all 0GB).
 * With terminal = true it also prints a terminal line, which is still there when you come back,
 * and the toast stays until you click it (FYI toasts clear after 15s). Use that only for things
 * you need to act on (a script that stopped, something to fix by hand); good news and FYI events
 * are toast only. Routine chatter belongs in ns.print alone.
 *   tag      - script prefix, e.g. "[programs]"
 *   variant  - "success", "info", "warning" or "error"
 */
export function notify(ns, tag, message, variant = "info", terminal = false) {
	const line = `${tag} ${message}`;
	ns.print(line);
	if (terminal) ns.tprint(line);
	ns.toast(line, variant, terminal ? null : 15_000); // null = sticky until clicked
}
