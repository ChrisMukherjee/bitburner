// Which server belongs to which stock's company, for steering prices with hack/grow { stock: true }.
// No ns calls, so importing this costs no RAM. WDS (Watchdog Security) has no server.

/** Port the trader posts { grow: [hosts], hack: [hosts] } on; workers/grow.js and hack.js peek it. */
export const STOCK_INFLUENCE_PORT = 21;

export const SYMBOL_SERVERS = {
	ECP: "ecorp", MGCP: "megacorp", BLD: "blade", CLRK: "clarkinc", OMTK: "omnitek", FSIG: "4sigma",
	KGI: "kuai-gong", FLCM: "fulcrumtech", STM: "stormtech", DCOMM: "defcomm", HLS: "helios",
	VITA: "vitalife", ICRS: "icarus", UNV: "univ-energy", AERO: "aerocorp", OMN: "omnia",
	SLRS: "solaris", GPH: "global-pharm", NVMD: "nova-med", LXO: "lexo-corp", RHOC: "rho-construction",
	APHE: "alpha-ent", SYSC: "syscore", CTK: "comptek", NTLK: "netlink", OMGA: "omega-net",
	FNS: "foodnstuff", JGN: "joesguns", SGC: "sigma-cosmetics", CTYS: "catalyst", MDYN: "microdyne",
	TITN: "titan-labs",
};
