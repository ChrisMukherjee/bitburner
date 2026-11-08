// A stand-in for the game's `ns` object, just big enough for the logic under test.
//
//   const ns = fakeNs({ files: { "data/config.json": "{...}" }, ports: { 36: {...} }, money: 1e9 });
//   ns.singularity.gymWorkout(...)   // recorded in ns.calls
//
// - Files (ns.read / ns.write) and ports (ns.peek / ns.writePort / ns.clearPort) live in plain objects.
//   A port given as an object is stored as its JSON, like the scripts post it.
// - Every function call is recorded in ns.calls as { name, args } ("singularity.gymWorkout"), and
//   ns.called(name) lists the args of each call to one function.
// - print / tprint / toast lines go to ns.logs, ns.terminal and ns.toasts.
// - Anything else a test needs goes in `overrides` (merged in, nested objects such as `singularity` too).
// - Reading an ns function that the fake doesn't have throws, so a test never passes by accident
//   because the code under test got `undefined` back.

/**
 * @param {object} [options]
 * @param {Record<string, string>} [options.files]  file name -> text
 * @param {Record<number, any>} [options.ports]     port -> data (objects are stored as JSON)
 * @param {number} [options.money]                  cash on home
 * @param {Record<string, any>} [options.overrides] extra or replacement ns members
 */
export function fakeNs({ files = {}, ports = {}, money = 0, overrides = {} } = {}) {
	const calls = [];
	const store = { ...files };
	const portData = {};
	for (const [port, data] of Object.entries(ports)) portData[port] = typeof data === "string" ? data : JSON.stringify(data);

	const base = {
		read: (file) => store[file] ?? "",
		write: (file, data = "", mode = "a") => { store[file] = mode === "w" ? String(data) : (store[file] ?? "") + data; },
		fileExists: (file) => file in store,
		peek: (port) => portData[port] ?? "NULL PORT DATA",
		writePort: (port, data) => { portData[port] = typeof data === "string" ? data : JSON.stringify(data); return null; },
		clearPort: (port) => { delete portData[port]; },
		getServerMoneyAvailable: (host) => (host === "home" ? money : 0),
		print: (line) => { logs.push(String(line)); },
		tprint: (line) => { terminal.push(String(line)); },
		toast: (line) => { toasts.push(String(line)); },
		disableLog: () => {},
		format: {
			number: (value) => formatNumber(value),
			time: (ms) => `${Math.round(ms / 1000)}s`,
			ram: (gb) => `${gb}GB`,
		},
		singularity: {},
	};
	const logs = [];
	const terminal = [];
	const toasts = [];
	const merged = mergeDeep(base, overrides);
	const recorded = record(merged, "", calls);
	Object.assign(recorded, {
		calls, logs, terminal, toasts, files: store, ports: portData,
		/** Args of every call to `name` ("singularity.travelToCity"). */
		called: (name) => calls.filter((call) => call.name === name).map((call) => call.args),
		/** A port's data parsed from JSON (null when empty). */
		portJson: (port) => (port in portData ? JSON.parse(portData[port]) : null),
	});
	return strict(recorded, "ns");
}

/** Short money-style numbers ("1.5m"), close enough for log lines in tests. */
function formatNumber(value) {
	const units = [[1e12, "t"], [1e9, "b"], [1e6, "m"], [1e3, "k"]];
	for (const [size, unit] of units) if (Math.abs(value) >= size) return `${(value / size).toFixed(2)}${unit}`;
	return Number(value).toFixed(2);
}

function mergeDeep(base, extra) {
	const out = { ...base };
	for (const [key, value] of Object.entries(extra ?? {})) {
		out[key] = value && typeof value === "object" && !Array.isArray(value) && typeof out[key] === "object"
			? mergeDeep(out[key], value) : value;
	}
	return out;
}

/** Wraps every function (nested too) so each call lands in `calls`. */
function record(target, prefix, calls) {
	const out = {};
	for (const [key, value] of Object.entries(target)) {
		const name = prefix ? `${prefix}.${key}` : key;
		if (typeof value === "function") {
			out[key] = (...args) => {
				calls.push({ name, args });
				return value(...args);
			};
		} else if (value && typeof value === "object" && !Array.isArray(value)) {
			out[key] = strict(record(value, name, calls), name);
		} else {
			out[key] = value;
		}
	}
	return out;
}

/** Throws on a missing member, naming it, instead of quietly returning undefined. */
function strict(target, name) {
	return new Proxy(target, {
		get(object, key) {
			if (typeof key === "symbol" || key === "then" || key === "toJSON" || key in object) return object[key];
			throw new Error(`fake ns: ${name}.${String(key)} is not set up; pass it in overrides`);
		},
	});
}
