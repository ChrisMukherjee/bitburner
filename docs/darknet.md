# Darknet

[`../darknet/dnet-manager.js`](../darknet/dnet-manager.js) (entry point, on home) seeds
[`crawler.js`](../darknet/crawler.js) onto darkweb; crawlers spread themselves server to server.
Passwords come from [`hint-interpreter.js`](../darknet/hint-interpreter.js),
[`model-solvers.js`](../darknet/model-solvers.js) and [`feedback-solvers.js`](../darknet/feedback-solvers.js); logins go
through [`auth.js`](../darknet/auth.js), and guesses whose reply matters through `loginReply` in
[`heartbleed.js`](../darknet/heartbleed.js).

## Decisions

- **Crawlers do the work, the manager collects.** A crawler runs on each opened server, reports what it
  sees on port 20, opens its neighbours and copies itself on. Crawlers only report when they start, so the
  manager restarts every known crawler (and phishing worker) on start, reloads the last map, and keeps
  re-checking; the darknet keeps moving servers, so crawlers re-probe their neighbours every minute.
- **Passwords from what the server tells us.** Per neighbour, in order: the server's logs (`heartbleed.js`: a login that
  worked, a passcode a model leaks, passwords known to be wrong, Mastermind replies), then the solvers read the answer
  from the hint, or narrow it down from the replies to wrong guesses (Factori-Os by prime factoring from "divisible"
  feedback within the hint's password length, starting from its "divisible by N" factor; DeepGreen as Mastermind (guesses only the reported length, picks a random remaining candidate so parallel crawlers differ, re-reads the log's earlier replies and "I can see a 8 and a 6" clues before every guess and keeps replies in `data/darknet-mastermind.txt`, so a restarted or second crawler continues instead of repeating); OpenWebAccessPoint returns a captured packet of ~125-145 characters with the password hidden in it on every wrong guess, so the runs of the right length and format common to the captures narrow to the password, usually after two guesses (a `host:password` marker on easy servers is tried at once); PHP 5.4 shows the real password with its characters sorted, so its candidates are the anagrams of Data, capped at 720; NIL (hint "you are one who's'nt authorized") replies "yes" or "yesn't" for each character sent, so a guess of one repeated character lists every position holding it: one guess per character of the set (10 digits, 62 with letters) gives the whole password, and positions that never say yes show the length when the details don't; AccountsManager_4.2 ("a number between 0 and N") is a plain integer of the reported length, so it tries each number in 10^(L-1)..10^L-1 once, skipping log-known wrong ones, and cuts the range when a reply says higher/lower), and last a few passwords that opened other servers. Blind guessing from fixed
  word lists is out of scope; those passwords can be entered by hand in `data/darknet-passwords.txt`. Other
  feedback-driven models can be added the same way. Logs are read with `peek`, so the lines stay on the server.
- **Every model with a rule gets a solver** ([`model-solvers.js`](../darknet/model-solvers.js), each rule copied from the game's
  `ServerGenerator.ts` and `authentication.ts`). From the hint alone: PrimeTime 2 (largest prime factor of the stated number),
  OrdoXenos (XOR each character of the masked text with its mask), 110100100 (binary character codes), MathML (the expression
  worked out with the game's own bracket-then-operator order, so the rounding matches; the symbol variants, the `ns.exit()`
  trap and injected code after a comma are handled as text, never evaluated), OctantVoxel (fractional bases and digits read
  the game's way), BellaCuore ("nulla" is 0), and EuroZone Free and TopPass (the game's own 27-country and 93-password lists,
  which the hint names, cut to the reported length and format: not a blind word list). From replies: BellaCuore's range form
  (binary search on "ALTUS NIMIS"/"PARUM BREVIS"), 2G_cellular (each wrong guess names the first mismatching position, so one
  pass of the character set per position) and BigMo%od (a guess n <= 32 replies password mod n, so the remainders for 32, 27, 25
  and the primes to 31 fix it modulo lcm(1..32), about 1.4e14, and the reported length leaves at most seven numbers).
  A harness that runs the game's own generators and reply code against these solvers opened every server it generated.
