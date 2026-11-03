export const VAULT = "passwords.json";
export const FOUND = "vault_found.txt";
const DEFAULT_DICTIONARY = ["", "password", "admin", "102"];

/** Reads a vault-shaped JSON file from the CURRENT server (ns.read can't read other servers). */
export function loadVault(ns, file = VAULT) {
    let v = {};
    try {
        const raw = ns.read(file);
        if (raw && raw.trim() !== "") v = JSON.parse(raw);
    } catch (e) {}
    if (!v.servers) v.servers = {};
    if (!v.models) v.models = {};
    if (!v.dictionary) v.dictionary = [...DEFAULT_DICTIONARY];
    return v;
}

/** Saves a key locally: passwords.json so this node uses it now, vault_found.txt so home can collect it. */
export function recordKey(ns, hostname, key) {
    for (const file of [VAULT, FOUND]) {
        const v = loadVault(ns, file);
        v.servers[hostname] = key;
        if (!v.dictionary.includes(key)) v.dictionary.push(key);
        ns.write(file, JSON.stringify(v, null, 2), "w");
    }
}
