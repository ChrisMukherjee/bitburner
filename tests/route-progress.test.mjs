// utils/route-progress.js: the BitNode progress block of tools/status.js (hacking route, Bladeburner route, which one is active).
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeNeeds, inviteAugs, hackingSegments, bladeburnerSegments, routeLines } from "/utils/route-progress.js";

const fmt = { number: (n) => String(Math.round(n * 10) / 10), time: (ms) => `${Math.round(ms / 1000)}s`, money: (n) => "$" + n };
const invite = [
	{ type: "numAugmentations", numAugmentations: 35 },
	{ type: "money", money: 100e9 },
	{ type: "someCondition", conditions: [{ type: "skills", skills: { hacking: 2500 } }, { type: "skills", skills: { strength: 1500, defense: 1500 } }] },
];
const hack = (extra = {}) => ({
	hacking: 587, installed: 32, have: { money: 2e9, installed: 32, skills: { hacking: 587, strength: 10, defense: 10 } },
	daedalusJoined: false, daedalusRep: 0, repPerSecond: 0, invite, redPill: { rep: 2.5e6, price: 5e9 },
	redPillInstalled: false, redPillBought: false, daemon: { exists: false, level: null, root: false }, ...extra,
});
const progress = (extra = {}) => ({
	done: 12, total: 21, rank: 9000, finalRank: 400000, time: Date.now(), next: { name: "Operation X", rank: 12000, chance: 0.8, high: 0.9 }, ...extra,
});

test("invite needs show what the player has against each requirement", () => {
	const text = describeNeeds(invite, hack().have, fmt);
	assert.match(text, /augs installed 32\/35/);
	assert.match(text, /cash \$2000000000\/\$100000000000/);
	assert.match(text, /hacking 587\/2500 or strength 10\/1500 \+ defense 10\/1500/);
	assert.equal(inviteAugs(invite), 35);
	assert.equal(inviteAugs(null), null);
});

test("hacking route: before Daedalus, the augs count, the Red Pill and the daemon each get a line", () => {
	const [daedalus, redPill, daemon] = hackingSegments(hack(), fmt);
	assert.match(daedalus.long, /^Daedalus not joined: invite needs augs installed 32\/35/);
	assert.equal(daedalus.short, "Daedalus not joined (augs 32/35)");
	assert.match(redPill.long, /The Red Pill not owned: needs 2500000 Daedalus rep/);
	assert.match(daemon.long, /shows once The Red Pill is installed/);
});

test("hacking route: joined Daedalus shows rep against the Red Pill with an ETA; the daemon level comes from the estimate", () => {
	const [daedalus, redPill, daemon] = hackingSegments(hack({ daedalusJoined: true, daedalusRep: 1e6, repPerSecond: 1000, daemon: { exists: false, level: 6000, root: false } }), fmt);
	assert.equal(daedalus.long, "Daedalus joined, 1000000 rep");
	assert.match(redPill.long, /Daedalus rep 1000000 \/ 2500000 .*ETA ~1500s/);
	assert.match(daemon.long, /hacking 587 \/ 6000 \(5413 to go\) \(it appears once The Red Pill is installed\)/);
});

test("hacking route: Red Pill installed, daemon present with and without root", () => {
	const installed = hackingSegments(hack({ redPillInstalled: true, hacking: 7000, daemon: { exists: true, level: 6000, root: false } }), fmt);
	assert.equal(installed[1].long, "The Red Pill installed");
	assert.match(installed[2].long, /\(ready\) \| root no/);
	assert.equal(hackingSegments(hack({ redPillBought: true }), fmt)[1].short, "The Red Pill bought");
});

test("hacking route without invite or Red Pill data says so instead of guessing", () => {
	const [daedalus, redPill] = hackingSegments(hack({ invite: null, redPill: null }), fmt);
	assert.match(daedalus.long, /aren't known yet/);
	assert.equal(daedalus.short, "Daedalus not joined");
	assert.equal(redPill.short, "The Red Pill not owned");
});

test("Bladeburner route: Black Ops done/total, rank against the last one, the next Black Op and its chance", () => {
	const [main, next] = bladeburnerSegments({ state: "run", progress: progress(), hold: false, ago: () => "1 min ago" }, fmt);
	assert.match(main.long, /Black Ops 12\/21 done \| rank 9000\/400000 for Operation Daedalus \(not done\)/);
	assert.match(next.long, /next: Operation X \(rank 9000\/12000, chance 80-90%\)/);
	const done = bladeburnerSegments({ state: "run", progress: progress({ done: 21, next: null }), hold: false, ago: () => "" }, fmt);
	assert.match(done[0].long, /Black Ops 21\/21 done: every one is done/);
});

test("Bladeburner route: hold, stale reading and no reading yet", () => {
	const held = bladeburnerSegments({ state: "hold", progress: progress({ rank: 20000 }), hold: true, ago: () => "" }, fmt);
	assert.match(held[0].long, /on hold/);
	assert.match(held[1].long, /rank ok/);
	const stale = bladeburnerSegments({ state: "run", progress: progress({ time: Date.now() - 3600_000 }), hold: false, ago: () => "1 h ago" }, fmt);
	assert.match(stale[0].long, /last reading 1 h ago/);
	assert.match(bladeburnerSegments({ state: "off", progress: null, hold: false, ago: () => "" }, fmt)[0].long, /not running yet/);
	assert.match(bladeburnerSegments({ state: "train", progress: null, hold: false, ago: () => "" }, fmt)[0].long, /state train/);
});

test("routeLines: the active route is spelled out, the other is one line", () => {
	const hacking = hackingSegments(hack(), fmt);
	const bladeburner = bladeburnerSegments({ state: "run", progress: progress(), hold: false, ago: () => "" }, fmt);
	const combat = routeLines({ route: "combat", routeAgo: " (est.)", hacking, bladeburner }).join("\n");
	assert.match(combat, /Route: Bladeburner \(est\.\)/);
	assert.match(combat, /Black Ops 12\/21 done/);
	assert.match(combat, /Other route, hacking: Daedalus not joined \(augs 32\/35\) \| The Red Pill not owned/);
	assert.doesNotMatch(combat, /invite needs/);
	const hackingActive = routeLines({ route: "hacking", routeAgo: "", hacking, bladeburner }).join("\n");
	assert.match(hackingActive, /invite needs augs installed 32\/35/);
	assert.match(hackingActive, /Other route, Bladeburner: Black Ops 12\/21, rank 9000\/400000/);
});

test("routeLines: no verdict yet shows both in full; no Bladeburner shows only the hacking lines", () => {
	const hacking = hackingSegments(hack(), fmt);
	const bladeburner = bladeburnerSegments({ state: "run", progress: progress(), hold: false, ago: () => "" }, fmt);
	const both = routeLines({ route: null, routeAgo: "", hacking, bladeburner }).join("\n");
	assert.match(both, /Route: not chosen yet/);
	assert.match(both, /invite needs/);
	assert.match(both, /Black Ops 12\/21 done/);
	const only = routeLines({ route: "hacking", routeAgo: "", hacking, bladeburner: null });
	assert.equal(only.length, 3);
	assert.ok(only.every((line) => !/Route|Black Op/.test(line)));
});