- **Read the reply to a wrong guess from the server's log.** `ns.dnet.authenticate` answers a wrong password with only
  "Unauthorized"; the model's reply (Mastermind counts, "divisible" true/false, NIL's yes/yesn't, a packet capture, a mismatch
  index, a remainder) is written to the server's log (`NetscriptFunctions/Darknet.ts` returns data only for labyrinth servers).
  So `loginReply` peeks at the newest log lines after each wrong guess and takes the entry for that guess. It costs a
  heartbleed per guess (about 1.5 times a login's time) and needs the charisma heartbleed asks for; without it the reply
  can't be read and the solver stops rather than guess blind. Before this the feedback solvers read the return value, saw
  nothing and stopped after one guess, so NIL, Factori-Os, DeepGreen and OpenWebAccessPoint stayed unsolved in game;
  their tests had faked a reply in the return value. Tests now use [`../tests/support/fake-darknet.mjs`](../tests/support/fake-darknet.mjs),
  which answers the way the game does.
- **Clue files.** Opening a cache or clearing a RAM block can drop `.data.txt` files on that server; some say
  `Server: <host> Password: "<pw>"` or `Remember this password: <pw>` (a neighbour's). The crawler reads its own server's files
  at every re-check and tries those passwords first (after the log's).
- **Not solved yet** (they stay unsolved and show in the manager's list): DeepGreen with letters or over 6 digits (the
  candidate list would be too big to hold), PHP 5.4 over 6 characters (only 720 anagrams are tried; its RMS-deviation reply
  is not used), RateMyPix.Auth and KingOfTheHill (Source-File 15 only), and the labyrinth servers.
- **Only a 401 means a wrong password.** `login` retries 408 timeouts (they happen even with the right
  password); anything else (moved, offline, too little charisma) means "try again on the next re-check",
  not "unsolvable". Skips are counted in the manager's summary so they stay visible.
- **Quiet by default.** The manager logs a summary every `darknetLog.logMinutes` and prints one to the terminal every `darknetLog.terminalMinutes` (0 = never), or at once when a stasis link fails.
- **Earning is on by default:** phishing, freeing blocked RAM and opening caches. Freeing RAM is slow
  (about 0.2GB per call), so crawlers keep doing it on their opened neighbours and top up phishing as RAM
  frees.
- **Stasis links go to the servers with the most usable RAM** (max RAM minus blocked), not the most max RAM:
  picking by max RAM chose mostly-blocked servers and never linked anything. Links move to better servers as
  they're found.
- **Push servers to move when mapping stalls (`--no-migrate` turns it off).** Parts of the darknet are cut off from the
  rest, and only a server that moves can carry a crawler across. When no new server has been mapped for 10 minutes, the
  manager lists up to two opened servers (crawler running, not stasis-linked, not stationary) in
  `darknet/migrate-targets.txt` and copies it to every opened server. A crawler next to a target stops phishing, runs
  [`migrate.js`](../darknet/migrate.js) on it with all its free RAM, and phishing resumes when the push ends. Pushes from
  several neighbours stack. The direction a server moves is random, so this is a gamble; any new server clears the list
  and restarts the timer, and a server that stayed put after 4 pushes in a row is left alone until the map grows.
  Timing lives in `MIGRATE` in [`darknet/config.js`](../darknet/config.js). On by default because it only starts once
  ordinary crawling has run dry; rejected: always pushing (it would cost phishing RAM and shuffle servers that are fine
  where they are). Not done: working out which servers sit next to a gap (the API doesn't say), so targets are picked by
  how long since they were last pushed.
- **Unleash STORM_SEED.exe when the darknet has run dry (on by default; `darknet.storm.enabled: false` turns it off).**
  The game puts one STORM_SEED.exe on a server at a time (15% chance whenever a server's blocked RAM is freed, at most every
  30 minutes). Running it, through `ns.dnet.unleashStormSeed()` on the server that holds it, deletes about 60% of the
  servers that are not stasis-linked or stationary, restarts the rest and generates many new ones. It earns nothing by itself;
  it re-rolls a map that has nothing left to offer. Crawlers report a seed when they see it ([`crawler.js`](../darknet/crawler.js)
  `syncStorm`); [`storm-rule.js`](../darknet/storm-rule.js) decides when, as a break-even comparison from live data
  rather than fixed thresholds. The manager samples income, blocked and usable RAM every 30 seconds. It waits if: no seed is
  known or the last storm was under 30 minutes ago (the game's own spawn rule); there is under 30 minutes of history;
  a server is still being cracked; blocked RAM is shrinking fast enough to clear within the hour (measured freeing rate,
  so income is still rising); or servers are still turning up (no discovery for 4x the usual gap, never under 10 minutes). Then
  it compares gain and loss. Possible income is the higher of this run's best 10-minute income and income per usable GB
  now times the peak usable RAM seen (the map may have shrunk). Gain is the missing income for an hour minus the time the map took
  to fill (measured from the discovery log). Loss is 60% of the income of the servers a storm can delete (not stasis-linked,
  not stationary, weighted by RAM) over half that fill time. Noisy income (coefficient of variation of one-minute rates)
  raises the bar: gain must beat loss by (1 + 2 x noise). Nothing depends on an income level, so a small or young darknet
  works the same, and it does not fire before it has history. Stasis-linked servers survive a storm, so linking the best servers
  limits the loss. The manager sends an order `{host, at}` in `darknet/storm-target.txt` to every opened server; only the
  crawler on that host acts, and orders older than 2 minutes are ignored. The status line shows a known seed and why it
  is waiting. Rejected: opt-in (the break-even check already refuses when a storm would not pay), fixed income or
  blocked-RAM thresholds, and firing as soon as a seed appears (it throws away working servers). Not done: reading the
  game's exact post-storm server count, which the API does not expose.
- **Never backdoor darknet servers.** Backdoors don't slow server movement. They only let `exec` skip the
  direct-connection check, while each one past two makes any login randomly time out more often and adds
  random restarts that kill our scripts.
- **The manager exits without DarkscapeNavigator.exe**, so it never idles holding RAM. startup.js only
  starts it once the program is owned ([`../darknet/ready.js`](../darknet/ready.js)); before that it kept
  restarting the manager, and each exit left a sticky toast. The exit message is now a normal toast plus a
  terminal line, since it only shows when the manager is run by hand.
- **One implementation, not two.** An earlier alternative design (`darkweb.js`/`scout.js`) was a different design (a scout script on every
  authenticated node, a shared password vault merged on home, `phish.js` filling free RAM). Compared by reading, this one does
  more (stasis links, earnings, restarts, 408 retries, the map), so it stayed the base. Three ideas were taken from the other
  design: the heartbleed log pass, the DeepGreen solver, and trying known passwords on servers whose hint gave nothing. Not
  taken: the controller on home, a blind list of default passwords, and its NIL solver (switched off in that code because
  the server never answered "yes": the reply is only in the server's log, which ours reads). The crawler is 0.6GB larger for the heartbleed call.
